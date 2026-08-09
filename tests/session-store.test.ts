import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/session/session-store.js';

describe('SessionStore', () => {
  it('persists named sessions, active selection and native resume id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-session-'));
    const file = join(dir, 'sessions.json');
    const first = new SessionStore(file);
    const a = first.create('scope', { name: 'alpha', agentId: 'claude', cwd: '/repo', mode: 'default' });
    first.create('scope', { name: 'beta', agentId: 'codex', cwd: '/repo', mode: 'yolo' });
    first.switch('scope', 'alpha');
    first.updateNativeSession(a.id, 'native-a');
    await first.flush();

    const second = new SessionStore(file);
    await second.load();
    expect(second.active('scope')).toMatchObject({ name: 'alpha', nativeSessionId: 'native-a' });
    expect(second.list('scope')).toHaveLength(2);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });

  it('ends the active session without deleting its history record', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-session-'));
    const store = new SessionStore(join(dir, 'sessions.json'));
    store.create('scope', { agentId: 'claude', cwd: '/repo', mode: 'default' });
    expect(store.end('scope')).toBeDefined();
    expect(store.active('scope')).toBeUndefined();
    expect(store.list('scope', true)).toHaveLength(1);
  });
});
