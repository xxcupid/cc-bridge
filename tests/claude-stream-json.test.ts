import { describe, expect, it } from 'vitest';
import { translateClaudeEvent } from '../src/agents/claude/stream-json.js';

describe('translateClaudeEvent', () => {
  it('translates session initialization', () => {
    expect(translateClaudeEvent({ type: 'system', subtype: 'init', session_id: 'abc' })).toEqual([
      { type: 'session.started', nativeSessionId: 'abc' },
    ]);
  });

  it('translates text, thinking, and tool calls', () => {
    expect(translateClaudeEvent({ type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'plan' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'a.ts' } },
    ] } })).toEqual([
      { type: 'thinking.delta', text: 'plan' },
      { type: 'text.delta', text: 'answer' },
      { type: 'tool.started', toolCallId: 't1', name: 'Read', input: { file: 'a.ts' } },
    ]);
  });

  it('captures the latest root assistant context usage without counting subagent messages', () => {
    expect(translateClaudeEvent({ type: 'assistant', parent_tool_use_id: null, message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 800, cache_creation_input_tokens: 80 },
      content: [{ type: 'text', text: 'answer' }],
    } })).toEqual([
      { type: 'text.delta', text: 'answer' },
      { type: 'metrics.updated', metrics: { model: 'claude-sonnet-4-6', totalTokens: 1_000 } },
    ]);
    expect(translateClaudeEvent({ type: 'assistant', parent_tool_use_id: 'subagent', message: {
      model: 'claude-haiku', usage: { input_tokens: 10 }, content: [],
    } })).toEqual([]);
  });

  it('translates successful and failed results', () => {
    expect(translateClaudeEvent({ type: 'result', session_id: 'abc' })).toEqual([
      { type: 'run.completed', nativeSessionId: 'abc', metrics: {} },
    ]);
    expect(translateClaudeEvent({ type: 'result', session_id: 'abc', usage: { input_tokens: 71, output_tokens: 161, cache_read_input_tokens: 40000 }, modelUsage: { 'claude-opus': { contextWindow: 1_000_000 } } })[0]).toMatchObject({ metrics: { model: 'claude-opus', inputTokens: 71, outputTokens: 161, cacheReadTokens: 40000, contextTokens: 1_000_000 } });
    expect(translateClaudeEvent({ type: 'result', session_id: 'legacy', model_usage: { 'legacy-model': { context_window: 200_000 } } })[0]).toMatchObject({ metrics: { model: 'legacy-model', contextTokens: 200_000 } });
    expect(translateClaudeEvent({ type: 'result', is_error: true, result: 'bad' })).toEqual([
      { type: 'run.failed', message: 'bad' },
    ]);
  });

  it('translates permission and AskUserQuestion control requests', () => {
    expect(translateClaudeEvent({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' } } })).toEqual([
      { type: 'approval.requested', requestId: 'p1', action: 'Bash', access: 'full', details: { command: 'npm test' } },
    ]);
    expect(translateClaudeEvent({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions: [{ question: '选择？', options: [{ label: 'A' }, { label: 'B' }] }] } } })).toEqual([
      { type: 'question.requested', questionId: 'q1', prompt: '选择？', options: ['A', 'B'] },
    ]);
  });
});
