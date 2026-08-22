import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { terminateProcess } from '../src/agents/shared/terminate-process.js';

describe('terminateProcess', () => {
  it('sends SIGTERM first and escalates to SIGKILL after the grace period', async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const stopping = terminateProcess(child as unknown as ChildProcess, 500);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(500); await stopping;
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    vi.useRealTimers();
  });
  it('does not escalate when the process exits during grace', async () => {
    vi.useFakeTimers();
    const child = new FakeProcess();
    const stopping = terminateProcess(child as unknown as ChildProcess, 500);
    child.exitCode = 0; child.emit('exit', 0, null); await stopping;
    await vi.advanceTimersByTimeAsync(500);
    expect(child.signals).toEqual(['SIGTERM']);
    vi.useRealTimers();
  });
  it('handles a synchronous exit emitted by kill without waiting for the grace timer', async () => {
    vi.useFakeTimers();
    const child = new FakeProcess(true);
    await terminateProcess(child as unknown as ChildProcess, 500);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });
});

class FakeProcess extends EventEmitter {
  exitCode: number | null = null; signalCode: NodeJS.Signals | null = null; signals: NodeJS.Signals[] = [];
  constructor(private readonly exitSynchronously = false) { super(); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exitSynchronously) { this.signalCode = signal; this.emit('exit', null, signal); }
    return true;
  }
}
