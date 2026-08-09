import type { AgentEvent } from '../../domain/agent.js';

export class CodexJsonlTranslator {
  private threadId: string | undefined;
  private pendingText: string | undefined;
  private terminal = false;

  translate(raw: unknown): AgentEvent[] {
    if (this.terminal || !isRecord(raw) || typeof raw.type !== 'string') return [];
    if (raw.type === 'thread.started') {
      const id = text(raw.thread_id ?? raw.threadId);
      if (!id) return [];
      this.threadId = id; return [{ type: 'session.started', nativeSessionId: id }];
    }
    if (raw.type === 'item.started') {
      const item = record(raw.item);
      if (item?.type !== 'command_execution') return [];
      const id = text(item.id); if (!id) return [];
      return [{ type: 'tool.started', toolCallId: id, name: 'command_execution', input: { command: text(item.command) ?? '' } }];
    }
    if (raw.type === 'item.completed') {
      const item = record(raw.item); if (!item) return [];
      if (item.type === 'agent_message') return this.queueText(text(item.text ?? item.message));
      if (item.type !== 'command_execution') return [];
      const id = text(item.id); if (!id) return [];
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
      return this.flushPending([{ type: 'tool.completed', toolCallId: id, output: text(item.output ?? item.aggregated_output ?? item.stdout) ?? '', isError: exitCode !== undefined && exitCode !== 0 }]);
    }
    if (raw.type === 'agent_message') return this.queueText(text(raw.message ?? raw.text));
    if (raw.type === 'turn.completed') {
      this.terminal = true;
      return this.flushPending([{ type: 'run.completed', nativeSessionId: this.threadId }]);
    }
    if (raw.type === 'turn.failed') {
      this.terminal = true;
      return this.flushPending([{ type: 'run.failed', message: errorMessage(raw, 'Codex turn failed') }]);
    }
    return [];
  }

  finishFailure(message: string): AgentEvent[] {
    if (this.terminal) return [];
    this.terminal = true; return this.flushPending([{ type: 'run.failed', message }]);
  }

  terminalSeen(): boolean { return this.terminal; }

  private queueText(value: string | undefined): AgentEvent[] {
    if (!value || value === this.pendingText) return [];
    const previous = this.pendingText; this.pendingText = value;
    return previous ? [{ type: 'text.delta', text: previous }] : [];
  }
  private flushPending(events: AgentEvent[]): AgentEvent[] {
    if (!this.pendingText) return events;
    const pending = this.pendingText; this.pendingText = undefined;
    return [{ type: 'text.delta', text: pending }, ...events];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function record(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function errorMessage(raw: Record<string, unknown>, fallback: string): string {
  const nested = record(raw.error); return text(raw.message) ?? text(nested?.message) ?? text(raw.error) ?? fallback;
}
