import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
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
    child.send({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text.delta', text: 'do' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text.delta', text: 'ne' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed', nativeSessionId: 'thread-1' } });
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
});

class FakeAppServer extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough();
  messages: Array<Record<string, unknown>> = [];
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null;
  signals: NodeJS.Signals[] = [];
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    const message = JSON.parse(chunk.toString()) as Record<string, unknown>; this.messages.push(message);
    const id = message.id; const method = message.method;
    if (id !== undefined && method === 'initialize') this.send({ jsonrpc: '2.0', id, result: { protocolVersion: '2' } });
    if (id !== undefined && method === 'thread/start') this.send({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-1' }, cwd: '/tmp', model: 'test' } });
    if (id !== undefined && method === 'thread/resume') this.send({ jsonrpc: '2.0', id, result: { thread: { id: 'thread-1' }, cwd: '/tmp', model: 'test' } });
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
