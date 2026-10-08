import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export const MAX_OUTBOUND_FILE_BYTES = 30 * 1024 * 1024;
const BLOCKED = new Set(['.ssh', '.aws', '.codex', '.claude', '.openclaw', '.oscar-lark-bridge', '.git']);

export async function readOutboundFile(source: string, allowedDirs: string[]): Promise<Buffer> {
  if (!isAbsolute(source)) throw new Error('File path must be absolute');
  const resolved = await realpath(source);
  if (resolved.split(sep).some((part) => BLOCKED.has(part))
    || /^\/(?:private\/)?(?:etc|proc|sys|dev)(?:\/|$)/.test(resolved)) throw new Error('File path is blocked');
  const roots = await Promise.all(allowedDirs.map((dir) => realpath(dir)));
  if (!roots.some((root) => {
    const rel = relative(root, resolved);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  })) throw new Error('File path is outside allowed directories');
  // O_NONBLOCK avoids hanging on a FIFO; fstat validates the opened object.
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Not a regular file');
    if (info.size === 0 || info.size > MAX_OUTBOUND_FILE_BYTES) throw new Error('File must be non-empty and at most 30 MiB');
    // Bound allocation even if the file grows after fstat.
    const buffer = Buffer.alloc(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await file.read(buffer, bytes, buffer.length - bytes, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes !== info.size) throw new Error('File changed while reading; retry after generation completes');
    return buffer.subarray(0, bytes);
  } finally { await file.close(); }
}
