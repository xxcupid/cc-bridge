import { realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

const FORBIDDEN_ROOTS = ['/', '/System', '/Library', '/Applications', '/bin', '/sbin', '/usr', '/etc', '/var', '/private'];

export type WorkspaceResolution =
  | { ok: true; path: string }
  | { ok: false; reason: 'not_absolute' | 'not_found' | 'not_directory' | 'too_broad'; message: string };

export async function resolveWorkspace(input: string): Promise<WorkspaceResolution> {
  const expanded = input === '~' ? homedir() : input.startsWith('~/') ? resolve(homedir(), input.slice(2)) : input;
  if (!isAbsolute(expanded)) return { ok: false, reason: 'not_absolute', message: 'Workspace 必须是绝对路径或 ~/ 子目录。' };
  let canonical: string;
  try { canonical = await realpath(expanded); }
  catch { return { ok: false, reason: 'not_found', message: 'Workspace 不存在或无法访问。' }; }
  let info;
  try { info = await stat(canonical); }
  catch { return { ok: false, reason: 'not_found', message: 'Workspace 不存在或无法访问。' }; }
  if (!info.isDirectory()) return { ok: false, reason: 'not_directory', message: 'Workspace 必须是目录。' };
  const broad = new Set(await Promise.all([...FORBIDDEN_ROOTS, homedir(), tmpdir()].map(async (path) => {
    try { return await realpath(path); }
    catch { return resolve(path); }
  })));
  if (broad.has(canonical)) return { ok: false, reason: 'too_broad', message: '拒绝使用根目录、Home 根、系统目录或临时目录根。' };
  return { ok: true, path: canonical };
}
