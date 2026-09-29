import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import spawn from 'cross-spawn';
import type { AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest } from '../../domain/agent.js';
import { AsyncEventQueue } from '../shared/async-event-queue.js';
import { terminateProcess } from '../shared/terminate-process.js';

export interface PiRpcAdapterOptions { binary?: string; provider?: string; model?: string; stopGraceMs?: number; spawnProcess?: typeof spawn; }

/** Minimal Pi RPC transport. It deliberately keeps protocol translation small until E2E acceptance. */
export class PiRpcAdapter implements AgentAdapter {
  readonly id = 'pi' as const;
  private readonly binary: string;
  private readonly provider: string;
  private readonly model: string;
  private readonly stopGraceMs: number;
  private readonly spawnProcess: typeof spawn;

  constructor(options: PiRpcAdapterOptions = {}) {
    this.binary = options.binary ?? 'pi';
    this.provider = options.provider ?? 'minimax-anthropic';
    this.model = options.model ?? 'MiniMax-M3[1M]';
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const args = ['--mode', 'rpc', '--provider', this.provider, '--model', this.model];
    if (request.resumeId) args.push('--session', request.resumeId);
    const child = this.spawnProcess(this.binary, args, {
      cwd: request.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const events = new AsyncEventQueue<AgentEvent>();
    let cancelled = false; let reason: string | undefined; let nativeSessionId: string | undefined;
    const metrics = { model: `${this.provider}/${this.model}`, contextTokens: this.model.includes('[1M]') ? 1_000_000 : 512_000 };
    events.push({ type: 'metrics.updated', metrics });
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.type === 'response' && record.command === 'get_state' && record.success === true) {
          const id = (record.data as Record<string, unknown> | undefined)?.sessionId;
          if (typeof id === 'string') { nativeSessionId = id; events.push({ type: 'session.started', nativeSessionId: id }); }
        } else if (record.type === 'response' && record.command === 'prompt' && record.success === false) {
          events.push({ type: 'run.failed', message: String(record.error ?? 'Pi prompt rejected'), code: 'prompt_rejected' });
        } else if (record.type === 'message_end') {
          const usage = (record.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
          if (usage) emitUsage(usage, metrics, events);
        } else if (record.type === 'message_update') {
          const assistantEvent = record.assistantMessageEvent as Record<string, unknown> | undefined;
          const delta = assistantEvent?.delta;
          const usage = record.usage as Record<string, unknown> | undefined;
          if (usage) emitUsage(usage, metrics, events);
          if (typeof delta === 'string' && assistantEvent?.type === 'thinking_delta') events.push({ type: 'thinking.delta', text: delta });
          else if (typeof delta === 'string' && assistantEvent?.type === 'text_delta') events.push({ type: 'text.delta', text: delta });
        } else if (record.type === 'session_start') {
          const id = record.sessionId;
          if (typeof id === 'string') { nativeSessionId = id; events.push({ type: 'session.started', nativeSessionId: id }); }
        } else if (record.type === 'agent_settled') {
          events.push({ type: 'run.completed', nativeSessionId });
          events.end();
          void terminateProcess(child, this.stopGraceMs);
        } else if (record.type === 'response' && record.command === 'prompt' && record.success === true) {
          // Acceptance response is not completion; continue consuming events.
        }
      } catch { /* malformed diagnostics are intentionally ignored */ }
    });
    child.once('error', (error) => { events.push({ type: 'run.failed', message: `failed to start Pi: ${error.message}`, code: 'spawn_failed' }); events.end(); });
    child.once('exit', (code, signal) => {
      lines.close();
      if (cancelled) events.push({ type: 'run.cancelled', reason });
      else if (code !== 0) events.push({ type: 'run.failed', message: `Pi exited with ${signal ?? `code ${code ?? 'unknown'}`}`, code: 'process_exit' });
      events.end();
    });
    child.stdin.write(`${JSON.stringify({ id: `${request.runId}-state`, type: 'get_state' })}\n`);
    child.stdin.write(`${JSON.stringify({ id: request.runId, type: 'prompt', message: request.prompt })}\n`);
    return {
      events,
      cancel: async (cancelReason) => { if (child.exitCode !== null || child.signalCode !== null) return; cancelled = true; reason = cancelReason; try { child.stdin.write('{"type":"abort"}\n'); } catch {} await terminateProcess(child, this.stopGraceMs); },
      approve: async () => { throw new Error('Pi RPC approval mapping is not implemented yet'); },
      answer: async () => { throw new Error('Pi RPC question mapping is not implemented yet'); },
    };
  }
}

function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function emitUsage(usage: Record<string, unknown>, metrics: { model: string; contextTokens: number; [key: string]: unknown }, events: AsyncEventQueue<AgentEvent>): void {
  const updated: Record<string, unknown> = { ...metrics };
  const fields: Array<[string, string]> = [['input', 'inputTokens'], ['output', 'outputTokens'], ['cacheRead', 'cacheReadTokens'], ['cacheWrite', 'cacheWriteTokens'], ['totalTokens', 'totalTokens']];
  for (const [source, target] of fields) { const value = number(usage[source]); if (value != null && (value > 0 || updated[target] == null)) updated[target] = value; }
  Object.assign(metrics, updated); events.push({ type: 'metrics.updated', metrics: updated as never });
}
