import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ChannelPort, FileSendOptions } from '../channel/port.js';

export interface BridgeMcpListenerOptions {
  channel: ChannelPort;
  chatId: string;
  runId: string;
  allowedFileDirs?: string[];
  replyOptions?: Omit<FileSendOptions, 'allowedFileDirs'>;
}
export interface BridgeMcpHandle { socketPath: string; close(): Promise<void>; }
const MAX_REQUEST_BYTES = 64 * 1024;

export async function startBridgeMcpListener(options: BridgeMcpListenerOptions): Promise<BridgeMcpHandle> {
  const socketPath = path.join(os.tmpdir(), `ob-${randomBytes(8).toString('hex')}.sock`);
  await mkdir(path.dirname(socketPath), { recursive: true });
  const sockets = new Set<Socket>();
  let closed = false;
  const server = createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    sock.on('error', () => sock.destroy());
    sock.setTimeout(125_000, () => sock.destroy());
    let buffer = Buffer.alloc(0);
    let handled = false;
    const respond = (text: string, isError = false) => {
      if (!sock.destroyed) sock.end(JSON.stringify({ content: [{ type: 'text', text }], ...(isError ? { isError } : {}) }) + '\n');
    };
    sock.on('data', (chunk) => {
      if (handled || closed) return;
      if (buffer.length + chunk.length > MAX_REQUEST_BYTES) { handled = true; respond('request too large', true); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(10);
      if (nl < 0) return;
      handled = true; // Exactly one operation per connection; prevent concurrent re-entry.
      void (async () => {
        try {
          const request = JSON.parse(buffer.subarray(0, nl).toString('utf8'));
          if (request?.method !== 'send_file') throw new Error(`unknown method: ${request?.method}`);
          const args = request.args;
          if (!args || typeof args.path !== 'string' || !path.isAbsolute(args.path)) throw new Error('path is required and must be absolute');
          if (args.file_name !== undefined && typeof args.file_name !== 'string') throw new Error('file_name must be a string');
          if (!options.channel.sendFile) throw new Error('channel does not support sendFile');
          const result = await options.channel.sendFile(options.chatId, args.path, args.file_name ?? path.basename(args.path), {
            ...options.replyOptions, allowedFileDirs: options.allowedFileDirs ?? [],
          });
          respond(`sent as message ${result.messageId}`);
        } catch (error) { respond(`send_file failed: ${error instanceof Error ? error.message : String(error)}`, true); }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    await chmod(socketPath, 0o600);
  } catch (error) {
    server.close();
    await unlink(socketPath).catch(() => undefined);
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return {
    socketPath,
    close() {
      return closePromise ??= (async () => {
        closed = true;
        const done = new Promise<void>((resolve) => server.close(() => resolve()));
        for (const sock of sockets) sock.destroy();
        await done;
        await unlink(socketPath).catch(() => undefined);
      })();
    },
  };
}
