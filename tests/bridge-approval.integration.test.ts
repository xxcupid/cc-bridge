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

describe('BridgeApplication approval flow', () => {
  it('replaces raw approval data with an operator-bound, one-time token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-bridge-'));
    const channel = new FakeChannel();
    const adapter = new ApprovalAdapter();
    const agents = new AgentRegistry(); agents.register(adapter);
    const app = new BridgeApplication({
      channel, agents, defaultAgent: 'claude', defaultWorkspace: dir,
      permission: { mode: 'default', maxAccess: 'workspace' }, cardThrottleMs: 0,
      sessions: new SessionStore(join(dir, 'sessions.json')),
      workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
      approvals: new ApprovalStore(join(dir, 'approvals.json')),
    });
    await app.start();
    const running = channel.emitMessage({ messageId: 'm1', chatId: 'c1', chatType: 'p2p', senderId: 'u1', content: 'edit it' });
    const token = await channel.waitForToken('approve');
    expect(token).toBeTruthy();
    expect(JSON.stringify(channel.cards)).not.toContain('req-secret');

    const denied = await channel.emitAction({ messageId: 'card', chatId: 'c1', operatorId: 'u2', value: { action: 'approve', approved: true, token } });
    expect(denied).toMatchObject({ toast: { type: 'warning' } });
    expect(adapter.decisions).toEqual([]);

    const allowed = await channel.emitAction({ messageId: 'card', chatId: 'c1', operatorId: 'u1', value: { action: 'approve', approved: true, token } });
    expect(allowed).toMatchObject({ toast: { type: 'success' } });
    await running;
    expect(adapter.decisions).toEqual([{ requestId: 'req-secret', approved: true }]);

    const replay = await channel.emitAction({ messageId: 'card', chatId: 'c1', operatorId: 'u1', value: { action: 'approve', approved: true, token } });
    expect(replay).toMatchObject({ toast: { type: 'warning' } });
    await app.stop();
  });

  it('round-trips AskUserQuestion through an operator-bound form token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-bridge-'));
    const channel = new FakeChannel();
    const adapter = new QuestionAdapter();
    const agents = new AgentRegistry(); agents.register(adapter);
    const app = new BridgeApplication({
      channel, agents, defaultAgent: 'claude', defaultWorkspace: dir,
      permission: { mode: 'default', maxAccess: 'workspace' }, cardThrottleMs: 0,
      sessions: new SessionStore(join(dir, 'sessions.json')),
      workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
      approvals: new ApprovalStore(join(dir, 'approvals.json')),
    });
    await app.start();
    const running = channel.emitMessage({ messageId: 'm2', chatId: 'c1', chatType: 'p2p', senderId: 'u1', content: 'ask me' });
    const token = await channel.waitForToken('answer');
    expect(JSON.stringify(channel.cards)).not.toContain('question-secret');

    const denied = await channel.emitAction({ messageId: 'card', chatId: 'c1', operatorId: 'u2', value: { action: 'answer', token }, formValue: { answer: 'B' } });
    expect(denied).toMatchObject({ toast: { type: 'warning' } });
    const accepted = await channel.emitAction({ messageId: 'card', chatId: 'c1', operatorId: 'u1', value: undefined, actionName: `agent_question_submit_${token}`, formValue: { answer: 'B' } });
    expect(accepted).toMatchObject({ toast: { type: 'success' } });
    await running;
    expect(adapter.answers).toEqual([{ questionId: 'question-secret', answer: 'B' }]);
    await app.stop();
  });
});

class FakeChannel implements ChannelPort {
  cards: object[] = [];
  private messageHandler?: (message: IncomingMessage) => Promise<void>;
  private actionHandler?: (action: CardAction) => Promise<Record<string, unknown> | undefined>;
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void { this.messageHandler = handler; }
  onCardAction(handler: (action: CardAction) => Promise<Record<string, unknown> | undefined>): void { this.actionHandler = handler; }
  async streamCard(_chatId: string, initial: object, producer: (controller: CardController) => Promise<void>, _options?: StreamCardOptions) {
    this.cards.push(initial);
    await producer({ messageId: 'card', update: async (card) => { this.cards.push(card); } });
    return { messageId: 'card' };
  }
  async sendMarkdown(): Promise<void> {}
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  emitMessage(message: IncomingMessage): Promise<void> { return this.messageHandler!(message); }
  emitAction(action: CardAction) { return this.actionHandler!(action); }
  async waitForToken(action: 'approve' | 'answer'): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const match = JSON.stringify(this.cards).match(new RegExp(`"action":"${action}"[^}]*"token":"([^"]+)"`));
      if (match?.[1]) return match[1];
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('approval token was not rendered');
  }
}

class ApprovalAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  decisions: Array<{ requestId: string; approved: boolean }> = [];
  private resolve?: () => void;
  async start(_request: AgentRunRequest): Promise<AgentRunHandle> {
    const wait = new Promise<void>((resolve) => { this.resolve = resolve; });
    const events = async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'approval.requested', requestId: 'req-secret', action: 'Edit', access: 'workspace', details: { path: '/private/file' } };
      await wait;
      yield { type: 'run.completed' };
    };
    return {
      events: events(), cancel: async () => {},
      approve: async (requestId, approved) => { this.decisions.push({ requestId, approved }); this.resolve?.(); },
      answer: async () => {},
    };
  }
}

class QuestionAdapter implements AgentAdapter {
  readonly id = 'claude' as const;
  answers: Array<{ questionId: string; answer: string }> = [];
  private resolve?: () => void;
  async start(_request: AgentRunRequest): Promise<AgentRunHandle> {
    const wait = new Promise<void>((resolve) => { this.resolve = resolve; });
    const events = async function* (): AsyncIterable<AgentEvent> {
      yield { type: 'question.requested', questionId: 'question-secret', prompt: 'Choose', options: ['A', 'B'] };
      await wait;
      yield { type: 'run.completed' };
    };
    return {
      events: events(), cancel: async () => {}, approve: async () => {},
      answer: async (questionId, answer) => { this.answers.push({ questionId, answer }); this.resolve?.(); },
    };
  }
}
