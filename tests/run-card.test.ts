import { describe, expect, it } from 'vitest';
import { RunCardState } from '../src/presentation/run-card.js';

describe('RunCardState', () => {
  it('accumulates stream events and renders terminal state', () => {
    const state = new RunCardState('run-1', 'scope-1', 1_000);
    state.apply({ type: 'thinking.delta', text: 'plan' });
    state.apply({ type: 'tool.started', toolCallId: 't1', name: 'Read' });
    state.apply({ type: 'text.delta', text: 'hello' });
    state.apply({ type: 'text.delta', text: ' world' });
    state.apply({ type: 'run.completed' });
    const card = JSON.stringify(state.render(4_000));
    expect(card).toContain('hello world');
    expect(card).toContain('已完成 · 耗时 3.0s');
    expect(card).toContain('"tag":"collapsible_panel"');
    expect(card).toContain('查看 1 个步骤');
    expect(card).toContain('file-link-text_outlined');
    expect(card).not.toContain('Oscar Coding Agent');
    expect(card).toContain('"text_size":"notation"');
    expect(card).not.toContain('"tag":"note"');
    expect(card).not.toContain('"tag":"action"');
    expect(card).not.toContain('"action":"stop"');
  });
  it('uses CardKit 2.0 callback buttons for approvals and choices', () => {
    const approval = new RunCardState('r', 's');
    approval.apply({ type: 'approval.requested', requestId: 'raw', token: 'opaque', action: 'run command', access: 'workspace', details: { command: 'npm test' } });
    const approvalCard = JSON.stringify(approval.render());
    expect(approvalCard).not.toContain('"tag":"action"');
    expect(approvalCard).toContain('"tag":"column_set"');
    expect(approvalCard).toContain('"behaviors":[{"type":"callback"');
    expect(approvalCard).toContain('需要授权');
    expect(approvalCard).toContain('run command');
    expect(approvalCard).toContain('当前工作区');
    expect(approvalCard).toContain('npm test');
    expect(approvalCard).not.toContain('"requestId":"raw"');

    const question = new RunCardState('r', 's');
    question.apply({ type: 'question.requested', questionId: 'raw', token: 'opaque', prompt: 'Pick', options: ['A', 'B'] });
    const questionCard = JSON.stringify(question.render());
    expect(questionCard).not.toContain('"tag":"action"');
    expect(questionCard).toContain('需要你的回答');
    expect(questionCard).toContain('Pick');
  });
  it('renders complete OpenClaw-style runtime metrics and preserves pending interactions', () => {
    const state = new RunCardState('r', 's', 1_000);
    state.apply({ type: 'approval.requested', requestId: 'request', token: 'opaque', action: 'Bash', access: 'workspace' });
    state.apply({ type: 'metrics.updated', metrics: { model: 'zhipu/glm-5.3', totalTokens: 246_000 } });
    expect(state.status).toBe('waiting');
    expect(state.pending).toMatchObject({ kind: 'approval', id: 'opaque' });
    state.apply({ type: 'run.completed', metrics: { inputTokens: 244_000, outputTokens: 3_500, cacheReadTokens: 246_000, cacheWriteTokens: 0, contextTokens: 1_048_576 } });
    const card = JSON.stringify(state.render(200_000));
    expect(card).toContain('已完成 · 耗时 3m 19s · zhipu/glm-5.3');
    expect(card).toContain('↑ 244k ↓ 3.5k · 缓存 246k/0 (50%) · 上下文 246k/1.0m (23%)');
  });
  it('renders compact Skill and Terminal summaries without successful output', () => {
    const state = new RunCardState('r', 's');
    state.apply({ type: 'tool.started', toolCallId: 'skill', name: 'Skill', input: { skill: 'lark-drive' } });
    state.apply({ type: 'tool.completed', toolCallId: 'skill', output: 'Launching skill: lark-drive', isError: false });
    state.apply({ type: 'tool.started', toolCallId: 'terminal', name: 'Terminal', input: { command: 'agent-browser open https://example.com' } });
    state.apply({ type: 'tool.completed', toolCallId: 'terminal', output: 'Page opened', isError: false });
    const card = JSON.stringify(state.render());
    expect(card).toContain('Load skill');
    expect(card).toContain('lark-drive');
    expect(card).toContain('Run command');
    expect(card).toContain('agent-browser open https://example.com');
    expect(card).not.toContain('Launching skill: lark-drive');
    expect(card).not.toContain('Page opened');
  });
  it('prefers the concrete command over a human-readable description', () => {
    const state = new RunCardState('r', 's');
    state.apply({ type: 'tool.started', toolCallId: 'terminal', name: 'Terminal', input: { description: '读取飞书文档内容', command: 'lark-cli docs +fetch --doc token' } });
    state.apply({ type: 'tool.completed', toolCallId: 'terminal', output: 'done', isError: false });
    const card = JSON.stringify(state.render());
    expect(card).toContain('lark-cli docs +fetch --doc token');
    expect(card).not.toContain('读取飞书文档内容');
  });
  it('hides successful output but preserves a bounded failed-tool diagnostic', () => {
    const state = new RunCardState('r', 's');
    state.apply({ type: 'tool.started', toolCallId: 'ok', name: 'Bash', input: { command: 'pwd' } });
    state.apply({ type: 'tool.completed', toolCallId: 'ok', output: 'successful secret output', isError: false });
    state.apply({ type: 'tool.started', toolCallId: 'failed', name: 'Bash', input: { command: 'false' } });
    state.apply({ type: 'tool.completed', toolCallId: 'failed', output: `command failed\n${'x'.repeat(2_500)}`, isError: true });
    const card = JSON.stringify(state.render());
    expect(card).not.toContain('successful secret output');
    expect(card).toContain('错误详情');
    expect(card).toContain('command failed');
    expect(card).not.toContain('x'.repeat(2_001));
  });
  it('keeps stop available as a lightweight command hint without a button', () => {
    const card = JSON.stringify(new RunCardState('r', 's').render());
    expect(card).toContain('发送 `/stop` 可停止');
    expect(card).not.toContain('"action":"stop"');
  });
  it('renders a form for free-text agent questions without leaking the request id', () => {
    const state = new RunCardState('r', 's');
    state.apply({ type: 'question.requested', questionId: 'raw-secret', token: 'opaque-token', prompt: 'Which path?' });
    const card = JSON.stringify(state.render());
    expect(card).toContain('form_action_type');
    expect(card).toContain('Which path?');
    expect(card).toContain('opaque-token');
    expect(card).toContain('agent_question_submit_opaque-token');
    expect(card).not.toContain('raw-secret');
    state.apply({ type: 'text.delta', text: 'continued' });
    expect(JSON.stringify(state.render())).not.toContain('agent_question_form');
  });
});
