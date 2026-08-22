import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../src/approval/approval-store.js';
import { AgentRegistry } from '../src/application/agent-registry.js';
import { BridgeApplication } from '../src/application/bridge-application.js';
import type { CardController, ChannelPort, StreamCardOptions } from '../src/channel/port.js';
import type { AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest } from '../src/domain/agent.js';
import type { CardAction, IncomingMessage } from '../src/domain/message.js';
import { SessionStore } from '../src/session/session-store.js';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';

describe('BridgeApplication Session concurrency', () => {
  it('runs different named Sessions concurrently in the same chat', async () => {
    const channel = new ConcurrencyChannel();
    const adapter = new ControlledAdapter();
    const app = await createApp(channel, adapter);

    await channel.emit(command('/new alpha', 'new-alpha'));
    const alphaRun = channel.emit(prompt('alpha task', 'alpha-task'));
    await adapter.waitForStarts(1);

    await channel.emit(command('/new beta', 'new-beta'));
    const betaRun = channel.emit(prompt('beta task', 'beta-task'));
    await adapter.waitForStarts(2);

    expect(adapter.requests[0]?.sessionId).not.toBe(adapter.requests[1]?.sessionId);
    expect(adapter.cancelReasons).toEqual([]);

    adapter.complete(1);
    await betaRun;
    adapter.complete(0);
    await alphaRun;
    await app.stop();
  });

  it('keeps runs in the same Session serial', async () => {
    const channel = new ConcurrencyChannel();
    const adapter = new ControlledAdapter();
    const app = await createApp(channel, adapter);

    await channel.emit(command('/new alpha', 'new-alpha'));
    const first = channel.emit(prompt('first', 'first'));
    await adapter.waitForStarts(1);
    const second = channel.emit(prompt('second', 'second'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(adapter.requests).toHaveLength(1);

    adapter.complete(0);
    await first;
    await adapter.waitForStarts(2);
    adapter.complete(1);
    await second;
    expect(adapter.requests[0]?.sessionId).toBe(adapter.requests[1]?.sessionId);
    await app.stop();
  });
});

async function createApp(channel: ConcurrencyChannel, adapter: AgentAdapter): Promise<BridgeApplication> {
  const dir = await mkdtemp(join(tmpdir(), 'oscar-concurrency-'));
  const agents = new AgentRegistry();
  agents.register(adapter);
  const app = new BridgeApplication({
    channel,
    agents,
    defaultAgent: 'claude',
    defaultWorkspace: dir,
    permission: { mode: 'default', maxAccess: 'workspace' },
    cardThrottleMs: 0,
    runTimeoutMs: 0,
    sessions: new SessionStore(join(dir, 'sessions.json')),
    workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
    approvals: new ApprovalStore(join(dir, 'approvals.json')),
  });
  await app.start();
  return app;
}

function command(content: string, messageId: string): IncomingMessage { return prompt(content, messageId); }
function prompt(content: string, messageId: string): IncomingMessage {
  return { messageId, chatId: 'chat-1', chatType: 'p2p', senderId: 'user-1', content };
}

class ConcurrencyChannel implements ChannelPort {
  private messageHandler?: (message: IncomingMessage) => Promise<void>;
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void { this.messageHandler = handler; }
  onCardAction(_handler: (action: CardAction) => Promise<Record<string, unknown> | undefined>): void {}
  async streamCard(_chatId: string, _initial: object, producer: (controller: CardController) => Promise<void>, _options?: StreamCardOptions) {
    await producer({ messageId: 'card', update: async () => {} });
    return { messageId: 'card' };
  }
  async sendMarkdown(): Promise<void> {}
  async addReaction(messageId: string): Promise<string> { return `reaction-${messageId}`; }
  async removeReaction(): Promise<void> {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  emit(message: IncomingMessage): Promise<void> { return this.messageHandler!(message); }
}

class ControlledAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  requests: AgentRunRequest[] = [];
  cancelReasons: Array<string | undefined> = [];
  private completions: Array<(() => void) | undefined> = [];

  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const index = this.requests.length;
    this.requests.push(request);
    const finished = new Promise<void>((resolve) => { this.completions[index] = resolve; });
    const events = async function* (): AsyncIterable<AgentEvent> {
      await finished;
      yield { type: 'run.completed' };
    };
    return {
      events: events(),
      cancel: async (reason) => { this.cancelReasons.push(reason); this.completions[index]?.(); },
      approve: async () => {},
      answer: async () => {},
    };
  }

  complete(index: number): void { this.completions[index]?.(); }
  async waitForStarts(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.requests.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`expected ${count} Agent starts, got ${this.requests.length}`);
  }
}
