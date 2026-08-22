import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type spawn from 'cross-spawn';
import { describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../src/agents/claude/adapter.js';

describe('ClaudeAdapter permission enforcement', () => {
  it('denies a control request above maxAccess without exposing an approval', async () => {
    const child = new FakeClaude();
    const adapter = adapterFor(child);
    const handle = await adapter.start(request());
    const iterator = handle.events[Symbol.asyncIterator]();

    child.send(control('danger', 'Bash', { command: 'dangerous command' }));
    await eventually(() => child.responseFor('danger') !== undefined);
    expect(child.responseFor('danger')).toMatchObject({ behavior: 'deny' });

    child.send({ type: 'result', session_id: 'session-1' });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed' } });
  });

  it('auto-allows read-only control requests in default mode', async () => {
    const child = new FakeClaude();
    const handle = await adapterFor(child).start(request());
    const iterator = handle.events[Symbol.asyncIterator]();

    child.send(control('read', 'Read', { file_path: '/tmp/a' }));
    await eventually(() => child.responseFor('read') !== undefined);
    expect(child.responseFor('read')).toMatchObject({ behavior: 'allow', updatedInput: { file_path: '/tmp/a' } });

    child.send({ type: 'result', session_id: 'session-1' });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed' } });
  });

  it('round-trips an in-range default approval through stdio', async () => {
    const child = new FakeClaude();
    const handle = await adapterFor(child).start(request());
    const iterator = handle.events[Symbol.asyncIterator]();

    child.send(control('edit', 'Edit', { file_path: '/tmp/a' }));
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'approval.requested', requestId: 'edit', access: 'workspace' } });
    await handle.approve('edit', true);
    expect(child.responseFor('edit')).toMatchObject({ behavior: 'allow', updatedInput: { file_path: '/tmp/a' } });

    child.send({ type: 'result', session_id: 'session-1' });
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'run.completed' } });
  });
});

function adapterFor(child: FakeClaude): ClaudeAdapter {
  return new ClaudeAdapter({ spawnProcess: (() => child as unknown as ChildProcessWithoutNullStreams) as unknown as typeof spawn });
}

function request() {
  return {
    runId: 'run-1', sessionId: 'session-1', prompt: 'test', cwd: '/tmp',
    permission: { mode: 'default' as const, maxAccess: 'workspace' as const },
  };
}

function control(requestId: string, toolName: string, input: Record<string, unknown>) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'can_use_tool', tool_name: toolName, input } };
}

class FakeClaude extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  messages: Array<Record<string, unknown>> = [];
  stdin = new Writable({ write: (chunk, _encoding, callback) => {
    this.messages.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
    callback();
  } });

  send(message: unknown): void { queueMicrotask(() => this.stdout.write(`${JSON.stringify(message)}\n`)); }
  responseFor(requestId: string): Record<string, unknown> | undefined {
    const message = this.messages.find((item) => item.type === 'control_response'
      && (item.response as Record<string, unknown> | undefined)?.request_id === requestId);
    return (message?.response as Record<string, unknown> | undefined)?.response as Record<string, unknown> | undefined;
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signalCode = signal;
    queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
}

async function eventually(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('condition was not met');
}
