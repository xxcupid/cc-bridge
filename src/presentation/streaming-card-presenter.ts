import type { AgentEvent } from '../domain/agent.js';
import type { IncomingMessage } from '../domain/message.js';
import type { ChannelPort } from '../channel/port.js';
import { RunCardState } from './run-card.js';
import { ThrottledUpdater } from './throttled-updater.js';

export class StreamingCardPresenter {
  constructor(private readonly channel: ChannelPort, private readonly throttleMs = 400) {}

  async present(runId: string, scope: string, message: IncomingMessage, events: AsyncIterable<AgentEvent>): Promise<void> {
    const state = new RunCardState(runId, scope);
    await this.channel.streamCard(message.chatId, state.render(), async (controller) => {
      const updater = new ThrottledUpdater<object>(this.throttleMs, (card) => controller.update(card));
      for await (const event of events) {
        state.apply(event);
        updater.schedule(state.render());
      }
      await updater.flushNow();
    }, {
      replyTo: message.messageId,
      ...(message.threadId ? { replyInThread: true } : {}),
    });
  }
}
