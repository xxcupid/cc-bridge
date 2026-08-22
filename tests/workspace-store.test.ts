import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';

describe('WorkspaceStore', () => {
  it('persists named workspaces and scope bindings across reloads', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-workspace-'));
    const file = join(dir, 'workspaces.json');
    const first = new WorkspaceStore(file);
    first.saveNamed('project-a', '/repo/a');
    first.saveNamed('project-b', '/repo/b');
    first.setScope('p2p:user-a', '/repo/a');
    await first.flush();

    const second = new WorkspaceStore(file);
    await second.load();
    expect(second.listNamed()).toEqual({ 'project-a': '/repo/a', 'project-b': '/repo/b' });
    expect(second.forScope('p2p:user-a')).toBe('/repo/a');
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 });
  });

  it('persists removal of a named workspace without changing scope bindings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-workspace-'));
    const file = join(dir, 'workspaces.json');
    const first = new WorkspaceStore(file);
    first.saveNamed('project-a', '/repo/a');
    first.setScope('scope', '/repo/a');
    await first.flush();
    expect(first.removeNamed('project-a')).toBe(true);
    await first.flush();

    const second = new WorkspaceStore(file);
    await second.load();
    expect(second.getNamed('project-a')).toBeUndefined();
    expect(second.forScope('scope')).toBe('/repo/a');
  });
});
