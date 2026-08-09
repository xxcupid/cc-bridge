import { mkdtemp } from 'node:fs/promises';
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
});
