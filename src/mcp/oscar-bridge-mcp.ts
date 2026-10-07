#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { connect, type Socket } from 'node:net';

const SOCKET_PATH = process.env.OSCAR_BRIDGE_SOCKET;
if (!SOCKET_PATH) {
  process.stderr.write('OSCAR_BRIDGE_SOCKET env var is required\n');
  process.exit(2);
}

const server = new Server(
  { name: 'oscar-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'send_file',
    description: 'Upload a local file and send it as an attachment to the current Feishu chat. The file is read from disk, uploaded to Feishu, and delivered as a separate message. Use this after generating or downloading any file you want the user to receive.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file on disk.' },
        file_name: { type: 'string', description: 'Optional display filename. Defaults to basename of path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'send_file') {
    return { content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }], isError: true };
  }
  const args = (request.params.arguments ?? {}) as { path?: string; file_name?: string };
  if (!args.path || typeof args.path !== 'string') {
    return { content: [{ type: 'text', text: 'send_file: path is required' }], isError: true };
  }
  try {
    const response = await callBridge('send_file', { path: args.path, file_name: args.file_name });
    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `send_file failed: ${msg}` }], isError: true };
  }
});

function callBridge(method: string, args: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(SOCKET_PATH!);
    let buffer = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('bridge timeout (30s)')); }, 30_000);
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)));
          sock.end();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    sock.write(JSON.stringify({ method, args }) + '\n');
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
