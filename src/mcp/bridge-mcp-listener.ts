import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server as NetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ChannelPort } from '../channel/port.js';

export interface BridgeMcpListenerOptions {
  channel: ChannelPort;
  chatId: string;
  runId: string;
}

export interface BridgeMcpHandle {
  socketPath: string;
  close(): Promise<void>;
}

export async function startBridgeMcpListener(options: BridgeMcpListenerOptions): Promise<BridgeMcpHandle> {
  const socketPath = path.join(os.tmpdir(), `oscar-bridge-${options.runId}-${randomUUID().slice(0, 8)}.sock`);
  await mkdir(path.dirname(socketPath), { recursive: true });

  const server: NetServer = createServer((sock) => {
    let buffer = '';
    sock.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let request: { method: string; args: unknown };
      try {
        request = JSON.parse(line);
      } catch {
        sock.write(JSON.stringify({ content: [{ type: 'text', text: 'invalid json' }], isError: true }) + '\n');
        return;
      }
      try {
        if (request.method === 'send_file') {
          const args = (request.args ?? {}) as { path?: string; file_name?: string };
          if (!args.path || typeof args.path !== 'string') throw new Error('path is required');
          if (!options.channel.sendFile) throw new Error('channel does not support sendFile');
          const fileName = args.file_name ?? path.basename(args.path);
          const result = await options.channel.sendFile(options.chatId, args.path, fileName);
          sock.write(JSON.stringify({ content: [{ type: 'text', text: `sent as message ${result.messageId}` }] }) + '\n');
        } else {
          sock.write(JSON.stringify({ content: [{ type: 'text', text: `unknown method: ${request.method}` }], isError: true }) + '\n');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sock.write(JSON.stringify({ content: [{ type: 'text', text: `send_file failed: ${msg}` }], isError: true }) + '\n');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
