import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type spawn from 'cross-spawn';
import { describe, expect, it } from 'vitest';
import { PiRpcAdapter } from '../src/agents/pi/adapter.js';

describe('PiRpcAdapter', () => {
  it('starts Pi in RPC mode and sends a prompt', async () => {
    const child = new FakePi();
    const handle = await adapterFor(child).start(request());
    expect(child.args).toEqual(['--mode', 'rpc', '--provider', 'minimax-anthropic', '--model', 'MiniMax-M3[1M]']);
    expect(child.messages).toEqual([{ id: 'run-1-state', type: 'get_state' }, { id: 'run-1', type: 'prompt', message: 'hello' }]);
    await handle.cancel('test stop');
    expect(child.messages.at(-1)).toEqual({ type: 'abort' });
  });

  it('resumes a persisted native Pi session by id', async () => {
    const child = new FakePi();
    await adapterFor(child).start({ ...request(), resumeId: 'pi-session-1' });
    expect(child.args).toContain('--session');
    expect(child.args).toContain('pi-session-1');
  });

  it('translates session, text delta, completion and process failure', async () => {
    const child = new FakePi();
    const handle = await adapterFor(child).start(request());
    const iterator = handle.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'metrics.updated', metrics: { model: 'minimax-anthropic/MiniMax-M3[1M]', contextTokens: 1_000_000 } } });
    child.send({ type: 'response', command: 'get_state', success: true, data: { sessionId: 'pi-session-1' } });
    child.send({ type: 'message_update', usage: { input: 150000, output: 141, cacheRead: 5700, cacheWrite: 0, totalTokens: 156000 }, assistantMessageEvent: { type: 'text_delta', delta: 'hello ' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'session.started', nativeSessionId: 'pi-session-1' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'metrics.updated', metrics: { inputTokens: 150000, outputTokens: 141, cacheReadTokens: 5700, totalTokens: 156000 } } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text.delta', text: 'hello ' } });
    child.send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'internal plan' } });
    child.send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'world' } });
    child.send({ type: 'agent_settled' });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'thinking.delta', text: 'internal plan' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text.delta', text: 'world' } });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed', nativeSessionId: 'pi-session-1' } });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
  });

  it('reports rejected RPC prompts', async () => {
    const child = new FakePi();
    const handle = await adapterFor(child).start(request());
    const iterator = handle.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'metrics.updated' } });
    child.send({ type: 'response', command: 'prompt', success: false, error: 'bad model' });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.failed', code: 'prompt_rejected', message: 'bad model' } });
  });
});

function request() {
  return { runId: 'run-1', sessionId: 'session-1', prompt: 'hello', cwd: '/tmp', permission: { mode: 'default' as const, maxAccess: 'workspace' as const } };
}

function adapterFor(child: FakePi): PiRpcAdapter {
  return new PiRpcAdapter({ spawnProcess: ((_binary: string, args: string[]) => { child.args.push(...args); return child as unknown as ChildProcessWithoutNullStreams; }) as unknown as typeof spawn });
}

class FakePi extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  readonly args: string[] = [];
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdin = new Writable({ write: (chunk, _encoding, callback) => { this.messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>); callback(); } });
  send(message: unknown): void { queueMicrotask(() => this.stdout.write(`${JSON.stringify(message)}\n`)); }
  fail(code: number): void { this.exitCode = code; queueMicrotask(() => this.emit('exit', code, null)); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean { this.signalCode = signal; queueMicrotask(() => this.emit('exit', null, signal)); return true; }
}
