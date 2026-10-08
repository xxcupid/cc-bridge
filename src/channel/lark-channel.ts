import { createLarkChannel, type LarkChannel } from '@larksuite/channel';
import { readOutboundFile, MAX_OUTBOUND_FILE_BYTES } from './outbound-file.js';
import type { CardAction, IncomingMessage } from '../domain/message.js';
import type { CardController, ChannelPort, FileSendOptions, StreamCardOptions } from './port.js';

export interface LarkChannelGatewayOptions {
  profile?: string;
  appId: string;
  appSecret: string;
  domain?: string;
  dmAllowlist?: string[];
  groupAllowlist?: string[];
  requireMention?: boolean;
}

export class LarkChannelGateway implements ChannelPort {
  private readonly channel: LarkChannel;
  private readonly profile: string;

  constructor(options: LarkChannelGatewayOptions) {
    this.profile = options.profile ?? 'unknown';
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
        // Receive group messages even when they do not mention this bot.
        // BridgeApplication applies the dispatch gate after passive-context capture.
        requireMention: false,
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
      console.log(`[lark-channel:${this.profile}] inbound messageId=${message.messageId} chatType=${message.chatType} chatId=${message.chatId} mentionedBot=${message.mentionedBot} content=${JSON.stringify(message.content)}`);
      await handler({
        messageId: message.messageId,
        chatId: message.chatId,
        chatType: message.chatType,
        senderId: message.senderId,
        content: message.content,
        ...(message.senderName ? { senderName: message.senderName } : {}),
        ...(message.senderType ? { senderType: message.senderType } : {}),
        ...(message.senderIsBot !== undefined ? { senderIsBot: message.senderIsBot } : {}),
        mentions: message.mentions as Array<{ id?: string; name?: string; isBot?: boolean }>,
        mentionedBot: message.mentionedBot,
        createTime: message.createTime,
        ...(message.threadId ? { threadId: message.threadId } : {}),
      });
    });
    this.channel.on('reject', (event) => {
      console.warn(`[lark-channel] message rejected: ${JSON.stringify(event)}`);
    });
    this.channel.on('error', (error) => {
      console.warn(`[lark-channel] channel error: ${String(error)}`);
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

  sendCard(chatId: string, card: object, options: StreamCardOptions = {}): Promise<{ messageId: string }> {
    return this.channel.send(chatId, { card }, options);
  }

  async sendFile(
    chatId: string,
    source: string | Buffer,
    fileName: string,
    options: FileSendOptions = {},
  ): Promise<{ messageId: string }> {
    const { allowedFileDirs, ...replyOptions } = options;
    if (!fileName.trim() || /[\x00-\x1f/\\]/.test(fileName)) throw new Error('Invalid display filename');
    const payload = typeof source === 'string'
      ? await readOutboundFile(source, allowedFileDirs ?? []) : source;
    if (payload.length === 0 || payload.length > MAX_OUTBOUND_FILE_BYTES) throw new Error('File must be non-empty and at most 30 MiB');
    return this.channel.send(chatId, { file: { source: payload, fileName } }, replyOptions);
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
