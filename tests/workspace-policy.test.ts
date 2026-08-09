import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkspace } from '../src/workspace/workspace-policy.js';

describe('resolveWorkspace', () => {
  it('accepts a concrete project directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-workspace-'));
    expect(await resolveWorkspace(dir)).toEqual({ ok: true, path: await realpath(dir) });
  });
  it('rejects relative paths and broad roots', async () => {
    expect((await resolveWorkspace('relative')).ok).toBe(false);
    expect(await resolveWorkspace(homedir())).toMatchObject({ ok: false, reason: 'too_broad' });
  });
  it('rejects regular files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-workspace-'));
    const file = join(dir, 'file'); await writeFile(file, 'x');
    expect(await resolveWorkspace(file)).toMatchObject({ ok: false, reason: 'not_directory' });
  });
});
