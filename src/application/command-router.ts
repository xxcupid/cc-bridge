import type { AgentId, PermissionMode } from '../domain/agent.js';
import { messageScope, type IncomingMessage } from '../domain/message.js';
import type { ChannelPort, StreamCardOptions } from '../channel/port.js';
import { SessionStore } from '../session/session-store.js';
import { resolveWorkspace } from '../workspace/workspace-policy.js';
import { WorkspaceStore } from '../workspace/workspace-store.js';

export interface CommandRouterOptions {
  channel: ChannelPort;
  sessions: SessionStore;
  workspaces: WorkspaceStore;
  defaultAgent: AgentId;
  defaultWorkspace: string;
  defaultMode: PermissionMode;
  cancelScope(scope: string): Promise<boolean>;
}

export class CommandRouter {
  constructor(private readonly options: CommandRouterOptions) {}

  async handle(message: IncomingMessage): Promise<boolean> {
    if (!message.content.startsWith('/')) return false;
    const [rawCommand = '', ...parts] = message.content.trim().split(/\s+/);
    const command = rawCommand.toLowerCase();
    const args = parts.join(' ').trim();
    const scope = messageScope(message);
    switch (command) {
      case '/new': await this.newSession(message, scope, args); break;
      case '/list': case '/sessions': await this.list(message, scope); break;
      case '/switch': await this.switch(message, scope, args); break;
      case '/current': await this.current(message, scope); break;
      case '/resume': await this.resume(message, scope, args); break;
      case '/end': await this.end(message, scope); break;
      case '/cd': await this.cd(message, scope, args); break;
      case '/ws': case '/workspace': await this.workspace(message, scope, parts); break;
      case '/agent': await this.agent(message, scope, args); break;
      case '/mode': await this.mode(message, scope, args); break;
      default: return false;
    }
    return true;
  }

  private async newSession(message: IncomingMessage, scope: string, name: string): Promise<void> {
    await this.options.cancelScope(scope);
    const current = this.options.sessions.active(scope);
    const session = this.options.sessions.create(scope, {
      name, agentId: current?.agentId ?? this.options.defaultAgent,
      cwd: this.options.workspaces.forScope(scope) ?? current?.cwd ?? this.options.defaultWorkspace,
      mode: current?.mode ?? this.options.defaultMode,
    });
    await this.reply(message, `已新建 Session：**${session.name}**\n\nID：\`${session.id.slice(0, 8)}\``);
  }

  private async list(message: IncomingMessage, scope: string): Promise<void> {
    const active = this.options.sessions.active(scope);
    const sessions = this.options.sessions.list(scope);
    if (!sessions.length) { await this.reply(message, '当前没有 Session，发送 `/new [名称]` 创建。'); return; }
    const lines = sessions.map((session, index) => `${session.id === active?.id ? '👉' : '  '} ${index + 1}. **${session.name}** · ${session.agentId} · \`${session.id.slice(0, 8)}\``);
    await this.reply(message, `**Session 列表**\n\n${lines.join('\n')}\n\n使用 \`/switch <名称或ID前缀>\` 切换。`);
  }

  private async switch(message: IncomingMessage, scope: string, target: string): Promise<void> {
    if (!target) { await this.reply(message, '用法：`/switch <名称或ID前缀>`'); return; }
    await this.options.cancelScope(scope);
    const session = this.options.sessions.switch(scope, target);
    await this.reply(message, session ? `已切换到 **${session.name}**。` : `未找到 Session：\`${target}\``);
  }

  private async current(message: IncomingMessage, scope: string): Promise<void> {
    const session = this.options.sessions.active(scope);
    if (!session) { await this.reply(message, '当前没有活动 Session。'); return; }
    await this.reply(message, `**${session.name}**\n\nAgent：${session.agentId}\n模式：${session.mode}\nWorkspace：\`${session.cwd}\`\n原生会话：${session.nativeSessionId ? `\`${session.nativeSessionId}\`` : '尚未建立'}`);
  }

  private async resume(message: IncomingMessage, scope: string, target: string): Promise<void> {
    if (target) { await this.switch(message, scope, target); return; }
    const session = this.options.sessions.active(scope);
    await this.reply(message, session?.nativeSessionId ? `当前 Session 将从 \`${session.nativeSessionId}\` 继续。` : '当前 Session 尚无可恢复的原生会话。');
  }

  private async end(message: IncomingMessage, scope: string): Promise<void> {
    await this.options.cancelScope(scope);
    const ended = this.options.sessions.end(scope);
    await this.reply(message, ended ? `已结束 Session：**${ended.name}**。` : '当前没有活动 Session。');
  }

  private async cd(message: IncomingMessage, scope: string, input: string): Promise<void> {
    if (!input) { await this.reply(message, '用法：`/cd <绝对路径或~/子目录>`'); return; }
    const resolved = await resolveWorkspace(input);
    if (!resolved.ok) { await this.reply(message, resolved.message); return; }
    await this.options.cancelScope(scope);
    this.options.workspaces.setScope(scope, resolved.path);
    let session = this.options.sessions.active(scope);
    if (!session) session = this.options.sessions.create(scope, { agentId: this.options.defaultAgent, cwd: resolved.path, mode: this.options.defaultMode });
    else this.options.sessions.updateWorkspace(session.id, resolved.path);
    await this.reply(message, `已切换 Workspace：\`${resolved.path}\`\n\n当前 Session 的原生会话已重置。`);
  }

  private async workspace(message: IncomingMessage, scope: string, parts: string[]): Promise<void> {
    const [sub = 'list', name = ''] = parts;
    if (sub === 'list') {
      const named = this.options.workspaces.listNamed();
      const lines = Object.entries(named).map(([key, value]) => `- **${key}** → \`${value}\``);
      await this.reply(message, `当前：\`${this.options.workspaces.forScope(scope) ?? this.options.defaultWorkspace}\`\n\n${lines.join('\n') || '暂无命名 Workspace。'}`); return;
    }
    if (sub === 'save') {
      if (!name) { await this.reply(message, '用法：`/ws save <名称>`'); return; }
      const cwd = this.options.workspaces.forScope(scope) ?? this.options.sessions.active(scope)?.cwd ?? this.options.defaultWorkspace;
      this.options.workspaces.saveNamed(name, cwd); await this.reply(message, `已保存 **${name}** → \`${cwd}\``); return;
    }
    if (sub === 'use') {
      const cwd = this.options.workspaces.getNamed(name);
      if (!cwd) { await this.reply(message, `未找到 Workspace：\`${name}\``); return; }
      await this.cd(message, scope, cwd); return;
    }
    if (sub === 'remove' || sub === 'rm') {
      await this.reply(message, this.options.workspaces.removeNamed(name) ? `已删除 Workspace：**${name}**。` : `未找到 Workspace：\`${name}\``); return;
    }
    await this.reply(message, '用法：`/ws [list|save <名称>|use <名称>|remove <名称>]`');
  }

  private async agent(message: IncomingMessage, scope: string, input: string): Promise<void> {
    if (input !== 'claude' && input !== 'codex') { await this.reply(message, '用法：`/agent claude|codex`'); return; }
    await this.options.cancelScope(scope);
    const session = this.ensureSession(scope); this.options.sessions.updateAgent(session.id, input);
    await this.reply(message, `已切换 Agent：**${input}**，原生会话已重置。`);
  }

  private async mode(message: IncomingMessage, scope: string, input: string): Promise<void> {
    if (input !== 'default' && input !== 'yolo') { await this.reply(message, '用法：`/mode default|yolo`'); return; }
    const session = this.ensureSession(scope); this.options.sessions.updateMode(session.id, input);
    await this.reply(message, `权限模式已切换为 **${input}**。`);
  }

  private ensureSession(scope: string) {
    return this.options.sessions.active(scope) ?? this.options.sessions.create(scope, {
      agentId: this.options.defaultAgent,
      cwd: this.options.workspaces.forScope(scope) ?? this.options.defaultWorkspace,
      mode: this.options.defaultMode,
    });
  }

  private async reply(message: IncomingMessage, markdown: string): Promise<void> {
    const options: StreamCardOptions = { replyTo: message.messageId, ...(message.threadId ? { replyInThread: true } : {}) };
    await this.options.channel.sendMarkdown(message.chatId, markdown, options);
  }
}
