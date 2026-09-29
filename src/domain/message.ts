export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  content: string;
  threadId?: string;
  senderName?: string;
  senderType?: string;
  senderIsBot?: boolean;
  mentions?: Array<{ id?: string; name?: string; isBot?: boolean }>;
  mentionedBot?: boolean;
  createTime?: number;
}

export interface CardAction {
  messageId: string;
  chatId: string;
  operatorId: string;
  value: unknown;
  actionName?: string;
  formValue?: Record<string, unknown>;
}

export function messageScope(message: IncomingMessage): string {
  return [message.chatId, message.threadId].filter(Boolean).join(':');
}
