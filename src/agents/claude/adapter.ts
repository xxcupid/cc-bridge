import { createInterface } from 'node:readline';
import spawn from 'cross-spawn';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest } from '../../domain/agent.js';
import { AsyncEventQueue } from '../shared/async-event-queue.js';
import { terminateProcess } from '../shared/terminate-process.js';
import { buildClaudeArgs } from './argv.js';
import { translateClaudeEvent } from './stream-json.js';
import { decidePermission } from '../../domain/permission.js';

export interface ClaudeAdapterOptions {
  binary?: string;
  stopGraceMs?: number;
  spawnProcess?: typeof spawn;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  private readonly binary: string;
  private readonly stopGraceMs: number;
  private readonly spawnProcess: typeof spawn;

  constructor(options: ClaudeAdapterOptions = {}) {
    this.binary = options.binary ?? 'claude';
    this.stopGraceMs = options.stopGraceMs ?? 5_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const child = this.spawnProcess(this.binary, buildClaudeArgs(request), {
      cwd: request.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const events = new AsyncEventQueue<AgentEvent>();
    let cancelled = false;
    let cancelReason: string | undefined;
    let terminalEventSeen = false;
    const pendingInputs = new Map<string, Record<string, unknown>>();

    child.stderr.resume();

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const raw = JSON.parse(trimmed) as unknown;
        if (raw && typeof raw === 'object') {
          const record = raw as Record<string, unknown>;
          const control = record.request;
          if (record.type === 'control_request' && typeof record.request_id === 'string' && control && typeof control === 'object') {
            const input = (control as Record<string, unknown>).input;
            pendingInputs.set(record.request_id, input && typeof input === 'object' ? input as Record<string, unknown> : {});
          }
        }
        const translated = translateClaudeEvent(raw);
        const approval = translated.find((event) => event.type === 'approval.requested');
        if (approval?.type === 'approval.requested') {
          const decision = decidePermission(request.permission.mode, request.permission.maxAccess, approval.access);
          const input = pendingInputs.get(approval.requestId) ?? {};
          if (decision.outcome !== 'ask') {
            writeJsonLine(child, controlResponse(approval.requestId, decision.outcome === 'allow'
              ? { behavior: 'allow', updatedInput: input }
              : { behavior: 'deny', message: decision.reason }));
            pendingInputs.delete(approval.requestId);
            return;
          }
        }
        for (const event of translated) {
          if (event.type === 'run.completed' || event.type === 'run.failed') terminalEventSeen = true;
          events.push(event);
          if (event.type === 'run.completed' || event.type === 'run.failed') {
            events.end();
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          }
        }
      } catch {
        // Claude may print non-JSON diagnostics; stderr/exit code remains authoritative.
      }
    });

    child.once('error', (error) => {
      terminalEventSeen = true;
      events.push({ type: 'run.failed', message: `failed to start Claude Code: ${error.message}`, code: 'spawn_failed' });
      events.end();
    });
    child.once('exit', (code, signal) => {
      lines.close();
      if (cancelled) {
        events.push({ type: 'run.cancelled', reason: cancelReason });
      } else if (!terminalEventSeen && code !== 0) {
        events.push({
          type: 'run.failed',
          message: `Claude Code exited with ${signal ?? `code ${code ?? 'unknown'}`}`,
          code: 'process_exit',
        });
      } else if (!terminalEventSeen) {
        events.push({ type: 'run.failed', message: 'Claude Code exited without a result event', code: 'missing_result' });
      }
      events.end();
    });

    child.stdin.once('error', () => undefined);
    writeJsonLine(child, { type: 'user', message: { role: 'user', content: request.prompt } });

    return {
      events,
      cancel: async (reason) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        cancelled = true;
        cancelReason = reason;
        await terminateProcess(child, this.stopGraceMs);
      },
      approve: async (requestId, approved) => {
        const input = pendingInputs.get(requestId) ?? {};
        writeJsonLine(child, controlResponse(requestId, approved
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'The user denied this tool use.' }));
        pendingInputs.delete(requestId);
      },
      answer: async (questionId, answer) => {
        const input = pendingInputs.get(questionId) ?? {};
        const questions = Array.isArray(input.questions) ? input.questions : [];
        const first = questions[0] as Record<string, unknown> | undefined;
        const key = first && typeof first.question === 'string' ? first.question : 'answer';
        writeJsonLine(child, controlResponse(questionId, { behavior: 'allow', updatedInput: { ...input, answers: { [key]: answer } } }));
        pendingInputs.delete(questionId);
      },
    };
  }
}

function writeJsonLine(child: ChildProcessWithoutNullStreams, value: unknown): void {
  if (!child.stdin.writable) throw new Error('Claude stdin is not writable');
  child.stdin.write(`${JSON.stringify(value)}\n`, 'utf8');
}

function controlResponse(requestId: string, response: Record<string, unknown>): object {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}
