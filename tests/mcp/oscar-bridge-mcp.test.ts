import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, rm, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

const MCP_SCRIPT = path.resolve('dist/mcp/oscar-bridge-mcp.js');

function sendStdioRequest(child: ChildProcessWithoutNullStreams, request: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stdio timeout')), 5000);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line);
          if (typeof msg === 'object' && msg !== null && 'id' in msg && (msg as { id: unknown }).id === (request as { id: unknown }).id) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            resolve(msg);
            return;
          }
        } catch { /* skip non-JSON */ }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify(request) + '\n');
  });
}

describe('oscar-bridge-mcp child process', () => {
  let socketPath: string;
  let fakeBridge: ChildProcessWithoutNullStreams;
  let child: ChildProcessWithoutNullStreams;

  beforeAll(async () => {
    socketPath = path.join(os.tmpdir(), `oscar-bridge-mcp-test-${randomUUID().slice(0, 8)}.sock`);
    await mkdir(path.dirname(socketPath), { recursive: true });

    // spawn fake bridge that responds to send_file
    const fakeScript = `
      const net = require('node:net');
      const srv = net.createServer((sock) => {
        let buf = '';
        sock.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\\n');
          if (nl < 0) return;
          const req = JSON.parse(buf.slice(0, nl));
          if (req.method === 'send_file') {
            sock.write(JSON.stringify({ content: [{ type: 'text', text: 'sent as message mcp-msg-1' }] }) + '\\n');
          } else {
            sock.write(JSON.stringify({ content: [{ type: 'text', text: 'unknown' }], isError: true }) + '\\n');
          }
          sock.end();
        });
      });
      srv.listen(${JSON.stringify(socketPath)}, () => {
        require('node:fs').chmodSync(${JSON.stringify(socketPath)}, 0o600);
        process.stdout.write('READY\\n');
      });
    `;
    fakeBridge = spawn(process.execPath, ['-e', fakeScript], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
    // wait for fake bridge to be listening
    await new Promise<void>((resolve) => {
      fakeBridge.stdout.on('data', (chunk) => {
        if (chunk.toString('utf8').includes('READY')) resolve();
      });
    });

    child = spawn(process.execPath, [MCP_SCRIPT], {
      env: { ...process.env, OSCAR_BRIDGE_SOCKET: socketPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    // small delay for MCP server startup
    await new Promise((r) => setTimeout(r, 300));
  }, 10_000);

  afterAll(async () => {
    if (child) child.kill();
    if (fakeBridge) fakeBridge.kill();
    await rm(socketPath, { force: true });
  });

  it('exposes send_file via JSON-RPC stdio and forwards to bridge socket', async () => {
    const response = await sendStdioRequest(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_file', arguments: { path: '/tmp/a.xlsx', file_name: 'a.xlsx' } },
    });
    const r = response as { result?: { content: Array<{ text: string }>; isError?: boolean }; error?: unknown };
    expect(r.error).toBeUndefined();
    expect(r.result).toBeDefined();
    expect(r.result!.isError).toBeFalsy();
    expect(r.result!.content[0]!.text).toContain('mcp-msg-1');
  });

  it('lists send_file in tools/list', async () => {
    const response = await sendStdioRequest(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const r = response as { result?: { tools: Array<{ name: string }> } };
    expect(r.result!.tools.map((t) => t.name)).toContain('send_file');
  });

  it('returns isError when path is missing', async () => {
    const response = await sendStdioRequest(child, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'send_file', arguments: {} },
    });
    const r = response as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0]!.text).toMatch(/path is required/);
  });
});
