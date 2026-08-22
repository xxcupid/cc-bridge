import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import type { CardAction, IncomingMessage } from '../domain/message.js';
import type { CardController, ChannelPort, StreamCardOptions } from './port.js';

export interface LarkChannelGatewayOptions {
  appId: string;
  appSecret: string;
  domain?: string;
  dmAllowlist?: string[];
  groupAllowlist?: string[];
  requireMention?: boolean;
}

export class LarkChannelGateway implements ChannelPort {
  private readonly channel: LarkChannel;

  constructor(options: LarkChannelGatewayOptions) {
    this.channel = createLarkChannel({
      appId: options.appId,
      appSecret: options.appSecret,
      ...(options.domain ? { domain: options.domain } : {}),
      source: 'oscar-lark-bridge',
      resolveChatMode: true,
      respectProxyEnv: true,
      handshakeTimeoutMs: 8_000,
      httpTimeoutMs: 30_000,
      keepalive: { enabled: true },
      policy: {
        dmMode: options.dmAllowlist?.length ? 'allowlist' : 'open',
        dmAllowlist: options.dmAllowlist ?? [],
        groupAllowlist: options.groupAllowlist ?? [],
        requireMention: options.requireMention ?? true,
        respondToMentionAll: false,
      },
      safety: {
        staleMessageWindowMs: 5 * 60_000,
        chatQueue: { enabled: false },
      },
      outbound: { streamThrottleMs: 400 },
    });
  }

  onMessage(handler: (message: IncomingMessage) => Promise<void>): void {
    this.channel.on('message', async (message) => {
      await handler({
        messageId: message.messageId,
        chatId: message.chatId,
        chatType: message.chatType,
        senderId: message.senderId,
        content: message.content,
        ...(message.threadId ? { threadId: message.threadId } : {}),
      });
    });
  }

  onCardAction(handler: (action: CardAction) => Promise<Record<string, unknown> | undefined>): void {
    this.channel.on('cardAction', async (action) => {
      const normalized = action as typeof action & { action: typeof action.action & { formValue?: Record<string, unknown>; name?: string }; raw?: { action?: { form_value?: Record<string, unknown>; name?: string } } };
      const raw = normalized.raw;
      return handler({
      messageId: action.messageId,
      chatId: action.chatId,
      operatorId: action.operator.openId,
      value: action.action.value,
      ...(normalized.action.name ?? raw?.action?.name ? { actionName: normalized.action.name ?? raw?.action?.name } : {}),
      ...(normalized.action.formValue ?? raw?.action?.form_value ? { formValue: normalized.action.formValue ?? raw?.action?.form_value } : {}),
    });
    });
  }

  async streamCard(
    chatId: string,
    initial: object,
    producer: (controller: CardController) => Promise<void>,
    options: StreamCardOptions = {},
  ): Promise<{ messageId: string }> {
    return this.channel.stream(chatId, {
      card: {
        initial,
        producer: async (controller) => producer({
          messageId: controller.messageId,
          update: async (card) => controller.update(card),
        }),
      },
    }, options);
  }

  async sendMarkdown(chatId: string, markdown: string, options: StreamCardOptions = {}): Promise<void> {
    await this.channel.send(chatId, { markdown }, options);
  }

  addReaction(messageId: string, emojiType: string): Promise<string> {
    return this.channel.addReaction(messageId, emojiType);
  }

  removeReaction(messageId: string, reactionId: string): Promise<void> {
    return this.channel.removeReaction(messageId, reactionId);
  }

  connect(): Promise<void> { return this.channel.connect(); }
  disconnect(): Promise<void> { return this.channel.disconnect(); }
}
