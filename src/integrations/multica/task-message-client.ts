import type { AgentEvent } from '../../domain/agent.js';

/** The user-authenticated Multica task-message shape exposed by /api/tasks/:id/messages. */
export interface MulticaTaskMessage {
  task_id: string;
  issue_id?: string;
  seq: number;
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | string;
  tool?: string;
  content?: string;
  input?: Record<string, unknown>;
  output?: string;
  created_at?: string;
}

export interface MulticaTaskClient {
  listMessages(taskId: string, since: number): Promise<MulticaTaskMessage[]>;
  getTaskStatus(taskId: string): Promise<string>;
}

export interface MulticaTaskEventSourceOptions {
  pollIntervalMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const terminalStatuses = new Set(['completed', 'done', 'failed', 'cancelled']);

/**
 * Converts Multica's persisted incremental TaskMessage feed into the bridge's
 * native AgentEvent stream. The source is deliberately transport-agnostic:
 * the first PoC can use HTTP polling, while a later implementation may use a
 * realtime subscription without changing the CardKit presenter.
 */
export class MulticaTaskEventSource {
  private readonly intervalMs: number;
  private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly client: MulticaTaskClient, options: MulticaTaskEventSourceOptions = {}) {
    this.intervalMs = options.pollIntervalMs ?? 400;
    this.delay = options.sleep ?? defaultSleep;
  }

  async *events(taskId: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    let lastSeq = 0;
    let failureEmitted = false;
    // Multica currently persists both progress narration and the final answer
    // as `text` TaskMessages (there is no `thinking` type). Keep one text
    // message buffered so every earlier narration can render in the card's
    // collapsible thinking area while the final text remains the answer.
    let pendingText: string | undefined;
    while (!signal?.aborted) {
      const messages = await this.client.listMessages(taskId, lastSeq);
      for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
        if (message.seq <= lastSeq) continue;
        lastSeq = message.seq;
        const event = toAgentEvent(message);
        if (message.type === 'text' && event?.type === 'text.delta') {
          if (pendingText) yield { type: 'thinking.delta', text: pendingText };
          pendingText = event.text;
          continue;
        }
        if (event) {
          if (event.type === 'run.failed') failureEmitted = true;
          yield event;
        }
      }

      const status = await this.client.getTaskStatus(taskId);
      if (terminalStatuses.has(status)) {
        yield { type: 'metrics.updated', metrics: { messageCount: lastSeq, source: 'Multica TaskMessage' } };
        if (pendingText) yield { type: 'text.delta', text: pendingText };
        if (status === 'failed' && !failureEmitted) yield { type: 'run.failed', message: `Multica task ${taskId} failed` };
        else if (status === 'failed') return;
        else if (status === 'cancelled') yield { type: 'run.cancelled', reason: `Multica task ${taskId} cancelled` };
        else yield { type: 'run.completed' };
        return;
      }
      await this.delay(this.intervalMs, signal);
    }
  }
}

function toAgentEvent(message: MulticaTaskMessage): AgentEvent | undefined {
  switch (message.type) {
    case 'text':
      return message.content ? { type: 'text.delta', text: message.content } : undefined;
    case 'thinking':
      return message.content ? { type: 'thinking.delta', text: message.content } : undefined;
    case 'tool_use':
      return { type: 'tool.started', toolCallId: String(message.seq), name: message.tool ?? 'unknown', input: message.input };
    case 'tool_result':
      return { type: 'tool.completed', toolCallId: String(message.seq), output: message.output, isError: false };
    case 'error':
      return { type: 'run.failed', message: message.content ?? message.output ?? 'Multica task message error' };
    default:
      return undefined;
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
}
