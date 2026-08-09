import type { CardAction, IncomingMessage } from '../domain/message.js';

export interface CardController {
  readonly messageId: string;
  update(card: object): Promise<void>;
}

export interface StreamCardOptions {
  replyTo?: string;
  replyInThread?: boolean;
}

export interface ChannelPort {
  onMessage(handler: (message: IncomingMessage) => Promise<void>): void;
  onCardAction(handler: (action: CardAction) => Promise<Record<string, unknown> | undefined>): void;
  streamCard(
    chatId: string,
    initial: object,
    producer: (controller: CardController) => Promise<void>,
    options?: StreamCardOptions,
  ): Promise<{ messageId: string }>;
  sendMarkdown(chatId: string, markdown: string, options?: StreamCardOptions): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}
