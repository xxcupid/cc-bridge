import { describe, expect, it } from 'vitest';
import { MulticaTaskEventSource, type MulticaTaskClient, type MulticaTaskMessage } from '../../../src/integrations/multica/task-message-client.js';

class FakeMulticaClient implements MulticaTaskClient {
  calls: number[] = [];
  private readonly batches: MulticaTaskMessage[][];
  private statusIndex = 0;
  constructor(private readonly statuses: string[], ...batches: MulticaTaskMessage[][]) {
    this.batches = batches;
  }
  async listMessages(_taskId: string, since: number): Promise<MulticaTaskMessage[]> {
    this.calls.push(since);
    return this.batches[this.calls.length - 1] ?? [];
  }
  async getTaskStatus(_taskId: string): Promise<string> {
    return this.statuses[Math.min(this.statusIndex++, this.statuses.length - 1)] ?? 'running';
  }
}

describe('MulticaTaskEventSource', () => {
  it('converts persisted messages, deduplicates seq, and completes', async () => {
    const client = new FakeMulticaClient(['completed'], [
      { task_id: 'task-1', seq: 2, type: 'text', content: 'world' },
      { task_id: 'task-1', seq: 1, type: 'text', content: 'hello ' },
      { task_id: 'task-1', seq: 1, type: 'text', content: 'duplicate' },
      { task_id: 'task-1', seq: 3, type: 'tool_use', tool: 'Bash', input: { command: 'pwd' } },
      { task_id: 'task-1', seq: 4, type: 'tool_result', tool: 'Bash', output: '/tmp' },
    ]);
    const source = new MulticaTaskEventSource(client, { pollIntervalMs: 0, sleep: async () => undefined });
    const events = [];
    for await (const event of source.events('task-1')) events.push(event);

    expect(events).toEqual([
      { type: 'thinking.delta', text: 'hello ' },
      { type: 'tool.started', toolCallId: '3', name: 'Bash', input: { command: 'pwd' } },
      { type: 'tool.completed', toolCallId: '4', output: '/tmp', isError: false },
      { type: 'metrics.updated', metrics: { messageCount: 4, source: 'Multica TaskMessage' } },
      { type: 'text.delta', text: 'world' },
      { type: 'run.completed' },
    ]);
    expect(client.calls).toEqual([0]);
  });

  it('continues from the last seq and maps failure messages', async () => {
    const client = new FakeMulticaClient(['running', 'failed'],
      [{ task_id: 'task-2', seq: 1, type: 'thinking', content: 'checking' }],
      [{ task_id: 'task-2', seq: 2, type: 'error', content: 'provider failed' }],
    );
    let sleeps = 0;
    const source = new MulticaTaskEventSource(client, { pollIntervalMs: 0, sleep: async () => { sleeps += 1; } });
    const events = [];
    for await (const event of source.events('task-2')) events.push(event);

    expect(events).toEqual([
      { type: 'thinking.delta', text: 'checking' },
      { type: 'run.failed', message: 'provider failed' },
      { type: 'metrics.updated', metrics: { messageCount: 2, source: 'Multica TaskMessage' } },
    ]);
    expect(client.calls).toEqual([0, 1]);
    expect(sleeps).toBe(1);
  });
});
