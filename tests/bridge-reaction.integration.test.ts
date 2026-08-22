import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from '../src/approval/approval-store.js';
import { AgentRegistry } from '../src/application/agent-registry.js';
import { BridgeApplication } from '../src/application/bridge-application.js';
import type { CardController, ChannelPort, StreamCardOptions } from '../src/channel/port.js';
import type { AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest } from '../src/domain/agent.js';
import type { CardAction, IncomingMessage } from '../src/domain/message.js';
import { SessionStore } from '../src/session/session-store.js';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';

describe('BridgeApplication working reaction', () => {
  it('adds Typing immediately and removes it after a completed run', async () => {
    const channel = new ReactionChannel();
    const app = await createApp(channel, new CompletedAdapter());

    await channel.emitMessage(message());

    expect(channel.reactions).toEqual([
      ['add', 'message-1', 'Typing'],
      ['remove', 'message-1', 'reaction-1'],
    ]);
    await app.stop();
  });

  it('removes Typing when the agent fails during startup', async () => {
    const channel = new ReactionChannel();
    const app = await createApp(channel, new FailingAdapter());

    await channel.emitMessage(message());

    expect(channel.reactions).toEqual([
      ['add', 'message-1', 'Typing'],
      ['remove', 'message-1', 'reaction-1'],
    ]);
    expect(channel.markdown).toContain('启动失败');
    await app.stop();
  });

  it('continues the agent run when adding the reaction fails', async () => {
    const channel = new ReactionChannel({ failAdd: true });
    const adapter = new CompletedAdapter();
    const app = await createApp(channel, adapter);

    await channel.emitMessage(message());

    expect(adapter.started).toBe(1);
    expect(channel.cards.length).toBeGreaterThan(0);
    expect(channel.reactions).toEqual([['add', 'message-1', 'Typing']]);
    await app.stop();
  });

  it('keeps the completed result when removing the reaction fails', async () => {
    const channel = new ReactionChannel({ failRemove: true });
    const adapter = new CompletedAdapter();
    const app = await createApp(channel, adapter);

    await channel.emitMessage(message());

    expect(adapter.started).toBe(1);
    expect(channel.cards.length).toBeGreaterThan(0);
    expect(channel.reactions).toContainEqual(['remove', 'message-1', 'reaction-1']);
    await app.stop();
  });

  it('cancels the Agent and sends a generic fallback when card presentation fails', async () => {
    const channel = new ReactionChannel({ failStream: true });
    const adapter = new CancellableAdapter();
    const app = await createApp(channel, adapter, { runTimeoutMs: 0 });

    await channel.emitMessage(message());

    expect(adapter.cancelReasons).toEqual(['card presentation failed']);
    expect(channel.markdown).toContain('流式卡片更新失败，任务已安全停止');
    expect(channel.reactions).toContainEqual(['remove', 'message-1', 'reaction-1']);
    await app.stop();
  });

  it('cancels an active Agent before disconnecting during shutdown', async () => {
    const channel = new ReactionChannel();
    const adapter = new CancellableAdapter();
    const app = await createApp(channel, adapter, { runTimeoutMs: 0 });
    const running = channel.emitMessage(message());
    await adapter.waitUntilStarted();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await app.stop();
    await running;

    expect(adapter.cancelReasons).toEqual(['bridge is shutting down']);
    expect(channel.disconnected).toBe(true);
  });

  it('cancels a run after the configured deadline', async () => {
    const channel = new ReactionChannel();
    const adapter = new CancellableAdapter();
    const app = await createApp(channel, adapter, { runTimeoutMs: 10 });

    await channel.emitMessage(message());

    expect(adapter.cancelReasons).toEqual(['run timed out after 10ms']);
    await app.stop();
  });

  it('flushes persistent state before disconnecting during shutdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-shutdown-'));
    const channel = new ReactionChannel();
    const agents = new AgentRegistry(); agents.register(new CompletedAdapter());
    const sessions = new SessionStore(join(dir, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
    const approvals = new ApprovalStore(join(dir, 'approvals.json'));
    const sessionFlush = vi.spyOn(sessions, 'flush');
    const workspaceFlush = vi.spyOn(workspaces, 'flush');
    const approvalFlush = vi.spyOn(approvals, 'flush');
    const app = new BridgeApplication({
      channel, agents, defaultAgent: 'claude', defaultWorkspace: dir,
      permission: { mode: 'default', maxAccess: 'workspace' },
      sessions, workspaces, approvals,
    });
    await app.start();
    await app.stop();

    expect(sessionFlush).toHaveBeenCalledOnce();
    expect(workspaceFlush).toHaveBeenCalledOnce();
    expect(approvalFlush).toHaveBeenCalledOnce();
    expect(channel.disconnected).toBe(true);
  });

  it('revalidates a persisted Workspace before every Agent run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oscar-workspace-drift-'));
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const channel = new ReactionChannel();
    const adapter = new CompletedAdapter();
    const app = await createApp(channel, adapter, { defaultWorkspace: workspace });

    await channel.emitMessage(message());
    expect(adapter.started).toBe(1);
    await rm(workspace, { recursive: true });
    await symlink('/', workspace, 'dir');
    await channel.emitMessage({ ...message(), messageId: 'message-2' });

    expect(adapter.started).toBe(1);
    expect(channel.markdown).toContain('Workspace 已失效或不安全');
    await app.stop();
  });
});

async function createApp(channel: ReactionChannel, adapter: AgentAdapter, options: { runTimeoutMs?: number; defaultWorkspace?: string } = {}): Promise<BridgeApplication> {
  const dir = await mkdtemp(join(tmpdir(), 'oscar-reaction-'));
  const agents = new AgentRegistry();
  agents.register(adapter);
  const app = new BridgeApplication({
    channel,
    agents,
    defaultAgent: 'claude',
    defaultWorkspace: options.defaultWorkspace ?? dir,
    permission: { mode: 'default', maxAccess: 'workspace' },
    cardThrottleMs: 0,
    sessions: new SessionStore(join(dir, 'sessions.json')),
    workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
    approvals: new ApprovalStore(join(dir, 'approvals.json')),
    ...(options.runTimeoutMs !== undefined ? { runTimeoutMs: options.runTimeoutMs } : {}),
  });
  await app.start();
  return app;
}

function message(): IncomingMessage {
  return { messageId: 'message-1', chatId: 'chat-1', chatType: 'p2p', senderId: 'user-1', content: 'hello' };
}

class ReactionChannel implements ChannelPort {
  reactions: Array<[action: 'add' | 'remove', messageId: string, value: string]> = [];
  cards: object[] = [];
  markdown = '';
  disconnected = false;
  private messageHandler?: (message: IncomingMessage) => Promise<void>;
  private actionHandler?: (action: CardAction) => Promise<Record<string, unknown> | undefined>;

  constructor(private readonly options: { failAdd?: boolean; failRemove?: boolean; failStream?: boolean } = {}) {}
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void { this.messageHandler = handler; }
  onCardAction(handler: (action: CardAction) => Promise<Record<string, unknown> | undefined>): void { this.actionHandler = handler; }
  async streamCard(_chatId: string, initial: object, producer: (controller: CardController) => Promise<void>, _options?: StreamCardOptions) {
    this.cards.push(initial);
    if (this.options.failStream) throw new Error('CardKit unavailable');
    await producer({ messageId: 'card-1', update: async (card) => { this.cards.push(card); } });
    return { messageId: 'card-1' };
  }
  async sendMarkdown(_chatId: string, markdown: string): Promise<void> { this.markdown += markdown; }
  async addReaction(messageId: string, emojiType: string): Promise<string> {
    this.reactions.push(['add', messageId, emojiType]);
    if (this.options.failAdd) throw new Error('reaction unavailable');
    return 'reaction-1';
  }
  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    this.reactions.push(['remove', messageId, reactionId]);
    if (this.options.failRemove) throw new Error('reaction cleanup unavailable');
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> { this.disconnected = true; }
  emitMessage(input: IncomingMessage): Promise<void> { return this.messageHandler!(input); }
}

class CompletedAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  started = 0;
  async start(_request: AgentRunRequest): Promise<AgentRunHandle> {
    this.started += 1;
    const events = async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'text.delta', text: 'done' };
      yield { type: 'run.completed' };
    };
    return { events: events(), cancel: async () => {}, approve: async () => {}, answer: async () => {} };
  }
}

class FailingAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  async start(_request: AgentRunRequest): Promise<AgentRunHandle> { throw new Error('spawn failed'); }
}

class CancellableAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  cancelReasons: Array<string | undefined> = [];
  private started?: () => void;
  private finish?: () => void;
  private readonly startedPromise = new Promise<void>((resolve) => { this.started = resolve; });

  waitUntilStarted(): Promise<void> { return this.startedPromise; }
  async start(_request: AgentRunRequest): Promise<AgentRunHandle> {
    const finished = new Promise<void>((resolve) => { this.finish = resolve; });
    this.started?.();
    const events = async function* (): AsyncIterable<AgentEvent> {
      await finished;
      yield { type: 'run.cancelled', reason: 'cancelled' };
    };
    return {
      events: events(),
      cancel: async (reason) => { this.cancelReasons.push(reason); this.finish?.(); },
      approve: async () => {},
      answer: async () => {},
    };
  }
}
