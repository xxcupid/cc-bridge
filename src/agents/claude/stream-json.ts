/**
 * Portions of the Claude stream event shape were adapted from
 * zarazhangrui/lark-coding-agent-bridge (MIT License), commit
 * e5d3ce57ca95212cfa53965a6f2cc2d998aa691c.
 * Copyright (c) 2026 Lark Channel Bridge contributors.
 * See LICENSES/lark-coding-agent-bridge-MIT.txt and THIRD_PARTY_NOTICES.md.
 */
import type { AgentEvent } from '../../domain/agent.js';

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeModelUsage {
  contextWindow?: number;
  context_window?: number;
}

interface ClaudeEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  message?: { content?: ContentBlock[]; model?: string; usage?: ClaudeUsage };
  parent_tool_use_id?: string | null;
  request_id?: string;
  request?: { subtype?: string; tool_name?: string; input?: Record<string, unknown> };
  usage?: ClaudeUsage;
  modelUsage?: Record<string, ClaudeModelUsage>;
  model_usage?: Record<string, ClaudeModelUsage>;
}

export function translateClaudeEvent(raw: unknown): AgentEvent[] {
  if (!raw || typeof raw !== 'object') return [];
  const event = raw as ClaudeEvent;

  if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
    return [{ type: 'session.started', nativeSessionId: event.session_id }];
  }

  if (event.type === 'assistant') {
    const translated = (event.message?.content ?? []).flatMap((block): AgentEvent[] => {
      if (block.type === 'text' && block.text) return [{ type: 'text.delta', text: block.text }];
      if (block.type === 'thinking' && block.thinking) {
        return [{ type: 'thinking.delta', text: block.thinking }];
      }
      if (block.type === 'tool_use' && block.id && block.name) {
        return [{ type: 'tool.started', toolCallId: block.id, name: block.name, input: block.input }];
      }
      return [];
    });
    if (!event.parent_tool_use_id && event.message?.usage) {
      const usage = event.message.usage;
      const totalTokens = sumDefined(usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens);
      translated.push({ type: 'metrics.updated', metrics: {
        ...(event.message.model ? { model: event.message.model } : {}),
        ...(totalTokens != null ? { totalTokens } : {}),
      } });
    }
    return translated;
  }

  if (event.type === 'user') {
    return (event.message?.content ?? []).flatMap((block): AgentEvent[] => {
      if (block.type !== 'tool_result' || !block.tool_use_id) return [];
      return [{
        type: 'tool.completed',
        toolCallId: block.tool_use_id,
        output: block.content,
        isError: block.is_error === true,
      }];
    });
  }

  if (event.type === 'result') {
    if (event.is_error) {
      return [{ type: 'run.failed', message: event.result ?? 'Claude Code returned an error result' }];
    }
    const modelUsage = event.modelUsage ?? event.model_usage;
    const modelEntry = modelUsage ? Object.entries(modelUsage)[0] : undefined;
    const model = modelEntry?.[0];
    const contextWindow = number(modelEntry?.[1]?.contextWindow) ?? number(modelEntry?.[1]?.context_window);
    const usage = event.usage;
    return [{ type: 'run.completed', nativeSessionId: event.session_id, metrics: {
      ...(model ? { model } : {}),
      ...(usage?.input_tokens != null ? { inputTokens: usage.input_tokens } : {}),
      ...(usage?.output_tokens != null ? { outputTokens: usage.output_tokens } : {}),
      ...(usage?.cache_read_input_tokens != null ? { cacheReadTokens: usage.cache_read_input_tokens } : {}),
      ...(usage?.cache_creation_input_tokens != null ? { cacheWriteTokens: usage.cache_creation_input_tokens } : {}),
      ...(contextWindow != null ? { contextTokens: contextWindow } : {}),
    } }];
  }

  if (event.type === 'control_request' && event.request_id && event.request?.subtype === 'can_use_tool') {
    const tool = event.request.tool_name ?? 'UnknownTool';
    const input = event.request.input ?? {};
    if (tool === 'AskUserQuestion') {
      const question = firstQuestion(input);
      return [{ type: 'question.requested', questionId: event.request_id, prompt: question.prompt, ...(question.options.length ? { options: question.options } : {}) }];
    }
    return [{ type: 'approval.requested', requestId: event.request_id, action: tool, access: claudeToolAccess(tool), details: input }];
  }

  return [];
}

function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function sumDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return present.length ? present.reduce((total, value) => total + Math.max(0, value), 0) : undefined;
}

export function claudeToolAccess(tool: string): 'read-only' | 'workspace' | 'full' {
  if (['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'].includes(tool)) return 'read-only';
  if (['Edit', 'Write', 'NotebookEdit', 'MultiEdit'].includes(tool)) return 'workspace';
  return 'full';
}

function firstQuestion(input: Record<string, unknown>): { prompt: string; options: string[] } {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const first = questions[0];
  if (!first || typeof first !== 'object') return { prompt: '请输入你的回答', options: [] };
  const record = first as Record<string, unknown>;
  const options = Array.isArray(record.options) ? record.options.flatMap((option) => {
    if (typeof option === 'string') return [option];
    if (option && typeof option === 'object' && typeof (option as Record<string, unknown>).label === 'string') return [(option as Record<string, unknown>).label as string];
    return [];
  }) : [];
  return { prompt: typeof record.question === 'string' ? record.question : '请输入你的回答', options };
}
