/**
 * CardKit presentation adapted from concepts in ByteDance's openclaw-lark
 * card builder and tool-use display code (MIT License). This implementation
 * is rewritten for Oscar's AgentEvent model. See THIRD_PARTY_NOTICES.md.
 */
import type { AgentEvent, RunMetrics } from '../domain/agent.js';

export type CardRunStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
interface ToolStep { id: string; name: string; input?: unknown; output?: unknown; isError?: boolean; completed: boolean; startedAt: number; endedAt?: number; }

export class RunCardState {
  readonly startedAt: number;
  status: CardRunStatus = 'running'; text = ''; thinking = ''; error = ''; nativeSessionId = '';
  metrics: RunMetrics = {}; tools: ToolStep[] = [];
  pending?: { kind: 'approval' | 'question'; id: string; options?: string[] };
  constructor(readonly runId: string, readonly scope: string, startedAt = Date.now()) { this.startedAt = startedAt; }

  apply(event: AgentEvent): void {
    if (!['approval.requested', 'question.requested', 'session.started', 'metrics.updated'].includes(event.type)) { this.pending = undefined; if (this.status === 'waiting') this.status = 'running'; }
    switch (event.type) {
      case 'session.started': this.nativeSessionId = event.nativeSessionId; break;
      case 'text.delta': this.text += event.text; break;
      case 'thinking.delta': this.thinking += event.text; break;
      case 'tool.started': this.tools.push({ id: event.toolCallId, name: event.name, input: event.input, completed: false, startedAt: Date.now() }); break;
      case 'tool.completed': { const tool = this.tools.find((item) => item.id === event.toolCallId); if (tool) Object.assign(tool, { output: event.output, isError: event.isError, completed: true, endedAt: Date.now() }); break; }
      case 'metrics.updated': this.metrics = { ...this.metrics, ...event.metrics }; break;
      case 'approval.requested': this.status = 'waiting'; this.pending = { kind: 'approval', id: event.token ?? event.requestId }; break;
      case 'question.requested': this.status = 'waiting'; this.pending = { kind: 'question', id: event.token ?? event.questionId, options: event.options }; break;
      case 'run.completed': this.status = 'completed'; this.metrics = { ...this.metrics, ...event.metrics }; if (event.nativeSessionId) this.nativeSessionId = event.nativeSessionId; break;
      case 'run.failed': this.status = 'failed'; this.error = event.message; break;
      case 'run.cancelled': this.status = 'cancelled'; break;
    }
  }

  render(now = Date.now()): object {
    const elapsed = Math.max(0, (now - this.startedAt) / 1_000);
    const elements: object[] = [];
    elements.push(toolPanel(this.tools, this.status === 'running' || this.status === 'waiting', now));
    if (this.thinking && !this.text && this.status === 'running') elements.push({ tag: 'markdown', content: `💭 **思考中...**\n\n${escapeMarkdown(this.thinking.slice(-4_000))}`, text_size: 'notation' });
    else if (this.thinking) elements.push(collapsible('💭 思考', escapeMarkdown(this.thinking.slice(-4_000)), false));
    if (this.nativeSessionId) elements.push({ tag: 'markdown', content: `🧭 Session: ${escapeMarkdown(this.nativeSessionId)}`, text_size: 'notation' });
    elements.push({ tag: 'markdown', content: this.text || (this.error ? `**错误：** ${escapeMarkdown(this.error)}` : '正在思考…') });
    const footerText = footer(this.status, elapsed, this.metrics);
    elements.push({ tag: 'markdown', content: (this.status === 'running' || this.status === 'waiting') ? `${footerText} · 发送 \`/stop\` 可停止` : footerText, text_size: 'notation' });
    if (this.pending?.kind === 'approval') elements.push(buttonRow([callbackButton('允许', { action: 'approve', approved: true, token: this.pending.id }, 'primary'), callbackButton('拒绝', { action: 'approve', approved: false, token: this.pending.id }, 'danger')]));
    else if (this.pending?.kind === 'question' && this.pending.options?.length) elements.push(buttonRow(this.pending.options.slice(0, 5).map((o) => callbackButton(o, { action: 'answer', answer: o, token: this.pending!.id }))));
    else if (this.pending?.kind === 'question') elements.push({ tag: 'form', name: 'agent_question_form', elements: [{ tag: 'input', name: 'answer', required: true, placeholder: { tag: 'plain_text', content: '请输入回答' } }, { tag: 'button', name: 'agent_question_submit', text: { tag: 'plain_text', content: '提交回答' }, type: 'primary', form_action_type: 'submit', value: { action: 'answer', token: this.pending.id } }] });
    const summary = this.text.replace(/[*_`#>[\]()~]/g, '').trim().slice(0, 120);
    return { schema: '2.0', config: { wide_screen_mode: true, update_multi: true, streaming_mode: this.status === 'running', locales: ['zh_cn', 'en_us'], ...(summary ? { summary: { content: summary } } : {}) }, body: { elements } };
  }
}

function toolPanel(tools: ToolStep[], active: boolean, now: number): object {
  const started = tools[0]?.startedAt;
  const ended = tools.every((t) => t.completed) ? Math.max(...tools.map((t) => t.endedAt ?? now)) : now;
  const duration = started ? `执行耗时 ${formatElapsed(Math.max(0, ended - started))}` : '工具执行';
  const title = active ? `🛠️ 工具执行${tools.length ? ` · ${tools.length} 步` : ''}` : `🛠️ ${duration}${tools.length ? ` · 查看 ${tools.length} 个步骤` : ''}`;
  return {
    tag: 'collapsible_panel', expanded: active && tools.some((t) => !t.completed),
    header: { title: { tag: 'plain_text', content: title, text_color: 'grey', text_size: 'notation' }, vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 },
    border: { color: 'grey', corner_radius: '5px' }, vertical_spacing: '4px', padding: '8px 8px 8px 8px',
    elements: tools.length ? tools.flatMap(toolElements) : [{ tag: 'div', text: { tag: 'plain_text', content: '暂无工具步骤', text_color: 'grey', text_size: 'notation' } }],
  };
}
function toolElements(tool: ToolStep): object[] {
  const meta = toolMeta(tool.name); const status = tool.completed ? (tool.isError ? { label: 'Failed', color: 'red' } : { label: 'Succeeded', color: 'green' }) : { label: 'Running', color: 'turquoise' };
  const duration = tool.endedAt ? ` (${formatElapsed(tool.endedAt - tool.startedAt)})` : '';
  const result: object[] = [{ tag: 'div', icon: { tag: 'standard_icon', token: meta.icon, color: 'grey' }, text: { tag: 'lark_md', content: `**${meta.title}${duration}** · <font color='${status.color}'>${status.label}</font>`, text_size: 'notation' } }];
  const detail = toolDetail(tool.input, meta.key);
  if (detail) result.push({ tag: 'div', margin: '0px 0px 0px 22px', text: { tag: 'plain_text', content: detail, text_color: 'grey', text_size: 'notation' } });
  return result;
}
function toolMeta(name: string): { title: string; icon: string; key: string } { const n = name.toLowerCase(); if (n.includes('skill')) return { title: 'Load skill', icon: 'app-default_outlined', key: 'skill' }; if (n.includes('read')) return { title: 'Read', icon: 'file-link-text_outlined', key: 'path' }; if (n.includes('write') || n.includes('edit') || n.includes('patch')) return { title: 'Edit', icon: 'edit_outlined', key: 'path' }; if (n.includes('grep')) return { title: 'Search text', icon: 'doc-search_outlined', key: 'pattern' }; if (n.includes('glob')) return { title: 'Search files', icon: 'folder_outlined', key: 'pattern' }; if (n.includes('websearch') || n.includes('search')) return { title: 'Search web', icon: 'search_outlined', key: 'query' }; if (n.includes('bash') || n.includes('command') || n.includes('terminal')) return { title: 'Run command', icon: 'setting_outlined', key: 'command' }; return { title: name, icon: 'setting-inter_outlined', key: 'generic' }; }
function toolDetail(input: unknown, kind: string): string | undefined { if (!input || typeof input !== 'object') return typeof input === 'string' ? input.slice(0, 300) : undefined; const r = input as Record<string, unknown>; const keys = kind === 'path' ? ['file_path', 'path', 'file'] : kind === 'pattern' ? ['pattern'] : kind === 'query' ? ['query', 'q'] : kind === 'command' ? ['command', 'description'] : kind === 'skill' ? ['skill', 'name'] : []; for (const key of keys) if (typeof r[key] === 'string') { const value = r[key] as string; return kind === 'path' ? (value.split('/').filter(Boolean).at(-1) ?? value) : value.slice(0, 300); } return undefined; }
function collapsible(title: string, content: string, expanded: boolean): object { return { tag: 'collapsible_panel', expanded, header: { title: { tag: 'plain_text', content: title, text_color: 'grey', text_size: 'notation' }, vertical_align: 'center', icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', color: 'grey', size: '16px 16px' }, icon_position: 'right', icon_expanded_angle: -180 }, border: { color: 'grey', corner_radius: '5px' }, padding: '8px 8px 8px 8px', elements: [{ tag: 'markdown', content, text_size: 'notation' }] }; }
function footer(status: CardRunStatus, elapsed: number, m: RunMetrics): string {
  const labels = { running: '运行中', waiting: '等待用户操作', completed: '已完成', failed: '失败', cancelled: '已停止' };
  const first = [labels[status], `耗时 ${formatElapsed(elapsed * 1_000)}`, m.model].filter(Boolean).join(' · ');
  const detail: string[] = [];
  if (m.inputTokens != null && m.outputTokens != null) detail.push(`↑ ${compact(m.inputTokens)} ↓ ${compact(m.outputTokens)}`);
  if (m.cacheReadTokens != null || m.cacheWriteTokens != null) {
    const read = Math.max(0, m.cacheReadTokens ?? 0); const write = Math.max(0, m.cacheWriteTokens ?? 0); const input = Math.max(0, m.inputTokens ?? 0);
    const denominator = read + write + input; const hit = denominator > 0 ? Math.round((read / denominator) * 100) : 0;
    detail.push(`缓存 ${compact(read)}/${compact(write)} (${hit}%)`);
  }
  if (m.totalTokens != null && m.contextTokens != null) {
    const total = Math.max(0, m.totalTokens); const context = Math.max(0, m.contextTokens); const used = context > 0 ? Math.round((total / context) * 100) : 0;
    detail.push(`上下文 ${compact(total)}/${compact(context)} (${used}%)`);
  }
  return detail.length ? `${first}\n${detail.join(' · ')}` : first;
}
function compact(n: number): string { const abs = Math.abs(n); if (abs >= 1_000_000) { const m = n / 1_000_000; return Math.abs(m) >= 100 ? `${Math.round(m)}m` : `${m.toFixed(1)}m`; } if (abs >= 1_000) { const k = n / 1_000; return Math.abs(k) >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1)}k`; } return String(Math.round(n)); }
function formatElapsed(ms: number): string { const seconds = ms / 1_000; return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`; }
function callbackButton(label: string, value: Record<string, unknown>, type = 'default'): object { return { tag: 'button', text: { tag: 'plain_text', content: label }, type, behaviors: [{ type: 'callback', value }] }; }
function buttonRow(buttons: object[]): object { return { tag: 'column_set', flex_mode: 'flow', horizontal_spacing: 'small', columns: buttons.map((button) => ({ tag: 'column', width: 'auto', elements: [button] })) }; }
function escapeMarkdown(value: string): string { return value.replaceAll('`', '\\`'); }
