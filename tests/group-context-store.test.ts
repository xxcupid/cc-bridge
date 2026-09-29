import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GroupContextStore, buildGroupPrompt } from '../src/context/group-context-store.js';

describe('GroupContextStore', () => {
  it('keeps passive group messages and builds context only for a later mention', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oscar-context-'));
    const store = new GroupContextStore(join(dir, 'group-context.json'));
    await store.load();
    store.append({ messageId: 'm1', chatId: 'c1', chatType: 'group', senderId: 'u1', senderName: 'Oscar', content: '1+1等于几？', mentionedBot: false });
    const current = { messageId: 'm2', chatId: 'c1', chatType: 'group' as const, senderId: 'u1', senderName: 'Oscar', content: '回答问题', mentionedBot: true };
    expect(buildGroupPrompt(current, store.recent(current, 20, 60_000))).toContain('1+1等于几？');
    expect(buildGroupPrompt(current, store.recent({ ...current, chatId: 'other' }, 20, 60_000))).toBe('回答问题');
  });
});
