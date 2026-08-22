import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireInstanceLocks } from '../src/runtime/instance-lock.js';

describe('bridge instance locks', () => {
  it('allows different profiles with different apps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oscar-locks-'));
    const first = await acquireInstanceLocks(root, 'claude', 'cli_a');
    const second = await acquireInstanceLocks(root, 'codex', 'cli_b');
    await second.release();
    await first.release();
  });

  it('rejects a duplicate profile or duplicate app while its owner is alive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oscar-locks-conflict-'));
    const first = await acquireInstanceLocks(root, 'claude', 'cli_a');
    await expect(acquireInstanceLocks(root, 'claude', 'cli_b')).rejects.toThrow('already running');
    await expect(acquireInstanceLocks(root, 'codex', 'cli_a')).rejects.toThrow('already running');
    await first.release();
  });

  it('reclaims stale locks and releases only locks owned by the caller', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oscar-locks-stale-'));
    const stale = await acquireInstanceLocks(root, 'claude', 'cli_a', 999_999_999);
    const current = await acquireInstanceLocks(root, 'claude', 'cli_a');
    await stale.release();
    await expect(acquireInstanceLocks(root, 'claude', 'cli_a')).rejects.toThrow('already running');
    await current.release();
    const next = await acquireInstanceLocks(root, 'claude', 'cli_a');
    await next.release();
  });
});
