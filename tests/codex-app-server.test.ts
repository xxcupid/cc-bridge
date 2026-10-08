import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type spawn from 'cross-spawn';
import { describe, expect, it } from 'vitest';
import { CodexAppServerAdapter } from '../src/agents/codex/app-server-adapter.js';

describe('CodexAppServerAdapter', () => {
  it('initializes a thread and round-trips approval through JSON-RPC', async () => {
    const child = new FakeAppServer();
    const adapter = new CodexAppServerAdapter({ spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn });
    const handle = await adapter.start({ runId: 'r1', sessionId: 's1', prompt: 'do it', cwd: '/tmp', permission: { mode: 'default', maxAccess: 'workspace' } });
    const iterator = handle.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'session.started', nativeSessionId: 'thread-1' } });

    child.send({ jsonrpc: '2.0', id: 91, method: 'item/fileChange/requestApproval', params: { reason: 'edit file' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'approval.requested', requestId: '91', action: 'Patch', access: 'workspace' } });
    await handle.approve('91', true);
    expect(child.messages).toContainEqual({ jsonrpc: '2.0', id: 91, result: { decision: 'accept' } });

    child.send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'do' } });
    child.send({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a1', delta: 'ne' } });
    child.send({ jsonrpc: '2.0', method: 'item/completed', params: { item: { id: 'a1', type: 'agentMessage', text: 'done' } } });
    child.send({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: {
      total: { totalTokens: 400, inputTokens: 320, cachedInputTokens: 80, cacheWriteInputTokens: 0, outputTokens: 80, reasoningOutputTokens: 20 },
      last: { totalTokens: 250, inputTokens: 200, cachedInputTokens: 50, cacheWriteInputTokens: 10, outputTokens: 50, reasoningOutputTokens: 10 },
      modelContextWindow: 1_000,
    } } });
    child.send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text.delta', text: 'do' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text.delta', text: 'ne' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'metrics.updated', metrics: { model: 'openai/test', inputTokens: 140, outputTokens: 50, cacheReadTokens: 50, cacheWriteTokens: 10, totalTokens: 250, contextTokens: 1_000 } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed', nativeSessionId: 'thread-1', metrics: { model: 'openai/test', totalTokens: 250 } } });
    await eventually(() => child.signals.includes('SIGTERM'));
  });

  it('automatically rejects requests beyond maxAccess', async () => {
    const child = new FakeAppServer();
    const adapter = new CodexAppServerAdapter({ spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn });
    const handle = await adapter.start({ runId: 'r1', sessionId: 's1', prompt: 'do it', cwd: '/tmp', permission: { mode: 'yolo', maxAccess: 'read-only' } });
    const iterator = handle.events[Symbol.asyncIterator](); await iterator.next();
    child.send({ jsonrpc: '2.0', id: 'danger', method: 'item/commandExecution/requestApproval', params: { command: 'rm file' } });
    await eventually(() => child.messages.some((item) => item.id === 'danger'));
    expect(child.messages).toContainEqual({ jsonrpc: '2.0', id: 'danger', result: { decision: 'decline' } });
    child.send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed' } });
  });

  it('returns the original permission object only after approval', async () => {
    const child = new FakeAppServer();
    const adapter = new CodexAppServerAdapter({ spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn });
    const handle = await adapter.start({ runId: 'r1', sessionId: 's1', prompt: 'do it', cwd: '/tmp', permission: { mode: 'default', maxAccess: 'full' } });
    const iterator = handle.events[Symbol.asyncIterator](); await iterator.next();
    child.send({ jsonrpc: '2.0', id: 92, method: 'item/permissions/requestApproval', params: { permissions: { network: ['example.com'] } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'approval.requested', requestId: '92', action: 'Permissions' } });
    await handle.approve('92', true);
    expect(child.messages).toContainEqual({ jsonrpc: '2.0', id: 92, result: { permissions: { network: ['example.com'] }, scope: 'turn' } });
    child.send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed' } });
  });

  it('resumes a persisted native thread when resumeId is present', async () => {
    const child = new FakeAppServer();
    const adapter = new CodexAppServerAdapter({ spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn });
    const handle = await adapter.start({ runId: 'r1', sessionId: 's1', prompt: 'continue', cwd: '/tmp', resumeId: 'thread-existing', permission: { mode: 'default', maxAccess: 'workspace' } });
    const resume = child.messages.find((item) => item.method === 'thread/resume');
    expect(resume).toMatchObject({ params: { threadId: 'thread-existing', persistExtendedHistory: true } });
    const iterator = handle.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'session.started', nativeSessionId: 'thread-1' } });
    child.send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed' } });
  });

  it('injects per-run MCP config without changing Codex home and resumes the same thread', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-mcp-review-'));
    const home = process.env.CODEX_HOME;
    const spawns: Array<{ argv: string[]; env: NodeJS.ProcessEnv }> = [];
    try {
      for (let run = 0; run < 2; run++) {
        const config = join(dir, `run-${run}.json`);
        await writeFile(config, JSON.stringify({ mcpServers: { 'oscar-bridge': {
          command: '/node', args: ['/bridge/mcp.js'], env: { OSCAR_BRIDGE_SOCKET: `/tmp/socket-${run}` },
        } } }));
        const child = new FakeAppServer();
        const adapter = new CodexAppServerAdapter({ spawnProcess: ((_binary: string, argv: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
          spawns.push({ argv: argv as string[], env: opts?.env ?? {} });
          return child;
        }) as unknown as typeof spawn });
        const handle = await adapter.start({ runId: `r${run}`, sessionId: 's', prompt: 'continue', cwd: dir,
          mcpConfigPath: config, ...(run ? { resumeId: 'thread-1' } : {}), permission: { mode: 'default', maxAccess: 'workspace' } });
        if (run) expect(child.messages.find(m => m.method === 'thread/resume')).toMatchObject({ params: { threadId: 'thread-1' } });
        child.send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
        for await (const _ of handle.events) { /* drain */ }
      }
      expect(spawns.every(s => s.env.CODEX_HOME === home)).toBe(true);
      expect(spawns[0]!.argv).toContain('mcp_servers.oscar-bridge.command="/node"');
      expect(spawns[0]!.argv.join(' ')).toContain('/tmp/socket-0');
      expect(spawns[1]!.argv.join(' ')).toContain('/tmp/socket-1');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('starts the compiled ESM MCP path without a CommonJS require or home override', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'built-codex-mcp-'));
    try {
      const config = join(dir, 'config.json');
      await writeFile(config, JSON.stringify({ mcpServers: { 'oscar-bridge': {
        command: process.execPath, args: ['/tmp/mock.js'], env: { OSCAR_BRIDGE_SOCKET: '/tmp/mock.sock' },
      } } }));
      const script = `
        import { CodexAppServerAdapter } from ${JSON.stringify(join(process.cwd(), 'dist/index.js'))};
        const home = process.env.CODEX_HOME;
        const adapter = new CodexAppServerAdapter({ spawnProcess(_bin, argv, opts) {
          if (opts.env.CODEX_HOME !== home) throw new Error('home changed');
          if (!argv.some(v => v.startsWith('mcp_servers.oscar-bridge.command='))) throw new Error('missing MCP');
          throw new Error('EXPECTED_SPAWN');
        }});
        try { await adapter.start({ runId:'r',sessionId:'s',prompt:'test',cwd:'/tmp',mcpConfigPath:${JSON.stringify(config)},permission:{mode:'default',maxAccess:'workspace'} }); }
        catch(e) { if(e.message !== 'EXPECTED_SPAWN') throw e; console.log('compiled smoke passed'); }
      `;
      expect(execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 5000 })).toContain('compiled smoke passed');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('terminates the app-server when bootstrap fails', async () => {
    const child = new FakeAppServer(['initialize']);
    const adapter = new CodexAppServerAdapter({
      requestTimeoutMs: 5,
      stopGraceMs: 5,
      spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn,
    });

    await expect(adapter.start({ runId: 'r1', sessionId: 's1', prompt: 'do it', cwd: '/tmp', permission: { mode: 'default', maxAccess: 'workspace' } }))
      .rejects.toThrow('Codex app-server initialize timed out');
    expect(child.signals).toContain('SIGTERM');
  });
});

class FakeAppServer extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough();
  messages: Array<Record<string, unknown>> = [];
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  constructor(private readonly ignoredMethods: string[] = []) { super(); }
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    const message = JSON.parse(chunk.toString()) as Record<string, unknown>; this.messages.push(message);
    const id = message.id; const method = message.method;
    if (typeof method === 'string' && this.ignoredMethods.includes(method)) { callback(); return; }
    if (id !== undefined && method === 'initialize') this.send({ jsonrpc: '2.0', id, result: { protocolVersion: '2' } });
    if (id !== undefined && method === 'thread/start') this.send({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-1' }, cwd: '/tmp', model: 'test', modelProvider: 'openai' } });
    if (id !== undefined && method === 'thread/resume') this.send({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-1' }, cwd: '/tmp', model: 'test', modelProvider: 'openai' } });
    if (id !== undefined && method === 'turn/start') this.send({ jsonrpc: '2.0', id, result: { turn: { id: 'turn-1' } } });
    if (id !== undefined && method === 'turn/interrupt') this.send({ jsonrpc: '2.0', id, result: {} });
    callback();
  }});
  send(message: unknown): void { queueMicrotask(() => this.stdout.write(`${JSON.stringify(message)}\n`)); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.signals.push(signal); this.signalCode = signal; this.emit('exit', null, signal); return true; }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) { if (check()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error('condition was not met');
}
