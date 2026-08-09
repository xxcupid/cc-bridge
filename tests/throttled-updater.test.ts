import { describe, expect, it, vi } from 'vitest';
import { ThrottledUpdater } from '../src/presentation/throttled-updater.js';

describe('ThrottledUpdater', () => {
  it('coalesces updates and flushes the latest value', async () => {
    vi.useFakeTimers();
    const values: number[] = [];
    const updater = new ThrottledUpdater<number>(100, async (value) => { values.push(value); }, () => Date.now());
    updater.schedule(1);
    updater.schedule(2);
    await vi.advanceTimersByTimeAsync(100);
    await updater.flushNow();
    expect(values.at(-1)).toBe(2);
    vi.useRealTimers();
  });
});
