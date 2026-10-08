import { mkdtemp, mkdir, writeFile, symlink, rm, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readOutboundFile, MAX_OUTBOUND_FILE_BYTES } from '../../src/channel/outbound-file.js';
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'outbound-review-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
describe('outbound file boundaries', () => {
  it('reads only a regular existing file within an approved root', async () => {
    const file = join(dir, 'report.xlsx'); await writeFile(file, 'dummy');
    expect((await readOutboundFile(file, [dir])).toString()).toBe('dummy');
    await expect(readOutboundFile(file, [])).rejects.toThrow('outside allowed');
    await expect(readOutboundFile('report.xlsx', [dir])).rejects.toThrow('absolute');
    await expect(readOutboundFile(join(dir, 'missing'), [dir])).rejects.toThrow();
    await expect(readOutboundFile(dir, [dir])).rejects.toThrow('regular file');
  });
  it('rejects symlinks to files outside the root', async () => {
    const allowed = join(dir, 'allowed'); await mkdir(allowed);
    const target = join(dir, 'outside.txt'); await writeFile(target, 'dummy');
    const link = join(allowed, 'artifact.txt'); await symlink(target, link);
    await expect(readOutboundFile(link, [allowed])).rejects.toThrow('outside allowed');
  });
  it('rejects protected state even inside an allowed root', async () => {
    const protectedDir = join(dir, '.ssh'); await mkdir(protectedDir);
    const file = join(protectedDir, 'dummy'); await writeFile(file, 'dummy');
    await expect(readOutboundFile(file, [dir])).rejects.toThrow('blocked');
  });
  it('rejects empty and oversized files before reading', async () => {
    const file = join(dir, 'large'); await writeFile(file, '');
    await expect(readOutboundFile(file, [dir])).rejects.toThrow('non-empty');
    const fd = await open(file, 'w'); await fd.truncate(MAX_OUTBOUND_FILE_BYTES + 1); await fd.close();
    await expect(readOutboundFile(file, [dir])).rejects.toThrow('30 MiB');
  });
});
