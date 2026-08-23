import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ApprovalStore } from '../src/approval/approval-store.js';
import { AgentRegistry } from '../src/application/agent-registry.js';
import { BridgeApplication } from '../src/application/bridge-application.js';
import type { CardController, ChannelPort, StreamCardOptions } from '../src/channel/port.js';
import type { AgentAdapter, AgentRunHandle, AgentRunRequest } from '../src/domain/agent.js';
import type { CardAction, IncomingMessage } from '../src/domain/message.js';
import { SessionStore } from '../src/session/session-store.js';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';

describe('BridgeApplication help flow', () => {
  it('keeps /help out of the Agent and routes safe card shortcuts in the original topic scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-help-'));
    const channel = new HelpChannel();
    const adapter = new UnexpectedAdapter();
    const sessions = new SessionStore(join(dir, 'sessions.json'));
    const agents = new AgentRegistry();
    agents.register(adapter);
    const app = new BridgeApplication({
      channel,
      agents,
      defaultAgent: 'claude',
      defaultWorkspace: dir,
      permission: { mode: 'default', maxAccess: 'workspace' },
      sessions,
      workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
      approvals: new ApprovalStore(join(dir, 'approvals.json')),
    });

    await app.start();
    await channel.emitMessage({ messageId: 'm-help', chatId: 'c1', chatType: 'group', threadId: 't1', senderId: 'u1', content: '/help' });
    expect(adapter.starts).toBe(0);
    expect(channel.cards).toHaveLength(1);

    const result = await channel.emitAction({
      messageId: 'help-card', chatId: 'c1', operatorId: 'u1',
      value: { action: 'help.command', command: '/new', threadId: 't1' },
    });
    expect(result).toMatchObject({ toast: { type: 'success' } });
    expect(sessions.active('c1:t1')).toBeDefined();
    expect(adapter.starts).toBe(0);
    await app.stop();
  });
});

class HelpChannel implements ChannelPort {
  cards: object[] = [];
  private messageHandler?: (message: IncomingMessage) => Promise<void>;
  private actionHandler?: (action: CardAction) => Promise<Record<string, unknown> | undefined>;
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void { this.messageHandler = handler; }
  onCardAction(handler: (action: CardAction) => Promise<Record<string, unknown> | undefined>): void { this.actionHandler = handler; }
  async streamCard(_chatId: string, _initial: object, _producer: (controller: CardController) => Promise<void>, _options?: StreamCardOptions) { return { messageId: 'stream' }; }
  async sendCard(_chatId: string, card: object): Promise<{ messageId: string }> { this.cards.push(card); return { messageId: 'help-card' }; }
  async sendMarkdown(): Promise<void> {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  emitMessage(message: IncomingMessage): Promise<void> { return this.messageHandler!(message); }
  emitAction(action: CardAction) { return this.actionHandler!(action); }
}

class UnexpectedAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  starts = 0;
  async start(_request: AgentRunRequest): Promise<AgentRunHandle> {
    this.starts += 1;
    throw new Error('/help must not reach the Agent');
  }
}
