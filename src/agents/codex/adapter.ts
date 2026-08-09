import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import spawn from 'cross-spawn';
import type { AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest } from '../../domain/agent.js';
import { AsyncEventQueue } from '../shared/async-event-queue.js';
import { buildCodexArgs } from './argv.js';
import { CodexJsonlTranslator } from './jsonl.js';
import { terminateProcess } from '../shared/terminate-process.js';

export interface CodexAdapterOptions { binary?: string; stopGraceMs?: number; spawnProcess?: typeof spawn; }

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  private readonly binary: string;
  private readonly stopGraceMs: number;
  private readonly spawnProcess: typeof spawn;

  constructor(options: CodexAdapterOptions = {}) {
    this.binary = options.binary ?? 'codex'; this.stopGraceMs = options.stopGraceMs ?? 5_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const child = this.spawnProcess(this.binary, buildCodexArgs(request), {
      cwd: request.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const events = new AsyncEventQueue<AgentEvent>();
    const translator = new CodexJsonlTranslator();
    let cancelled = false; let reason: string | undefined;
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try { for (const event of translator.translate(JSON.parse(line))) events.push(event); } catch { /* diagnostics */ }
    });
    child.once('error', (error) => { for (const event of translator.finishFailure(`failed to start Codex: ${error.message}`)) events.push(event); events.end(); });
    child.once('exit', (code, signal) => {
      lines.close();
      if (cancelled) events.push({ type: 'run.cancelled', reason });
      else if (!translator.terminalSeen()) {
        for (const event of translator.finishFailure(`Codex exited with ${signal ?? `code ${code ?? 'unknown'}`}`)) events.push(event);
      }
      events.end();
    });
    child.stdin.once('error', () => undefined); child.stdin.end(request.prompt, 'utf8');
    return {
      events,
      cancel: async (cancelReason) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        cancelled = true; reason = cancelReason;
        await terminateProcess(child, this.stopGraceMs);
      },
      approve: async () => { throw new Error('Codex exec transport does not support in-process approvals'); },
      answer: async () => { throw new Error('Codex exec transport does not support in-process questions'); },
    };
  }
}
