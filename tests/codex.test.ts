import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../src/agents/codex/argv.js';
import { CodexJsonlTranslator } from '../src/agents/codex/jsonl.js';

const request = { runId: 'r', sessionId: 's', prompt: 'p', cwd: '/repo', permission: { mode: 'yolo' as const, maxAccess: 'workspace' as const } };

describe('Codex adapter protocol', () => {
  it('builds exec --json with sandbox and resume', () => {
    expect(buildCodexArgs(request)).toEqual(expect.arrayContaining(['exec', '--json', '--sandbox', 'workspace-write']));
    expect(buildCodexArgs({ ...request, resumeId: 'thread-1' })).toEqual(expect.arrayContaining(['resume', '--json', 'thread-1', '-']));
  });
  it('translates thread, command and terminal events', () => {
    const translator = new CodexJsonlTranslator();
    expect(translator.translate({ type: 'thread.started', thread_id: 't1' })).toEqual([{ type: 'session.started', nativeSessionId: 't1' }]);
    expect(translator.translate({ type: 'item.started', item: { type: 'command_execution', id: 'c1', command: 'pwd' } })).toEqual([
      { type: 'tool.started', toolCallId: 'c1', name: 'command_execution', input: { command: 'pwd' } },
    ]);
    translator.translate({ type: 'agent_message', message: 'done' });
    expect(translator.translate({ type: 'turn.completed' })).toEqual([
      { type: 'text.delta', text: 'done' }, { type: 'run.completed', nativeSessionId: 't1' },
    ]);
  });
});
