import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/domain/agent.js';
import type { ChannelPort } from '../src/channel/port.js';
import { StreamingCardPresenter } from '../src/presentation/streaming-card-presenter.js';

describe('StreamingCardPresenter', () => {
  it('streams normalized agent events into one card', async () => {
    const cards: object[] = [];
    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async sendMarkdown() {},
      async streamCard(_chat, initial, producer) {
        cards.push(initial);
        await producer({ messageId: 'card-1', async update(card) { cards.push(card); } });
        return { messageId: 'card-1' };
      },
    };
    async function* events(): AsyncIterable<AgentEvent> {
      yield { type: 'text.delta', text: 'Hi' };
      yield { type: 'run.completed' };
    }
    await new StreamingCardPresenter(channel, 0).present('run-1', 'scope-1', {
      messageId: 'm1', chatId: 'c1', chatType: 'p2p', senderId: 'u1', content: 'hello',
    }, events());
    expect(JSON.stringify(cards.at(-1))).toContain('Hi');
    expect(JSON.stringify(cards.at(-1))).toContain('已完成');
  });
});
