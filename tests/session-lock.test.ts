import { describe, expect, it } from 'vitest';
import { SessionLock } from '../src/application/session-lock.js';

describe('SessionLock', () => {
  it('serializes the same key while allowing different keys to run in parallel', async () => {
    const lock = new SessionLock(); const order: string[] = [];
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = lock.runExclusive('a', async () => { order.push('a1:start'); await gate; order.push('a1:end'); });
    const second = lock.runExclusive('a', async () => { order.push('a2'); });
    const parallel = lock.runExclusive('b', async () => { order.push('b'); });
    await parallel;
    expect(order).toEqual(['a1:start', 'b']);
    release(); await Promise.all([first, second]);
    expect(order).toEqual(['a1:start', 'b', 'a1:end', 'a2']);
  });
});
