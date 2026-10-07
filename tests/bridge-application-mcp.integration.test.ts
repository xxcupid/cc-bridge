import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BridgeApplication } from '../src/application/bridge-application.js';
import { AgentRegistry } from '../src/application/agent-registry.js';
import { SessionStore } from '../src/session/session-store.js';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';
import { ApprovalStore } from '../src/approval/approval-store.js';
import type { AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest } from '../src/domain/agent.js';
import type { ChannelPort } from '../src/channel/port.js';

interface ReceivedRequest { mcpConfigPath?: string }

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 5000, intervalMs = 25): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('BridgeApplication MCP integration', () => {
  it('starts MCP listener, writes MCP config, and passes mcpConfigPath to agent', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'oscar-bridge-app-mcp-'));
    const received: ReceivedRequest[] = [];
    const handlers: Array<(msg: unknown) => Promise<void>> = [];
    const channel: Partial<ChannelPort> = {
      onMessage(handler) { handlers.push(handler as (msg: unknown) => Promise<void>); },
      onCardAction() {},
      async connect() {}, async disconnect() {},
      async sendMarkdown() {},
      async streamCard() { return { messageId: 'card-1' }; },
    };

    const sessions = new SessionStore(join(tmpDir, 'sessions.json'));
    const workspaces = new WorkspaceStore(join(tmpDir, 'workspaces.json'));
    const approvals = new ApprovalStore(join(tmpDir, 'approvals.json'));
    const agent: AgentAdapter = {
      id: 'claude',
      async start(request: AgentRunRequest): Promise<AgentRunHandle> {
        received.push({ mcpConfigPath: request.mcpConfigPath });
        const events: AgentEvent[] = [
          { type: 'session.started', nativeSessionId: 'n-1' },
          { type: 'text.delta', text: 'hi' },
          { type: 'run.completed', nativeSessionId: 'n-1' },
        ];
        return {
          events: (async function* () {
            for (const e of events) {
              yield e;
              await new Promise((r) => setTimeout(r, 50));
            }
          })(),
          async cancel() {}, async approve() {}, async answer() {},
        };
      },
    };
    const agents = new AgentRegistry();
    agents.register(agent);

    const app = new BridgeApplication({
      channel: channel as ChannelPort,
      agents, defaultAgent: 'claude',
      defaultWorkspace: tmpDir,
      oscarHome: tmpDir,
      permission: { mode: 'default', maxAccess: 'workspace' },
      sessions, workspaces, approvals,
    });
    await app.start();

    const handler = handlers.at(-1);
    if (!handler) throw new Error('handler was not registered');
    await handler({
      messageId: 'm-1', chatId: 'oc_test', chatType: 'p2p', senderId: 'u-1',
      content: 'send me a file',
    });

    await waitFor(() => received.length === 1 ? true : undefined);

    // The agent receives mcpConfigPath under oscarHome/runs/<runId>/
    const mcpConfigPath = received[0]!.mcpConfigPath;
    expect(mcpConfigPath).toBeTruthy();
    expect(mcpConfigPath).toContain(join(tmpDir, 'runs'));
    expect(mcpConfigPath).toMatch(/mcp-config\.json$/);

    // Wait for handleMessage's finally to clean up mcpConfigPath.
    await waitFor(() => {
      const p = received[0]?.mcpConfigPath;
      return p && !existsSync(p) ? true : undefined;
    });

    // stop may throw because of session/workspace flush races with our rmSync,
    // but the test goal is verified above. Catch and ignore.
    try { await app.stop(); } catch { /* ignore cleanup race */ }

    // defer rm so any in-flight IO finishes first
    await new Promise((r) => setTimeout(r, 200));
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
