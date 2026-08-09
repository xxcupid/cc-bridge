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

  it('translates successful and failed results', () => {
    expect(translateClaudeEvent({ type: 'result', session_id: 'abc' })).toEqual([
      { type: 'run.completed', nativeSessionId: 'abc', metrics: {} },
    ]);
    expect(translateClaudeEvent({ type: 'result', session_id: 'abc', usage: { input_tokens: 71, output_tokens: 161, cache_read_input_tokens: 40000 }, model_usage: { 'claude-opus': {} } })[0]).toMatchObject({ metrics: { model: 'claude-opus', inputTokens: 71, outputTokens: 161, cacheReadTokens: 40000 } });
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
