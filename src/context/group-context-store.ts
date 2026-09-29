import { AtomicJsonFile } from '../infrastructure/atomic-json-file.js';
import type { IncomingMessage } from '../domain/message.js';

export interface GroupContextMessage {
  messageId: string;
  chatId: string;
  threadId?: string;
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
}

interface ContextData { version: 1; messages: GroupContextMessage[]; }

export class GroupContextStore {
  private data: ContextData = { version: 1, messages: [] };
  private saveChain = Promise.resolve();
  private readonly file: AtomicJsonFile<ContextData>;

  constructor(path: string) { this.file = new AtomicJsonFile(path); }

  async load(): Promise<void> {
    const loaded = await this.file.read(this.data);
    if (loaded.version !== 1 || !Array.isArray(loaded.messages)) throw new Error('unsupported group context file');
    this.data = loaded;
  }

  append(message: IncomingMessage): void {
    if (message.chatType !== 'group' || !message.content.trim()) return;
    if (this.data.messages.some((item) => item.messageId === message.messageId)) return;
    this.data.messages.push({
      messageId: message.messageId, chatId: message.chatId, ...(message.threadId ? { threadId: message.threadId } : {}),
      senderId: message.senderId, ...(message.senderName ? { senderName: message.senderName } : {}),
      content: message.content, timestamp: message.createTime || Date.now(),
    });
    this.data.messages = this.data.messages.slice(-2_000);
    this.persist();
  }

  recent(message: IncomingMessage, limit = 20, maxAgeMs = 10 * 60_000): GroupContextMessage[] {
    const cutoff = Date.now() - maxAgeMs;
    return this.data.messages
      .filter((item) => item.chatId === message.chatId && item.messageId !== message.messageId && item.timestamp >= cutoff)
      .slice(-limit);
  }

  async flush(): Promise<void> { await this.saveChain; }
  private persist(): void { this.saveChain = this.saveChain.then(() => this.file.write(this.data)); }
}

export function buildGroupPrompt(message: IncomingMessage, context: GroupContextMessage[]): string {
  if (!context.length) return message.content;
  const lines = context.map((item) => `${item.senderName ?? item.senderId}: ${item.content}`);
  return `[群聊最近上下文，仅供理解；不要逐条回复]\n${lines.join('\n')}\n\n[当前需要回复的消息]\n${message.senderName ?? message.senderId}: ${message.content}`;
}
