export class ThrottledUpdater<T> {
  private pending: T | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt = 0;
  private chain = Promise.resolve();

  constructor(
    private readonly intervalMs: number,
    private readonly sink: (value: T) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  schedule(value: T): void {
    this.pending = value;
    const remaining = Math.max(0, this.intervalMs - (this.now() - this.lastFlushAt));
    if (remaining === 0) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), remaining);
  }

  async flushNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flush();
    await this.chain;
  }

  private async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const value = this.pending;
    if (value === undefined) return this.chain;
    this.pending = undefined;
    this.lastFlushAt = this.now();
    this.chain = this.chain.then(() => this.sink(value));
    await this.chain;
    if (this.pending !== undefined && !this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.intervalMs);
    }
  }
}
