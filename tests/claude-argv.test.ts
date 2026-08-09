import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/agents/claude/argv.js';
import type { AgentRunRequest } from '../src/domain/agent.js';

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    runId: 'run-1', sessionId: 'session-1', prompt: 'hello', cwd: '/repo',
    permission: { mode: 'default', maxAccess: 'workspace' }, ...overrides,
  };
}

describe('buildClaudeArgs', () => {
  it('uses stream-json and default permission mode', () => {
    const args = buildClaudeArgs(request());
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']));
    expect(args).not.toContain('--permission-mode');
  });

  it('maps yolo workspace access to acceptEdits', () => {
    expect(buildClaudeArgs(request({ permission: { mode: 'yolo', maxAccess: 'workspace' } }))).toEqual(expect.arrayContaining(['--permission-mode', 'acceptEdits']));
  });

  it('adds resume and model only when present', () => {
    const args = buildClaudeArgs(request({ resumeId: 'native-1', model: 'opus' }));
    expect(args).toEqual(expect.arrayContaining(['--resume', 'native-1', '--model', 'opus']));
  });
});
