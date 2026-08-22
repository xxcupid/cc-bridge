import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentRunHandle } from '../domain/agent.js';
import { messageScope, type CardAction, type IncomingMessage } from '../domain/message.js';
import type { ChannelPort } from '../channel/port.js';
import { StreamingCardPresenter } from '../presentation/streaming-card-presenter.js';
import { AgentRegistry } from './agent-registry.js';
import { SessionLock } from './session-lock.js';
import { CommandRouter } from './command-router.js';
import { SessionStore } from '../session/session-store.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';
import { ApprovalStore } from '../approval/approval-store.js';
import { resolveWorkspace } from '../workspace/workspace-policy.js';

export interface BridgeApplicationOptions {
  channel: ChannelPort;
  agents: AgentRegistry;
  defaultAgent: 'claude' | 'codex';
  defaultWorkspace: string;
  permission: { mode: 'default' | 'yolo'; maxAccess: 'read-only' | 'workspace' | 'full' };
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  approvals: ApprovalStore;
  cardThrottleMs?: number;
  runTimeoutMs?: number;
}

export class BridgeApplication {
  private readonly locks = new SessionLock();
  private readonly activeRuns = new Map<string, { runId: string; scope: string; sessionId: string; ownerId: string; handle: AgentRunHandle }>();
  private readonly inFlightMessages = new Set<Promise<void>>();
  private readonly presenter: StreamingCardPresenter;
  private readonly commands: CommandRouter;
  private stopping = false;

  constructor(private readonly options: BridgeApplicationOptions) {
    this.presenter = new StreamingCardPresenter(options.channel, options.cardThrottleMs);
    this.commands = new CommandRouter({
      channel: options.channel, sessions: options.sessions, workspaces: options.workspaces,
      defaultAgent: options.defaultAgent, defaultWorkspace: options.defaultWorkspace,
      defaultMode: options.permission.mode, cancelScope: (scope) => this.cancelScope(scope),
    });
  }

  async start(): Promise<void> {
    this.stopping = false;
    await Promise.all([this.options.sessions.load(), this.options.workspaces.load(), this.options.approvals.load()]);
    this.options.channel.onMessage((message) => this.trackMessage(message));
    this.options.channel.onCardAction((action) => this.handleCardAction(action));
    await this.options.channel.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const handles = [...this.activeRuns.values()].map((run) => run.handle);
    await Promise.allSettled(handles.map((handle) => handle.cancel('bridge is shutting down')));
    await Promise.allSettled([...this.inFlightMessages]);
    try {
      await Promise.all([
        this.options.sessions.flush(),
        this.options.workspaces.flush(),
        this.options.approvals.flush(),
      ]);
    } finally {
      await this.options.channel.disconnect();
    }
  }

  private trackMessage(message: IncomingMessage): Promise<void> {
    const task = this.handleMessage(message);
    this.inFlightMessages.add(task);
    void task.then(
      () => this.inFlightMessages.delete(task),
      () => this.inFlightMessages.delete(task),
    );
    return task;
  }

  private async handleMessage(message: IncomingMessage): Promise<void> {
    if (this.stopping || !message.content.trim()) return;
    const scope = messageScope(message);
    if (await this.commands.handle(message)) return;
    const reactionId = await addWorkingReaction(this.options.channel, message.messageId);
    const session = this.options.sessions.active(scope) ?? this.options.sessions.create(scope, {
      agentId: this.options.defaultAgent,
      cwd: this.options.workspaces.forScope(scope) ?? this.options.defaultWorkspace,
      mode: this.options.permission.mode,
    });
    await this.locks.runExclusive(session.id, async () => {
      const workspace = await resolveWorkspace(session.cwd);
      if (!workspace.ok) {
        await removeWorkingReaction(this.options.channel, message.messageId, reactionId);
        await this.options.channel.sendMarkdown(message.chatId, `当前 Workspace 已失效或不安全：${workspace.message}\n\n请使用 \`/cd <安全的绝对路径>\` 重新选择。`, {
          replyTo: message.messageId, ...(message.threadId ? { replyInThread: true } : {}),
        });
        return;
      }
      if (workspace.path !== session.cwd) {
        this.options.sessions.updateWorkspace(session.id, workspace.path);
        this.options.workspaces.setScope(scope, workspace.path);
      }
      const runId = randomUUID();
      let handle: AgentRunHandle;
      try {
        handle = await this.options.agents.get(session.agentId).start({
          runId,
          sessionId: session.id,
          prompt: message.content,
          cwd: workspace.path,
          ...(session.nativeSessionId ? { resumeId: session.nativeSessionId } : {}),
          permission: { mode: session.mode, maxAccess: this.options.permission.maxAccess },
        });
      } catch {
        await removeWorkingReaction(this.options.channel, message.messageId, reactionId);
        await this.options.channel.sendMarkdown(message.chatId, `Agent \`${session.agentId}\` 启动失败，请运行 \`oscar-lark-bridge doctor\` 检查本机环境。`, {
          replyTo: message.messageId, ...(message.threadId ? { replyInThread: true } : {}),
        });
        return;
      }
      if (this.stopping) {
        await handle.cancel('bridge is shutting down');
        await removeWorkingReaction(this.options.channel, message.messageId, reactionId);
        return;
      }
      this.activeRuns.set(session.id, { runId, scope, sessionId: session.id, ownerId: message.senderId, handle });
      const timeoutMs = this.options.runTimeoutMs ?? 1_800_000;
      const timeout = timeoutMs > 0 ? setTimeout(() => {
        void handle.cancel(`run timed out after ${timeoutMs}ms`).catch(() => undefined);
      }, timeoutMs) : undefined;
      try {
        try {
          await this.presenter.present(runId, scope, message, this.recordSessionEvents({
            runId, sessionId: session.id, scope, operatorId: message.senderId, events: handle.events,
          }));
        } catch {
          await Promise.allSettled([
            handle.cancel('card presentation failed'),
            this.options.channel.sendMarkdown(message.chatId, '流式卡片更新失败，任务已安全停止。请稍后重试。', {
              replyTo: message.messageId, ...(message.threadId ? { replyInThread: true } : {}),
            }),
          ]);
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        await removeWorkingReaction(this.options.channel, message.messageId, reactionId);
        const active = this.activeRuns.get(session.id);
        if (active?.runId === runId) this.activeRuns.delete(session.id);
      }
    });
  }

  private async *recordSessionEvents(input: { runId: string; sessionId: string; scope: string; operatorId: string; events: AsyncIterable<AgentEvent> }) {
    for await (const event of input.events) {
      if (event.type === 'session.started') this.options.sessions.updateNativeSession(input.sessionId, event.nativeSessionId);
      if (event.type === 'approval.requested') {
        const approval = this.options.approvals.issue({
          kind: 'approval', runId: input.runId, sessionId: input.sessionId, scope: input.scope,
          operatorId: input.operatorId, requestId: event.requestId, action: event.action,
          parameters: { access: event.access, details: event.details },
        });
        yield { ...event, token: approval.token };
        continue;
      }
      if (event.type === 'question.requested') {
        const approval = this.options.approvals.issue({
          kind: 'question', runId: input.runId, sessionId: input.sessionId, scope: input.scope,
          operatorId: input.operatorId, requestId: event.questionId, action: 'AskUserQuestion',
          parameters: { prompt: event.prompt, options: event.options },
        });
        yield { ...event, token: approval.token };
        continue;
      }
      yield event;
    }
  }

  private async cancelScope(scope: string): Promise<boolean> {
    const session = this.options.sessions.active(scope);
    const active = session ? this.activeRuns.get(session.id) : undefined;
    if (!active) return false;
    await active.handle.cancel('cancelled by command');
    return true;
  }

  private async handleCardAction(action: CardAction): Promise<Record<string, unknown> | undefined> {
    const fallbackToken = action.actionName?.startsWith('agent_question_submit_') ? action.actionName.slice('agent_question_submit_'.length) : undefined;
    const value = action.value && typeof action.value === 'object'
      ? action.value as Record<string, unknown>
      : fallbackToken ? { action: 'answer', token: fallbackToken } : undefined;
    if (!value) return undefined;
    if (value.action === 'stop') {
      if (typeof value.scope !== 'string' || typeof value.runId !== 'string') return undefined;
      const active = [...this.activeRuns.values()].find((run) => run.scope === value.scope && run.runId === value.runId);
      if (!active || active.runId !== value.runId || active.ownerId !== action.operatorId) return staleAction();
      await active.handle.cancel(`stopped by ${action.operatorId}`);
      return { toast: { type: 'success', content: '正在停止任务' } };
    }
    if ((value.action === 'approve' || value.action === 'answer') && typeof value.token === 'string') {
      const pending = this.options.approvals.peek(value.token);
      if (!pending || pending.operatorId !== action.operatorId) return staleAction();
      const active = this.activeRuns.get(pending.sessionId);
      if (!active || active.runId !== pending.runId || active.sessionId !== pending.sessionId || active.ownerId !== action.operatorId) return staleAction();
      if (pending.kind === 'approval' && value.action === 'approve' && typeof value.approved === 'boolean') {
        const consumed = this.options.approvals.consume(value.token, { runId: pending.runId, scope: pending.scope, operatorId: action.operatorId });
        if (!consumed) return staleAction();
        await active.handle.approve(consumed.requestId, value.approved);
        return { toast: { type: 'success', content: value.approved ? '已允许' : '已拒绝' } };
      }
      const submittedAnswer = typeof value.answer === 'string' ? value.answer : typeof action.formValue?.answer === 'string' ? action.formValue.answer : undefined;
      if (pending.kind === 'question' && value.action === 'answer' && submittedAnswer?.trim()) {
        const consumed = this.options.approvals.consume(value.token, { runId: pending.runId, scope: pending.scope, operatorId: action.operatorId });
        if (!consumed) return staleAction();
        await active.handle.answer(consumed.requestId, submittedAnswer.trim());
        return { toast: { type: 'success', content: '回答已提交' } };
      }
      return staleAction();
    }
    return undefined;
  }
}

async function addWorkingReaction(channel: ChannelPort, messageId: string): Promise<string | undefined> {
  if (!channel.addReaction) return undefined;
  try {
    return await channel.addReaction(messageId, 'Typing');
  } catch {
    return undefined;
  }
}

async function removeWorkingReaction(channel: ChannelPort, messageId: string, reactionId: string | undefined): Promise<void> {
  if (!reactionId || !channel.removeReaction) return;
  try {
    await channel.removeReaction(messageId, reactionId);
  } catch {
    // Reaction cleanup is best effort and must not mask the agent result.
  }
}

function staleAction(): Record<string, unknown> {
  return { toast: { type: 'warning', content: '任务已结束、操作无权执行或按钮已经过期' } };
}
