import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelPort } from '../src/channel/port.js';
import { CommandRouter } from '../src/application/command-router.js';
import { SessionStore } from '../src/session/session-store.js';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';

describe('CommandRouter', () => {
  it('creates, lists, switches and ends named sessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-command-'));
    const replies: string[] = [];
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async streamCard() { return { messageId: 'x' }; },
      async sendMarkdown(_chat, markdown) { replies.push(markdown); },
    };
    const sessions = new SessionStore(join(dir, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
    const router = new CommandRouter({ channel, sessions, workspaces, defaultAgent: 'claude', defaultWorkspace: dir, defaultMode: 'default', async cancelScope() { return false; } });
    const base = { messageId: 'm', chatId: 'c', chatType: 'p2p' as const, senderId: 'u' };
    await router.handle({ ...base, content: '/new alpha' });
    await router.handle({ ...base, content: '/new beta' });
    await router.handle({ ...base, content: '/switch alpha' });
    expect(sessions.active('c')?.name).toBe('alpha');
    await router.handle({ ...base, content: '/list' });
    expect(replies.at(-1)).toContain('alpha');
    await router.handle({ ...base, content: '/end' });
    expect(sessions.active('c')).toBeUndefined();
  });

  it('routes /stop to the active scope cancellation instead of the Agent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-command-'));
    const replies: string[] = [];
    const cancelled: string[] = [];
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async streamCard() { return { messageId: 'x' }; },
      async sendMarkdown(_chat, markdown) { replies.push(markdown); },
    };
    const router = new CommandRouter({
      channel,
      sessions: new SessionStore(join(dir, 'sessions.json')),
      workspaces: new WorkspaceStore(join(dir, 'workspaces.json')),
      defaultAgent: 'claude',
      defaultWorkspace: dir,
      defaultMode: 'default',
      async cancelScope(scope) { cancelled.push(scope); return true; },
    });

    expect(await router.handle({ messageId: 'm', chatId: 'c', chatType: 'p2p', senderId: 'u', content: '/stop' })).toBe(true);
    expect(cancelled).toEqual(['c']);
    expect(replies.at(-1)).toContain('正在停止');
  });

  it('selects Agent and manages named Workspaces from Feishu commands', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-command-'));
    const other = await mkdtemp(join(tmpdir(), 'oscar-workspace-'));
    const resolvedOther = await realpath(other);
    const replies: string[] = [];
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async streamCard() { return { messageId: 'x' }; },
      async sendMarkdown(_chat, markdown) { replies.push(markdown); },
    };
    const sessions = new SessionStore(join(dir, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(dir, 'workspaces.json'));
    const router = new CommandRouter({ channel, sessions, workspaces, defaultAgent: 'claude', defaultWorkspace: dir, defaultMode: 'default', async cancelScope() { return false; } });
    const base = { messageId: 'm', chatId: 'c', chatType: 'p2p' as const, senderId: 'u' };

    await router.handle({ ...base, content: `/cd ${other}` });
    await router.handle({ ...base, content: '/ws save alternate' });
    await router.handle({ ...base, content: '/agent codex' });
    await router.handle({ ...base, content: '/current' });
    expect(sessions.active('c')).toMatchObject({ agentId: 'codex', cwd: resolvedOther });
    expect(workspaces.getNamed('alternate')).toBe(resolvedOther);
    expect(replies.at(-1)).toContain('Agent：codex');

    await router.handle({ ...base, content: '/ws remove alternate' });
    expect(workspaces.getNamed('alternate')).toBeUndefined();
  });
});
