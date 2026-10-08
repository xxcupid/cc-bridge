import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeApplication } from '../src/application/bridge-application.js';
import { AgentRegistry } from '../src/application/agent-registry.js';
import { SessionStore } from '../src/session/session-store.js';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';
import { ApprovalStore } from '../src/approval/approval-store.js';
import type { AgentAdapter, AgentRunHandle, AgentRunRequest } from '../src/domain/agent.js';
import type { ChannelPort } from '../src/channel/port.js';
import type { IncomingMessage } from '../src/domain/message.js';
const handles = vi.hoisted(() => [] as Array<{ socketPath: string }>);
vi.mock('../src/mcp/bridge-mcp-listener.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp/bridge-mcp-listener.js')>();
  return { ...actual, async startBridgeMcpListener(opts: Parameters<typeof actual.startBridgeMcpListener>[0]) {
    const h = await actual.startBridgeMcpListener(opts); handles.push(h); return h;
  } };
});

async function harness(mode: 'complete' | 'start-fail' | 'shutdown' | 'mkdir-fail', agentId: 'claude' | 'codex' = 'claude') {
  const dir = await mkdtemp(join(tmpdir(), 'oscar-app-mcp-'));
  let handler!: (msg: IncomingMessage) => Promise<void>;
  let config: { mcpServers: { 'oscar-bridge': { args: string[]; env: { OSCAR_BRIDGE_SOCKET: string } } } } | undefined;
  const cancel = vi.fn(async () => {}), remove = vi.fn(async () => {}), markdown = vi.fn(async (_chatId: string, _text: string) => {});
  const channel: ChannelPort = {
    onMessage(h) { handler = h; }, onCardAction() {}, async connect() {}, async disconnect() {}, sendMarkdown: markdown,
    async addReaction() { return 'reaction'; }, removeReaction: remove,
    async streamCard(_chat, _card, producer) { await producer({ messageId: 'card', async update() {} }); return { messageId: 'card' }; },
  };
  let app!: BridgeApplication;
  const agent: AgentAdapter = { id: agentId, async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    config = JSON.parse(await readFile(request.mcpConfigPath!, 'utf8'));
    if (mode === 'start-fail') throw new Error('mock spawn error');
    // Exercise shutdown racing with agent startup without deadlocking app.stop().
    if (mode === 'shutdown') (app as unknown as { stopping: boolean }).stopping = true;
    return { events: (async function* () { yield { type: 'run.completed' as const }; })(), cancel, async approve() {}, async answer() {} };
  } };
  const agents = new AgentRegistry(); agents.register(agent);
  const oscarHome = mode === 'mkdir-fail' ? join(dir, 'blocked-home') : dir;
  if (mode === 'mkdir-fail') await writeFile(oscarHome, 'not a directory');
  app = new BridgeApplication({ channel, agents, defaultAgent: agentId, defaultWorkspace: dir, oscarHome,
    permission: { mode: 'default', maxAccess: 'workspace' }, sessions: new SessionStore(join(dir, 'sessions.json')),
    workspaces: new WorkspaceStore(join(dir, 'workspaces.json')), approvals: new ApprovalStore(join(dir, 'approvals.json')) });
  const startIndex = handles.length;
  try {
    await app.start();
    await handler({ messageId: 'source', chatId: 'oc', chatType: 'p2p', senderId: 'user', content: 'send file' });
    const h = handles[startIndex]!;
    await expect(access(h.socketPath)).rejects.toThrow();
    expect(remove).toHaveBeenCalledTimes(1);
    if (mode !== 'mkdir-fail') expect(await readdir(join(dir, 'runs'))).toEqual([]);
    if (config) {
      expect(config.mcpServers['oscar-bridge'].env.OSCAR_BRIDGE_SOCKET).toBe(h.socketPath);
      // Works with source-mode tsx and built deployment, independent of cwd.
      expect(config.mcpServers['oscar-bridge'].args[0]).toBe(join(process.cwd(), 'dist/mcp/oscar-bridge-mcp.js'));
    }
    if (mode === 'shutdown') expect(cancel).toHaveBeenCalledWith('bridge is shutting down');
    if (mode === 'mkdir-fail') expect(markdown.mock.calls[0]?.[1]).toContain('初始化失败');
    if (mode === 'start-fail') expect(markdown.mock.calls[0]?.[1]).toContain('启动失败');
  } finally { await app.stop(); await rm(dir, { recursive: true, force: true }); }
}

describe('BridgeApplication MCP lifecycle', () => {
  it.each(['claude', 'codex'] as const)('writes a usable run config for %s and removes it on completion', async (agent) => harness('complete', agent));
  it('closes listener after configuration directory creation fails', async () => harness('mkdir-fail'));
  it('cleans up when agent startup fails', async () => harness('start-fail'));
  it('cleans up when shutdown races with startup', async () => harness('shutdown'));
});
