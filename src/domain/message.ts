export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  content: string;
  threadId?: string;
}

export interface CardAction {
  messageId: string;
  chatId: string;
  operatorId: string;
  value: unknown;
  formValue?: Record<string, unknown>;
}

export function messageScope(message: IncomingMessage): string {
  return [message.chatId, message.threadId].filter(Boolean).join(':');
}
