import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../src/approval/approval-store.js';

describe('ApprovalStore', () => {
  it('binds a one-time token to run, scope and operator and persists its audit record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-approval-'));
    const file = join(dir, 'approvals.json');
    const store = new ApprovalStore(file, 10_000); await store.load();
    const issued = store.issue({ kind: 'approval', runId: 'r1', sessionId: 's1', scope: 'c1', operatorId: 'u1', requestId: 'p1', action: 'Bash', parameters: { b: 2, a: 1 } });
    expect(store.consume(issued.token, { runId: 'r1', scope: 'c1', operatorId: 'other' })).toBeUndefined();
    expect(store.consume(issued.token, { runId: 'r1', scope: 'c1', operatorId: 'u1' })).toMatchObject({ requestId: 'p1', consumedAt: expect.any(String) });
    expect(store.consume(issued.token, { runId: 'r1', scope: 'c1', operatorId: 'u1' })).toBeUndefined();
    await store.flush();
    const reloaded = new ApprovalStore(file); await reloaded.load();
    expect(reloaded.consume(issued.token, { runId: 'r1', scope: 'c1', operatorId: 'u1' })).toBeUndefined();
  });
  it('rejects expired tokens', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-approval-'));
    const store = new ApprovalStore(join(dir, 'approvals.json'), 1); await store.load();
    const issued = store.issue({ kind: 'question', runId: 'r', sessionId: 's', scope: 'c', operatorId: 'u', requestId: 'q', action: 'AskUserQuestion' });
    expect(store.consume(issued.token, { runId: 'r', scope: 'c', operatorId: 'u' }, Date.now() + 5)).toBeUndefined();
  });
});
