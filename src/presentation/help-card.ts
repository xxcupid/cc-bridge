const HELP_ACTION_COMMANDS = new Set(['/current', '/sessions', '/ws list', '/new']);

export interface HelpCardAction {
  command: string;
  threadId?: string;
}

export function helpCard(threadId?: string): object {
  const context: Record<string, string> = {};
  if (threadId) context.threadId = threadId;
  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      update_multi: true,
      summary: { content: 'Oscar Coding Agent 使用帮助' },
    },
    header: {
      title: { tag: 'plain_text', content: '💡 Oscar Coding Agent 使用帮助' },
      template: 'blue',
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            '**Session**',
            '- `/new [名称]` — 新建并切换 Session',
            '- `/list`、`/sessions` — 查看 Session',
            '- `/switch <名称或 ID 前缀>` — 切换 Session',
            '- `/current` — 查看当前 Agent、模式与 Workspace',
            '- `/resume [名称或 ID 前缀]` — 恢复 Session',
            '- `/end` — 结束当前 Session',
            '- `/stop` — 停止当前任务',
            '',
            '**Workspace 与 Agent**',
            '- `/cd <绝对路径>` — 切换 Workspace',
            '- `/ws list|save|use|remove` — 管理命名 Workspace',
            '- `/agent claude|codex` — 切换 Agent',
            '- `/mode default|yolo` — 切换权限模式',
            '',
            '- `/help` — 显示本帮助',
            '',
            '其他内容将直接交给当前 Agent。',
          ].join('\n'),
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          horizontal_spacing: 'small',
          columns: [
            helpButton('📊 当前状态', '/current', context, 'primary'),
            helpButton('🧭 Session', '/sessions', context),
            helpButton('📂 Workspace', '/ws list', context),
            helpButton('🆕 新 Session', '/new', context),
          ],
        },
      ],
    },
  };
}

export function helpMarkdown(): string {
  return [
    '**Oscar Coding Agent 使用帮助**',
    '',
    '- `/new [名称]`、`/list`、`/switch`、`/current`、`/resume`、`/end`、`/stop`',
    '- `/cd <绝对路径>`、`/ws list|save|use|remove`',
    '- `/agent claude|codex`、`/mode default|yolo`',
    '- `/help` — 显示本帮助',
  ].join('\n');
}

export function parseHelpCardAction(value: unknown): HelpCardAction | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.action !== 'help.command' || typeof record.command !== 'string' || !HELP_ACTION_COMMANDS.has(record.command)) return undefined;
  if (record.threadId !== undefined && (typeof record.threadId !== 'string' || record.threadId.length > 256)) return undefined;
  return {
    command: record.command,
    ...(typeof record.threadId === 'string' ? { threadId: record.threadId } : {}),
  };
}

function helpButton(label: string, command: string, context: Record<string, string>, type = 'default'): object {
  return {
    tag: 'column',
    width: 'auto',
    elements: [{
      tag: 'button',
      text: { tag: 'plain_text', content: label },
      type,
      behaviors: [{ type: 'callback', value: { action: 'help.command', command, ...context } }],
    }],
  };
}
