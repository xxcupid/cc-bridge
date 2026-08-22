import { createInterface } from 'node:readline';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import spawn from 'cross-spawn';
import type { AccessLevel, AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest, RunMetrics } from '../../domain/agent.js';
import { decidePermission } from '../../domain/permission.js';
import { AsyncEventQueue } from '../shared/async-event-queue.js';
import { terminateProcess } from '../shared/terminate-process.js';

export interface CodexAppServerAdapterOptions { binary?: string; stopGraceMs?: number; requestTimeoutMs?: number; spawnProcess?: typeof spawn; }
type RpcId = string | number;
interface PendingRpc { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; }
interface PendingInteraction { id: RpcId; method: string; params: Record<string, unknown>; questionId?: string; }

const SANDBOX: Record<AccessLevel, string> = { 'read-only': 'read-only', workspace: 'workspace-write', full: 'danger-full-access' };

export class CodexAppServerAdapter implements AgentAdapter {
  readonly id = 'codex' as const;
  private readonly binary: string;
  private readonly stopGraceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  constructor(options: CodexAppServerAdapterOptions = {}) {
    this.binary = options.binary ?? 'codex'; this.stopGraceMs = options.stopGraceMs ?? 5_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000; this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const child = this.spawnProcess(this.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: request.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    const events = new AsyncEventQueue<AgentEvent>();
    const pending = new Map<number, PendingRpc>();
    const interactions = new Map<string, PendingInteraction>();
    const streamedTextItems = new Set<string>();
    const streamedReasoningItems = new Set<string>();
    let nextId = 1; let threadId = ''; let turnId = ''; let terminal = false; let cancelled = false; let cancelReason: string | undefined;
    let metrics: RunMetrics = {}; let modelProvider = '';
    child.stderr.resume();

    const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const rpc = (method: string, params: unknown): Promise<unknown> => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex app-server ${method} timed out`)); }, this.requestTimeoutMs);
      pending.set(id, { resolve, reject, timer }); write({ jsonrpc: '2.0', id, method, params });
    });
    const reply = (id: RpcId, result: unknown) => write({ jsonrpc: '2.0', id, result });
    const failAll = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
    const finish = (event: AgentEvent) => { if (terminal) return; terminal = true; events.push(event); events.end(); };

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      if (message.id !== undefined && message.method === undefined) {
        const id = typeof message.id === 'number' ? message.id : Number(message.id);
        const waiter = pending.get(id); if (!waiter) return;
        pending.delete(id); clearTimeout(waiter.timer);
        if (isRecord(message.error)) waiter.reject(new Error(text(message.error.message) ?? 'Codex app-server RPC error'));
        else waiter.resolve(message.result);
        return;
      }
      if (message.id !== undefined && typeof message.method === 'string') {
        handleServerRequest(message.id as RpcId, message.method, record(message.params) ?? {});
        return;
      }
      if (typeof message.method === 'string') handleNotification(message.method, record(message.params) ?? {});
    });

    const handleServerRequest = (id: RpcId, method: string, params: Record<string, unknown>) => {
      const requestId = String(id);
      if (method === 'item/tool/requestUserInput') {
        const questions = Array.isArray(params.questions) ? params.questions.filter(isRecord) : [];
        const first = questions[0]; const questionId = text(first?.id) ?? requestId;
        const options = Array.isArray(first?.options) ? first.options.filter(isRecord).map((item) => text(item.label)).filter((item): item is string => Boolean(item)) : [];
        interactions.set(requestId, { id, method, params, questionId });
        events.push({ type: 'question.requested', questionId: requestId, prompt: text(first?.question) ?? 'Codex 需要你的输入', ...(options.length ? { options } : {}) });
        return;
      }
      const access = approvalAccess(method);
      if (!access) { reply(id, { success: false, contentItems: [{ type: 'inputText', text: 'tool not available on this client' }] }); return; }
      const decision = decidePermission(request.permission.mode, request.permission.maxAccess, access);
      if (decision.outcome === 'deny') { replyApproval(id, method, false, params); return; }
      if (decision.outcome === 'allow') { replyApproval(id, method, true, params); return; }
      interactions.set(requestId, { id, method, params });
      events.push({ type: 'approval.requested', requestId, action: approvalAction(method), access, details: redactApprovalDetails(method, params) });
    };
    const replyApproval = (id: RpcId, method: string, approved: boolean, params: Record<string, unknown>) => {
      if (method === 'item/permissions/requestApproval') reply(id, approved ? { permissions: params.permissions ?? {}, scope: 'turn' } : { permissions: {} });
      else reply(id, { decision: approved ? 'accept' : 'decline' });
    };
    const handleNotification = (method: string, params: Record<string, unknown>) => {
      if (method === 'item/started') {
        const item = record(params.item); if (!item) return;
        const id = text(item.id) ?? `tool-${Date.now()}`; const type = text(item.type);
        if (type === 'commandExecution') events.push({ type: 'tool.started', toolCallId: id, name: 'Bash', input: { command: text(item.command) ?? '' } });
        else if (type === 'fileChange') events.push({ type: 'tool.started', toolCallId: id, name: 'Patch', input: item.changes });
        else if (type === 'webSearch') events.push({ type: 'tool.started', toolCallId: id, name: 'WebSearch', input: { query: text(item.query) ?? '' } });
        else if (type === 'mcpToolCall') events.push({ type: 'tool.started', toolCallId: id, name: `MCP:${text(item.server) ?? ''}:${text(item.tool) ?? ''}`, input: item.arguments });
      } else if (method === 'item/completed') {
        const item = record(params.item); if (!item) return; const type = text(item.type); const id = text(item.id) ?? `tool-${Date.now()}`;
        if (type === 'agentMessage') { const value = text(item.text); if (value && !streamedTextItems.has(id)) events.push({ type: 'text.delta', text: value }); }
        else if (type === 'reasoning') { const value = extractText(item.summary ?? item.content); if (value && !streamedReasoningItems.has(id)) events.push({ type: 'thinking.delta', text: value }); }
        else if (['commandExecution', 'fileChange', 'webSearch', 'mcpToolCall'].includes(type ?? '')) events.push({ type: 'tool.completed', toolCallId: id, output: item.aggregatedOutput ?? item.output, isError: ['failed', 'declined'].includes(text(item.status) ?? '') });
      } else if (method === 'item/agentMessage/delta') {
        const value = text(params.delta); const id = text(params.itemId) ?? text(params.item_id) ?? 'agent-message';
        if (value) { streamedTextItems.add(id); events.push({ type: 'text.delta', text: value }); }
      } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta' || method === 'item/plan/delta') {
        const value = text(params.delta); const id = text(params.itemId) ?? text(params.item_id) ?? 'reasoning';
        if (value) { streamedReasoningItems.add(id); events.push({ type: 'thinking.delta', text: value }); }
      } else if (method === 'thread/tokenUsage/updated') {
        if (!belongsToCurrentTurn(params, threadId, turnId)) return;
        const tokenUsage = record(params.tokenUsage); const last = record(tokenUsage?.last);
        if (!last) return;
        const input = numeric(last.inputTokens); const cached = numeric(last.cachedInputTokens); const cacheWrite = numeric(last.cacheWriteInputTokens);
        metrics = {
          ...metrics,
          ...(input != null ? { inputTokens: Math.max(0, input - (cached ?? 0) - (cacheWrite ?? 0)) } : {}),
          ...(numeric(last.outputTokens) != null ? { outputTokens: numeric(last.outputTokens) } : {}),
          ...(cached != null ? { cacheReadTokens: cached } : {}),
          ...(cacheWrite != null ? { cacheWriteTokens: cacheWrite } : {}),
          ...(numeric(last.totalTokens) != null ? { totalTokens: numeric(last.totalTokens) } : {}),
          ...(numeric(tokenUsage?.modelContextWindow) != null ? { contextTokens: numeric(tokenUsage?.modelContextWindow) } : {}),
        };
        events.push({ type: 'metrics.updated', metrics: { ...metrics } });
      } else if (method === 'thread/settings/updated') {
        if (text(params.threadId) && text(params.threadId) !== threadId) return;
        const settings = record(params.threadSettings); const model = text(settings?.model);
        modelProvider = text(settings?.modelProvider) ?? modelProvider;
        if (model) { metrics = { ...metrics, model: qualifiedModel(modelProvider, model) }; events.push({ type: 'metrics.updated', metrics: { model: metrics.model } }); }
      } else if (method === 'model/rerouted') {
        if (!belongsToCurrentTurn(params, threadId, turnId)) return;
        const model = text(params.toModel);
        if (model) { metrics = { ...metrics, model: qualifiedModel(modelProvider, model) }; events.push({ type: 'metrics.updated', metrics: { model: metrics.model } }); }
      } else if (method === 'turn/completed') {
        const turn = record(params.turn); const status = text(turn?.status);
        if (status === 'failed') finish({ type: 'run.failed', message: text(record(turn?.error)?.message) ?? 'Codex turn failed' });
        else if (status === 'interrupted' || cancelled) finish({ type: 'run.cancelled', ...(cancelReason ? { reason: cancelReason } : {}) });
        else finish({ type: 'run.completed', nativeSessionId: threadId, metrics });
        void terminateProcess(child, this.stopGraceMs);
      } else if (method === 'error') {
        finish({ type: 'run.failed', message: text(params.message) ?? 'Codex app-server error' });
        void terminateProcess(child, this.stopGraceMs);
      }
    };

    child.once('error', (error) => { failAll(error); finish({ type: 'run.failed', message: `failed to start Codex app-server: ${error.message}` }); });
    child.once('exit', (code, signal) => {
      lines.close(); failAll(new Error(`Codex app-server exited with ${signal ?? `code ${code ?? 'unknown'}`}`));
      if (!terminal) finish(cancelled ? { type: 'run.cancelled', ...(cancelReason ? { reason: cancelReason } : {}) } : { type: 'run.failed', message: 'Codex app-server exited unexpectedly' });
    });

    const initialized = await rpc('initialize', { clientInfo: { name: 'oscar-lark-bridge', title: 'Oscar Lark Bridge', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    void initialized; write({ jsonrpc: '2.0', method: 'initialized', params: {} });
    const threadParams = { cwd: request.cwd, approvalPolicy: request.permission.mode === 'default' ? 'on-request' : 'never', sandbox: SANDBOX[request.permission.maxAccess], experimentalRawEvents: false, persistExtendedHistory: Boolean(request.resumeId), ...(request.model ? { model: request.model } : {}) };
    const thread = await rpc(request.resumeId ? 'thread/resume' : 'thread/start', request.resumeId ? { ...threadParams, threadId: request.resumeId } : threadParams);
    const threadResult = record(thread);
    threadId = text(record(threadResult?.thread)?.id) ?? '';
    if (!threadId) throw new Error('Codex app-server returned an empty thread id');
    modelProvider = text(threadResult?.modelProvider) ?? '';
    const selectedModel = text(threadResult?.model) ?? request.model;
    if (selectedModel) metrics = { ...metrics, model: qualifiedModel(modelProvider, selectedModel) };
    events.push({ type: 'session.started', nativeSessionId: threadId });
    const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: request.prompt, text_elements: [] }], approvalPolicy: threadParams.approvalPolicy, ...(request.model ? { model: request.model } : {}) });
    turnId = text(record(record(turn)?.turn)?.id) ?? '';
    if (!turnId) throw new Error('Codex app-server returned an empty turn id');

    return {
      events,
      cancel: async (reason) => {
        if (terminal) return; cancelled = true; cancelReason = reason;
        try { await rpc('turn/interrupt', { threadId, turnId }); } catch { /* process termination below is authoritative */ }
        await terminateProcess(child, this.stopGraceMs);
      },
      approve: async (requestId, approved) => {
        const interaction = interactions.get(requestId); if (!interaction || interaction.method === 'item/tool/requestUserInput') throw new Error(`no pending Codex approval: ${requestId}`);
        interactions.delete(requestId); replyApproval(interaction.id, interaction.method, approved, interaction.params);
      },
      answer: async (requestId, answer) => {
        const interaction = interactions.get(requestId); if (!interaction || interaction.method !== 'item/tool/requestUserInput') throw new Error(`no pending Codex question: ${requestId}`);
        interactions.delete(requestId); reply(interaction.id, { answers: { [interaction.questionId ?? requestId]: { answers: [answer] } } });
      },
    };
  }
}

function approvalAccess(method: string): AccessLevel | undefined {
  if (method === 'item/fileChange/requestApproval') return 'workspace';
  if (method === 'item/commandExecution/requestApproval' || method === 'item/permissions/requestApproval') return 'full';
  return undefined;
}
function approvalAction(method: string): string { return method === 'item/fileChange/requestApproval' ? 'Patch' : method === 'item/commandExecution/requestApproval' ? 'Bash' : 'Permissions'; }
function redactApprovalDetails(method: string, params: Record<string, unknown>): unknown {
  if (method === 'item/commandExecution/requestApproval') return { command: text(params.command) ?? '', cwd: text(params.cwd) ?? '' };
  if (method === 'item/fileChange/requestApproval') return { reason: text(params.reason) ?? '' };
  return { requested: true };
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function record(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function text(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined; }
function numeric(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : undefined; }
function qualifiedModel(provider: string, model: string): string { return provider && !model.includes('/') ? `${provider}/${model}` : model; }
function belongsToCurrentTurn(params: Record<string, unknown>, threadId: string, turnId: string): boolean {
  const eventThreadId = text(params.threadId); const eventTurnId = text(params.turnId);
  return (!eventThreadId || eventThreadId === threadId) && (!eventTurnId || !turnId || eventTurnId === turnId);
}
function extractText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) { const joined = value.map((item) => typeof item === 'string' ? item : text(record(item)?.text) ?? '').filter(Boolean).join('\n'); return joined || undefined; }
  return text(record(value)?.text);
}
