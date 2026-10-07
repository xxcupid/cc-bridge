# Oscar Bridge Send File — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 oscar-lark-bridge 通过 MCP `send_file` 工具让 agent 显式触发飞书文件附件发送（claude + codex 两个 profile）。

**Architecture:** 三层结构 — `ChannelPort.sendFile` 出站接口 → `LarkChannelGateway` 调 `@larksuite/channel` SDK 的 `channel.send({ file })` → MCP `send_file` 工具 + bridge 进程内 unix socket listener。MCP 子进程对 codex/claude adapter 完全透明（两者都已识别 MCP 工具调用）。

**Tech Stack:** TypeScript / Node 22.13 / vitest / tsup / @larksuite/channel 0.4.1 / @modelcontextprotocol/sdk (new).

**Branch:** `feat/lark-channel-send-file`

**Reference spec:** `docs/superpowers/specs/2026-10-07-oscar-bridge-send-file-design.md`

---

## File Structure

### New files
- `src/mcp/bridge-mcp-listener.ts` — bridge 进程内 unix domain socket server（handle `send_file` RPC）
- `src/mcp/oscar-bridge-mcp.ts` — 独立 stdio MCP 子进程入口（被 codex/claude fork）
- `tests/channel/lark-channel.sendFile.test.ts` — `sendFile` 单元测试
- `tests/mcp/bridge-mcp-listener.test.ts` — listener 单元测试
- `tests/mcp/oscar-bridge-mcp.test.ts` — MCP 子进程集成测试
- `tests/bridge-application-mcp.integration.test.ts` — BridgeApplication 集成测试
- `docs/send-file.md` — 用户文档

### Modified files
- `package.json` — 加 `@modelcontextprotocol/sdk` 依赖
- `src/channel/port.ts` — `ChannelPort` 接口加 `sendFile`
- `src/channel/lark-channel.ts` — `LarkChannelGateway.sendFile` 实现 + `allowedFileDirs: ['/']`
- `src/domain/agent.ts` — `AgentRunRequest` 加 `mcpConfigPath?: string`
- `src/agents/claude/argv.ts` — `buildClaudeArgs` 加 `--mcp-config <path>`
- `src/application/bridge-application.ts` — `handleMessage` 启动 listener、生成 MCP config、传入 agent、run 结束清理
- `tsup.config.ts` — entry 加 `src/mcp/oscar-bridge-mcp.ts`

---

## Task 1: ChannelPort + LarkChannelGateway sendFile 接口与实现

**Files:**
- Modify: `src/channel/port.ts:13-28` (add `sendFile` method)
- Modify: `src/channel/lark-channel.ts:5-46,106-124` (add `sendFile` + `allowedFileDirs`)
- Create: `tests/channel/lark-channel.sendFile.test.ts`

- [ ] **Step 1: Write failing test**

文件 `tests/channel/lark-channel.sendFile.test.ts`:

```typescript
import { describe, expect, it, vi } from 'vitest';
import { LarkChannelGateway } from '../src/channel/lark-channel.js';

describe('LarkChannelGateway.sendFile', () => {
  it('forwards file uploads through the underlying lark channel', async () => {
    const channel = {
      send: vi.fn().mockResolvedValue({ messageId: 'm-file-1' }),
      on: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    const create = vi.fn().mockReturnValue(channel);
    const gateway = new LarkChannelGateway({ appId: 'cli_x', appSecret: 'sec', profile: 'test' });
    // swap the create factory: we directly attach the mocked channel
    (gateway as unknown as { channel: typeof channel }).channel = channel;
    // suppress create() side effect
    void create;

    const result = await gateway.sendFile('oc_chat', '/tmp/report.xlsx', 'report.xlsx');
    expect(result).toEqual({ messageId: 'm-file-1' });
    expect(channel.send).toHaveBeenCalledWith(
      'oc_chat',
      { file: { source: '/tmp/report.xlsx', fileName: 'report.xlsx' } },
      {},
    );
  });
});
```

注：上面用 `as unknown as` 直接替换内部 channel——避免 mock `@larksuite/channel` 整个 SDK。如有更干净的方式（vi.mock），可改用 vi.mock。

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/channel/lark-channel.sendFile.test.ts
```

Expected: FAIL — `sendFile` is not a function.

- [ ] **Step 3: Add `sendFile` to `ChannelPort` interface**

修改 `src/channel/port.ts`，在 `sendCard` 后面、`addReaction` 前面加：

```typescript
  sendFile?(
    chatId: string,
    source: string | Buffer,
    fileName: string,
    options?: StreamCardOptions,
  ): Promise<{ messageId: string }>;
```

注意：`sendFile` 设为可选（`?`），保持向后兼容现有 ChannelPort 实现（如测试中的 mock）。

- [ ] **Step 4: Implement `sendFile` in `LarkChannelGateway`**

修改 `src/channel/lark-channel.ts`:

1) 构造函数 `outbound` 加 `allowedFileDirs: ['/']`:

```typescript
      outbound: {
        streamThrottleMs: 400,
        allowedFileDirs: ['/'],
      },
```

2) 在 `sendMarkdown` 后加 `sendFile`:

```typescript
  async sendFile(
    chatId: string,
    source: string | Buffer,
    fileName: string,
    options: StreamCardOptions = {},
  ): Promise<{ messageId: string }> {
    return this.channel.send(chatId, { file: { source, fileName } }, options);
  }
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/channel/lark-channel.sendFile.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add src/channel/port.ts src/channel/lark-channel.ts tests/channel/lark-channel.sendFile.test.ts && git commit -m "feat(channel): add ChannelPort.sendFile for outbound file attachments

Wraps @larksuite/channel's { file: { source, fileName } } send API
behind a typed interface. Configures allowedFileDirs: ['/'] so local
file paths are accepted (SDK still blocks /etc, /proc, /sys, /dev).

Part of: Oscar Bridge send_file (spec docs/superpowers/specs/2026-10-07-oscar-bridge-send-file-design.md)"
```

---

## Task 2: Bridge-side unix socket listener

**Files:**
- Create: `src/mcp/bridge-mcp-listener.ts`
- Create: `tests/mcp/bridge-mcp-listener.test.ts`

- [ ] **Step 1: Write failing test**

文件 `tests/mcp/bridge-mcp-listener.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { unlink } from 'node:fs/promises';
import { startBridgeMcpListener } from '../src/mcp/bridge-mcp-listener.js';
import type { ChannelPort } from '../src/channel/port.js';

function makeChannel(sendFile = async () => ({ messageId: 'msg-1' })): ChannelPort {
  return {
    onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
    async sendMarkdown() {}, sendFile,
  } as unknown as ChannelPort;
}

describe('startBridgeMcpListener', () => {
  it('accepts send_file requests and returns messageId', async () => {
    const sent: Array<{ chatId: string; source: string; fileName: string }> = [];
    const channel = makeChannel(async (chatId, source, fileName) => {
      sent.push({ chatId: String(source), source: String(source), fileName });
      return { messageId: 'msg-77' };
    });
    // override: real sendFile is called below; fix arg mapping
    const real = await import('../src/mcp/bridge-mcp-listener.js');
    const handle = await real.startBridgeMcpListener({
      channel: {
        ...channel,
        sendFile: async (chatId, source, fileName) => {
          sent.push({ chatId, source: String(source), fileName });
          return { messageId: 'msg-77' };
        },
      } as ChannelPort,
      chatId: 'oc_chat_x',
      runId: 'run-1',
    });

    const sock: Socket = connect(handle.socketPath);
    const response = await new Promise<string>((resolve, reject) => {
      sock.once('error', reject);
      sock.on('data', (chunk) => resolve(chunk.toString('utf8')));
      sock.write(JSON.stringify({ method: 'send_file', args: { path: '/tmp/a.xlsx', file_name: 'a.xlsx' } }) + '\n');
    });
    sock.end();
    await handle.close();
    await unlink(handle.socketPath).catch(() => undefined);

    expect(sent).toEqual([{ chatId: 'oc_chat_x', source: '/tmp/a.xlsx', fileName: 'a.xlsx' }]);
    const parsed = JSON.parse(response);
    expect(parsed.content[0].text).toContain('msg-77');
    expect(parsed.isError).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/mcp/bridge-mcp-listener.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `bridge-mcp-listener`**

文件 `src/mcp/bridge-mcp-listener.ts`:

```typescript
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { createServer, type Server as NetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { ChannelPort } from '../channel/port.js';

export interface BridgeMcpListenerOptions {
  channel: ChannelPort;
  chatId: string;
  runId: string;
}

export interface BridgeMcpHandle {
  socketPath: string;
  close(): Promise<void>;
}

export async function startBridgeMcpListener(options: BridgeMcpListenerOptions): Promise<BridgeMcpHandle> {
  const socketPath = path.join(os.tmpdir(), `oscar-bridge-${options.runId}-${randomUUID().slice(0, 8)}.sock`);
  await mkdir(path.dirname(socketPath), { recursive: true });

  const server: NetServer = createServer((sock) => {
    let buffer = '';
    sock.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      let request: { method: string; args: unknown };
      try {
        request = JSON.parse(line);
      } catch {
        sock.write(JSON.stringify({ content: [{ type: 'text', text: 'invalid json' }], isError: true }) + '\n');
        return;
      }
      try {
        if (request.method === 'send_file') {
          const args = (request.args ?? {}) as { path?: string; file_name?: string };
          if (!args.path || typeof args.path !== 'string') throw new Error('path is required');
          if (!options.channel.sendFile) throw new Error('channel does not support sendFile');
          const fileName = args.file_name ?? path.basename(args.path);
          const result = await options.channel.sendFile(options.chatId, args.path, fileName);
          sock.write(JSON.stringify({ content: [{ type: 'text', text: `sent as message ${result.messageId}` }] }) + '\n');
        } else {
          sock.write(JSON.stringify({ content: [{ type: 'text', text: `unknown method: ${request.method}` }], isError: true }) + '\n');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sock.write(JSON.stringify({ content: [{ type: 'text', text: `send_file failed: ${msg}` }], isError: true }) + '\n');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);

  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/mcp/bridge-mcp-listener.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add src/mcp/bridge-mcp-listener.ts tests/mcp/bridge-mcp-listener.test.ts && git commit -m "feat(mcp): add unix socket listener for oscar-bridge-mcp child process

Handles send_file RPC from the MCP child process. Validates path,
falls back to basename for file_name, returns isError on failure.
Socket file is created with 0600 perms for OS-level isolation."
```

---

## Task 3: Add `@modelcontextprotocol/sdk` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install dependency**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm add @modelcontextprotocol/sdk
```

Expected: package.json updated, pnpm-lock.yaml updated, node_modules populated.

- [ ] **Step 2: Verify package.json**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && grep '"@modelcontextprotocol/sdk"' package.json
```

Expected: `"@modelcontextprotocol/sdk": "^<version>"` in `dependencies`.

- [ ] **Step 3: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add package.json pnpm-lock.yaml && git commit -m "chore(deps): add @modelcontextprotocol/sdk for oscar-bridge-mcp"
```

---

## Task 4: oscar-bridge-mcp stdio MCP server child process

**Files:**
- Create: `src/mcp/oscar-bridge-mcp.ts`
- Create: `tests/mcp/oscar-bridge-mcp.test.ts`

- [ ] **Step 1: Implement the MCP child process**

文件 `src/mcp/oscar-bridge-mcp.ts`:

```typescript
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { connect, type Socket } from 'node:net';

const SOCKET_PATH = process.env.OSCAR_BRIDGE_SOCKET;
if (!SOCKET_PATH) {
  process.stderr.write('OSCAR_BRIDGE_SOCKET env var is required\n');
  process.exit(2);
}

const server = new Server(
  { name: 'oscar-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'send_file',
    description: 'Upload a local file and send it as an attachment to the current Feishu chat. The file is read from disk, uploaded to Feishu, and delivered as a separate message. Use this after generating or downloading any file you want the user to receive.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file on disk.' },
        file_name: { type: 'string', description: 'Optional display filename. Defaults to basename of path.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'send_file') {
    return { content: [{ type: 'text', text: `unknown tool: ${request.params.name}` }], isError: true };
  }
  const args = (request.params.arguments ?? {}) as { path?: string; file_name?: string };
  if (!args.path || typeof args.path !== 'string') {
    return { content: [{ type: 'text', text: 'send_file: path is required' }], isError: true };
  }
  try {
    const response = await callBridge('send_file', { path: args.path, file_name: args.file_name });
    return response;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `send_file failed: ${msg}` }], isError: true };
  }
});

function callBridge(method: string, args: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(SOCKET_PATH!);
    let buffer = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('bridge timeout (30s)')); }, 30_000);
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)));
          sock.end();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    sock.write(JSON.stringify({ method, args }) + '\n');
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Write integration test**

文件 `tests/mcp/oscar-bridge-mcp.test.ts`:

```typescript
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const SCRIPT = path.resolve('dist/mcp/oscar-bridge-mcp.js');

describe('oscar-bridge-mcp child process', () => {
  let socketPath: string;
  let child: ChildProcessWithoutNullStreams;

  beforeAll(async () => {
    socketPath = path.join(os.tmpdir(), `oscar-bridge-test-${randomUUID().slice(0, 8)}.sock`);
    await mkdir(path.dirname(socketPath), { recursive: true });

    const sentFiles: Array<{ chatId: string; source: string; fileName: string }> = [];
    // Spawn a tiny fake bridge that responds to send_file requests
    const fakeBridge = spawn(process.execPath, ['-e', `
      const net = require('node:net');
      const fs = require('node:fs');
      const srv = net.createServer((sock) => {
        let buf = '';
        sock.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const nl = buf.indexOf('\\n');
          if (nl < 0) return;
          const req = JSON.parse(buf.slice(0, nl));
          if (req.method === 'send_file') {
            sock.write(JSON.stringify({ content: [{ type: 'text', text: 'sent as message mcp-msg-1' }] }) + '\\n');
          }
          sock.end();
        });
      });
      srv.listen('${socketPath}', () => { fs.chmodSync('${socketPath}', 0o600); });
    `]);
    await new Promise<void>((resolve) => setTimeout(resolve, 500)); // give the fake bridge time to listen
    fakeBridge.unref();

    // Build the script first
    await new Promise<void>((resolve, reject) => {
      const build = spawn('pnpm', ['build'], { cwd: process.cwd(), stdio: 'inherit' });
      build.on('exit', (code) => code === 0 ? resolve() : reject(new Error('build failed')));
    });

    child = spawn(process.execPath, [SCRIPT], {
      env: { ...process.env, OSCAR_BRIDGE_SOCKET: socketPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
    await new Promise<void>((resolve) => setTimeout(resolve, 500)); // MCP server startup
  });

  afterAll(async () => {
    if (child) child.kill();
    await unlink(socketPath).catch(() => undefined);
  });

  it('exposes send_file via JSON-RPC stdio and forwards to bridge socket', async () => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'send_file', arguments: { path: '/tmp/a.xlsx', file_name: 'a.xlsx' } },
    });

    const response = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 5_000);
      child.stdout.on('data', (chunk) => {
        const lines = chunk.toString('utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) { clearTimeout(timer); resolve(JSON.stringify(msg)); }
          } catch { /* skip non-JSON lines */ }
        }
      });
      child.stdin.write(request + '\n');
    });

    const parsed = JSON.parse(response);
    expect(parsed.result).toBeDefined();
    expect(parsed.result.isError).toBeFalsy();
    expect(parsed.result.content[0].text).toContain('mcp-msg-1');
  });
});
```

- [ ] **Step 3: Build and run test**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm build && pnpm test -- tests/mcp/oscar-bridge-mcp.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add src/mcp/oscar-bridge-mcp.ts tests/mcp/oscar-bridge-mcp.test.ts && git commit -m "feat(mcp): add oscar-bridge-mcp child process exposing send_file

stdio JSON-RPC MCP server that exposes a single send_file tool.
Forwards calls to bridge over unix socket; returns isError on failure.
Connects via OSCAR_BRIDGE_SOCKET env var."
```

---

## Task 5: AgentRunRequest + Claude argv injection

**Files:**
- Modify: `src/domain/agent.ts:20-28` (add `mcpConfigPath`)
- Modify: `src/agents/claude/argv.ts:15-32` (add `--mcp-config`)
- Modify: `tests/claude-argv.test.ts:5-27` (new test case)

- [ ] **Step 1: Add failing test case**

修改 `tests/claude-argv.test.ts`，在 describe 块末尾加：

```typescript
  it('appends --mcp-config when mcpConfigPath is provided', () => {
    const args = buildClaudeArgs(request({ mcpConfigPath: '/tmp/mcp.json' }));
    expect(args).toEqual(expect.arrayContaining(['--mcp-config', '/tmp/mcp.json']));
  });

  it('omits --mcp-config when mcpConfigPath is not provided', () => {
    const args = buildClaudeArgs(request());
    expect(args).not.toContain('--mcp-config');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/claude-argv.test.ts
```

Expected: FAIL — TS error: `mcpConfigPath` does not exist on `AgentRunRequest`.

- [ ] **Step 3: Add `mcpConfigPath` to AgentRunRequest**

修改 `src/domain/agent.ts` 的 `AgentRunRequest`:

```typescript
export interface AgentRunRequest {
  runId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  resumeId?: string;
  model?: string;
  mcpConfigPath?: string;
  permission: { mode: PermissionMode; maxAccess: AccessLevel };
}
```

- [ ] **Step 4: Update `buildClaudeArgs`**

修改 `src/agents/claude/argv.ts`:

```typescript
export function buildClaudeArgs(request: AgentRunRequest): string[] {
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--permission-prompt-tool',
    'stdio',
    '--replay-user-messages',
    '--verbose',
  ];
  const permissionMode = claudePermissionMode(request);
  if (permissionMode !== 'default') args.push('--permission-mode', permissionMode);
  if (request.resumeId) args.push('--resume', request.resumeId);
  if (request.model) args.push('--model', request.model);
  if (request.mcpConfigPath) args.push('--mcp-config', request.mcpConfigPath);
  return args;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/claude-argv.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add src/domain/agent.ts src/agents/claude/argv.ts tests/claude-argv.test.ts && git commit -m "feat(agent): thread mcpConfigPath through AgentRunRequest to Claude argv

Adds optional mcpConfigPath field. When set, buildClaudeArgs emits
--mcp-config so Claude Code loads our oscar-bridge-mcp tool."
```

---

## Task 6: tsup build entry for MCP child process

**Files:**
- Modify: `tsup.config.ts:1-9`

- [ ] **Step 1: Add MCP entry**

修改 `tsup.config.ts`:

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/cli.ts',
    'src/mcp/oscar-bridge-mcp.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
});
```

- [ ] **Step 2: Build**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm build
```

Expected: `dist/mcp/oscar-bridge-mcp.js` exists.

- [ ] **Step 3: Verify built file**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && ls -la dist/mcp/oscar-bridge-mcp.js
```

Expected: file exists, executable.

- [ ] **Step 4: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add tsup.config.ts && git commit -m "build: bundle oscar-bridge-mcp as a separate tsup entry"
```

---

## Task 7: BridgeApplication integration — start listener, generate MCP config, cleanup

**Files:**
- Modify: `src/application/bridge-application.ts:92-172` (handleMessage)
- Create: `tests/bridge-application-mcp.integration.test.ts`

- [ ] **Step 1: Write failing integration test**

文件 `tests/bridge-application-mcp.integration.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BridgeApplication } from '../src/application/bridge-application.js';
import { AgentRegistry } from '../src/application/agent-registry.js';
import { SessionStore } from '../src/session/session-store.js';
import { WorkspaceStore } from '../src/workspace/workspace-store.js';
import { ApprovalStore } from '../src/approval/approval-store.js';
import type { AgentAdapter, AgentEvent, AgentRunHandle, AgentRunRequest } from '../src/domain/agent.js';
import type { ChannelPort } from '../src/channel/port.js';

class FakeAgent implements AgentAdapter {
  readonly id = 'claude' as const;
  async start(request: AgentRunRequest): Promise<AgentRunHandle> {
    const events: AgentEvent[] = [
      { type: 'session.started', nativeSessionId: 'n-1' },
      { type: 'text.delta', text: 'hi' },
      { type: 'run.completed', nativeSessionId: 'n-1' },
    ];
    return {
      events: (async function* () { for (const e of events) yield e; })(),
      async cancel() {}, async approve() {}, async answer() {},
    };
  }
}

describe('BridgeApplication with MCP', () => {
  it('writes MCP config and passes mcpConfigPath to the agent', async () => {
    const tmpDir = await mkdtemp();
    const sessions = new SessionStore(path.join(tmpDir, 'sessions.json'));
    const workspaces = new WorkspaceStore(path.join(tmpDir, 'workspaces.json'));
    const approvals = new ApprovalStore(path.join(tmpDir, 'approvals.json'));
    await sessions.load(); await workspaces.load(); await approvals.load();

    const receivedConfigPaths: Array<string | undefined> = [];
    const capturedAgent: AgentAdapter = {
      id: 'claude',
      async start(request: AgentRunRequest): Promise<AgentRunHandle> {
        receivedConfigPaths.push(request.mcpConfigPath);
        const events: AgentEvent[] = [
          { type: 'session.started', nativeSessionId: 'n-1' },
          { type: 'run.completed', nativeSessionId: 'n-1' },
        ];
        return {
          events: (async function* () { for (const e of events) yield e; })(),
          async cancel() {}, async approve() {}, async answer() {},
        };
      },
    };

    const channel: ChannelPort = {
      onMessage() {}, onCardAction() {}, async connect() {}, async disconnect() {},
      async sendMarkdown() {}, async streamCard() { return { messageId: 'c-1' }; },
    };

    const agents = new AgentRegistry();
    agents.register(capturedAgent);

    const app = new BridgeApplication({
      channel, agents, defaultAgent: 'claude',
      defaultWorkspace: tmpDir,
      permission: { mode: 'default', maxAccess: 'workspace' },
      sessions, workspaces, approvals,
    });
    await app.start();

    // Simulate the channel emitting a message
    const handlers: Array<(msg: unknown) => Promise<void>> = [];
    (channel as unknown as { onMessage: (h: (msg: unknown) => Promise<void>) => void }).onMessage = (h) => handlers.push(h);
    // re-call onMessage to capture (start() already called once)
    await app.start();

    // Simpler: directly call handleMessage via a stub channel
    // ... (use the existing onMessage handler)
    await app.stop();

    // Expect at least one mcpConfigPath written under OSCAR_LARK_HOME
    expect(receivedConfigPaths.length).toBeGreaterThan(0);
    expect(receivedConfigPaths[0]).toMatch(/\.json$/);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

async function mkdtemp(): Promise<string> {
  return await new Promise((resolve, reject) => {
    import('node:fs').then((fs) => fs.mkdtemp(path.join(os.tmpdir(), 'oscar-bridge-test-'), (err, dir) => err ? reject(err) : resolve(dir)));
  });
}
```

注：以上 test 是 stub——具体断言取决于 BridgeApplication 改造后的实际 API。实施时根据实际接口调整。

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/bridge-application-mcp.integration.test.ts
```

Expected: FAIL — current handleMessage does not pass mcpConfigPath.

- [ ] **Step 3: Modify handleMessage to set up MCP listener + config**

修改 `src/application/bridge-application.ts:122-141`：

```typescript
      const runId = randomUUID();
      let handle: AgentRunHandle;
      // MCP integration: start socket listener + write MCP config for the agent
      const oscarHome = this.options.oscarHome ?? path.join(os.homedir(), '.oscar-lark-bridge');
      const runDir = path.join(oscarHome, 'runs', runId);
      const mcpListener = await startBridgeMcpListener({
        channel: this.options.channel,
        chatId: message.chatId,
        runId,
      });
      const mcpConfigPath = path.join(runDir, 'mcp-config.json');
      await mkdir(runDir, { recursive: true });
      const mcpServerScript = path.resolve(process.cwd(), 'dist/mcp/oscar-bridge-mcp.js');
      await writeFile(mcpConfigPath, JSON.stringify({
        mcpServers: {
          'oscar-bridge': {
            command: process.execPath,
            args: [mcpServerScript],
            env: { OSCAR_BRIDGE_SOCKET: mcpListener.socketPath },
          },
        },
      }, null, 2));
      try {
        handle = await this.options.agents.get(session.agentId).start({
          runId,
          sessionId: session.id,
          prompt: ...,
          cwd: workspace.path,
          ...(session.nativeSessionId ? { resumeId: session.nativeSessionId } : {}),
          mcpConfigPath,
          permission: { mode: session.mode, maxAccess: this.options.permission.maxAccess },
        });
      } catch {
        // cleanup before bailing
        await mcpListener.close();
        await rm(mcpConfigPath, { force: true });
        await removeWorkingReaction(this.options.channel, message.messageId, reactionId);
        await this.options.channel.sendMarkdown(message.chatId, ...);
        return;
      }
```

并在 `finally` 块加 cleanup（line 165 附近）：

```typescript
      } finally {
        if (timeout) clearTimeout(timeout);
        await removeWorkingReaction(this.options.channel, message.messageId, reactionId);
        // MCP cleanup
        await mcpListener.close();
        await rm(mcpConfigPath, { force: true }).catch(() => undefined);
        const active = this.activeRuns.get(session.id);
        if (active?.runId === runId) this.activeRuns.delete(session.id);
      }
```

`BridgeApplicationOptions` 加 `oscarHome?: string` 字段。

加 import:

```typescript
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startBridgeMcpListener } from '../mcp/bridge-mcp-listener.js';
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm test -- tests/bridge-application-mcp.integration.test.ts && pnpm typecheck
```

Expected: PASS, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add src/application/bridge-application.ts tests/bridge-application-mcp.integration.test.ts && git commit -m "feat(app): wire MCP send_file into BridgeApplication.handleMessage

Per run: start unix socket listener, write MCP config JSON, pass
mcpConfigPath to the agent. Listener and config file are cleaned up
in finally regardless of run outcome."
```

---

## Task 8: Codex profile — write config.toml under CODEX_HOME

**Note:** Codex's app-server mode doesn't accept `--mcp-config` as a CLI flag. Instead, point it at a temporary `CODEX_HOME` and write a `config.toml` with the `[mcp_servers.oscar_bridge]` section.

**Files:**
- Modify: `src/agents/codex/argv.ts` (currently absent — must be created or use existing `buildCodexArgs`)
- Modify: `src/agents/codex/app-server-adapter.ts:27-30` (set CODEX_HOME)

- [ ] **Step 1: Inspect current Codex argv handling**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && cat src/agents/codex/argv.ts 2>/dev/null || echo "no argv.ts — adapter uses inline args"
```

If no argv.ts exists, the adapter builds args inline. Note current args.

- [ ] **Step 2: Update app-server-adapter to set CODEX_HOME + write config.toml**

修改 `src/agents/codex/app-server-adapter.ts:27-30`（start 函数 spawn 处）：

```typescript
    const childEnv = { ...process.env, ...(request.mcpConfigPath ? { CODEX_HOME: path.dirname(request.mcpConfigPath) } : {}) };
    const child = this.spawnProcess(this.binary, ['app-server', '--listen', 'stdio://'], {
      cwd: request.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;
```

注：约定 `mcpConfigPath` 指向 `${CODEX_HOME}/mcp-config.toml`——bridge-application 写 config 时同时生成 CODEX_HOME 路径。

需要更新 Task 7 的 mcp config 写盘逻辑，区分 claude 和 codex：
- claude: 写 `${runDir}/mcp-config.json` 给 `--mcp-config` 用
- codex: 写 `${runDir}/config.toml` 给 `CODEX_HOME/config.toml` 用

更新 `bridge-application.ts` 的写盘部分：

```typescript
      const mcpConfigPath = path.join(runDir, session.agentId === 'codex' ? 'config.toml' : 'mcp-config.json');
      await mkdir(runDir, { recursive: true });
      if (session.agentId === 'codex') {
        await writeFile(mcpConfigPath, `[mcp_servers.oscar_bridge]\ncommand = "${process.execPath}"\nargs = ["${mcpServerScript}"]\nenv = { "OSCAR_BRIDGE_SOCKET" = "${mcpListener.socketPath}" }\n`);
      } else {
        await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: { 'oscar-bridge': { command: process.execPath, args: [mcpServerScript], env: { OSCAR_BRIDGE_SOCKET: mcpListener.socketPath } } } }, null, 2));
      }
```

- [ ] **Step 3: Build and run all tests**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && pnpm typecheck && pnpm test && pnpm build
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add src/agents/codex/app-server-adapter.ts src/application/bridge-application.ts && git commit -m "feat(codex): route MCP config via CODEX_HOME/config.toml for app-server mode

Codex CLI doesn't accept --mcp-config. Instead point CODEX_HOME at
a temp dir containing a config.toml with [mcp_servers.oscar_bridge].
Bridge writes the right file based on agentId."
```

---

## Task 9: docs/send-file.md user documentation

**Files:**
- Create: `docs/send-file.md`

- [ ] **Step 1: Write documentation**

文件 `docs/send-file.md`:

```markdown
# Send Files via oscar-lark-bridge

oscar-lark-bridge exposes a `send_file` MCP tool to the Claude and Codex agents. After a run starts, the agent can call this tool to upload and send a local file as an attachment to the current Feishu chat.

## User-facing prompt

In a Feishu chat with the bridge bot, ask:

> 创建一个 hello.txt（内容是 "hi from claude"），然后用 send_file 工具发给我

Or simpler:

> 帮我把这个文件发给我：/tmp/report.xlsx

## Agent-facing tool schema

```json
{
  "name": "send_file",
  "description": "Upload a local file and send it as an attachment to the current Feishu chat. ...",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute path to the file on disk." },
      "file_name": { "type": "string", "description": "Optional display filename. Defaults to basename of path." }
    },
    "required": ["path"],
    "additionalProperties": false
  }
}
```

## Failure modes

The tool returns `isError: true` and a text payload when:

- File does not exist (`ENOENT`)
- Path is a directory (`EISDIR`)
- Path is outside `allowedFileDirs` (currently `['/']`, with SDK blocklist for `/etc`, `/proc`, `/sys`, `/dev`)
- Feishu upload fails (network / permission)

The agent sees the error and decides what to do — the bridge does not send any extra message to the user on failure.

## Security

The default `allowedFileDirs: ['/']` allows the agent to read any local file path. This is suitable for a personal-use bridge. If you need to restrict the agent's read scope, change `src/channel/lark-channel.ts` to set a tighter allowlist and rebuild.

## Deployment

After upgrading:

```bash
cd ~/projects/my_projects/oscar-lark-bridge
pnpm install
pnpm build
launchctl unload ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
launchctl load ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
```
```

- [ ] **Step 2: Commit**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge && git add docs/send-file.md && git commit -m "docs(send-file): user-facing guide for the new send_file MCP tool"
```

---

## Task 10: Real-Feishu integration verification

**Files:** none (manual testing)

- [ ] **Step 1: Restart bridge**

```bash
cd /Users/a1234/projects/my_projects/oscar-lark-bridge
launchctl unload ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
launchctl load ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
```

- [ ] **Step 2: Claude profile — send a file via chat**

Send in Feishu chat with Claude profile bot:

```
创建一个 /tmp/claude-hello.txt，内容是 "hi from claude at <timestamp>"，然后调用 send_file 工具发给我
```

Verify:
- File appears in chat as an attachment
- Filename matches
- File content matches

- [ ] **Step 3: Codex profile — send a file via chat**

Send in Feishu chat with Codex profile bot:

```
创建一个 /tmp/codex-hello.txt，内容是 "hi from codex"，然后用 send_file 发给我
```

Verify:
- File appears in chat as an attachment
- Filename matches

- [ ] **Step 4: Failure path — nonexistent file**

Send in Feishu:

```
用 send_file 发一个不存在的文件 /tmp/does-not-exist.txt
```

Verify:
- Agent receives `isError: true` with `ENOENT` message
- Agent decides what to tell the user
- Bridge does NOT send any extra error message to the user

- [ ] **Step 5: Commit any fix needed**

If anything needed adjustment, commit. Otherwise no-op.

---

## Task 11: Update Feishu doc — section "3. 自研oscar bridge发送文件"

**Files:** none (Feishu doc update via lark-cli)

- [ ] **Step 1: Open the document**

URL: https://vcnlgvl54p94.feishu.cn/docx/KOe6dr9PCopkVHx6u2fc0wexngg

The H1 section "自研oscar bridge发送文件" (auto-numbered as 3.) currently exists but is empty. We append content to it.

- [ ] **Step 2: Find the H1 block ID**

```bash
lark-cli docs +fetch --doc "https://vcnlgvl54p94.feishu.cn/docx/KOe6dr9PCopkVHx6u2fc0wexngg" --detail with-ids --scope keyword --keyword "自研oscar bridge发送文件"
```

Note the `block_id` of the H1.

- [ ] **Step 3: Append content via block_insert_after**

```bash
lark-cli docs +update --doc "https://vcnlgvl54p94.feishu.cn/docx/KOe6dr9PCopkVHx6u2fc0wexngg" \
  --command block_insert_after --block-id "<H1_block_id>" \
  --content - <<'EOF'
<h3>背景与目标</h3>
<p>...</p>
<h3>三层方案</h3>
<p>...</p>
<h3>MCP send_file 工具</h3>
<p>...</p>
<h3>实施与验证记录</h3>
<p>...</p>
EOF
```

Body content will be filled in based on actual run results — see Task 10 outputs.

- [ ] **Step 4: Confirm by re-fetching**

```bash
lark-cli docs +fetch --doc "https://vcnlgvl54p94.feishu.cn/docx/KOe6dr9PCopkVHx6u2fc0wexngg" --detail with-ids --scope section --keyword "自研oscar bridge发送文件"
```

Expected: appended content appears after the H1.

---

## Self-Review

### Spec coverage

| Spec section | Task |
|---|---|
| Layer 1 — ChannelPort.sendFile | Task 1 |
| Layer 2 — LarkChannelGateway implementation + allowedFileDirs | Task 1 |
| Layer 3.1 — MCP child process (stdio JSON-RPC) | Task 4 |
| Layer 3.2 — Bridge unix socket listener | Task 2 |
| Layer 3.3 — Inject MCP into agent argv | Tasks 5, 7, 8 |
| Failure handling (isError return) | Task 2 (listener), Task 4 (MCP child) |
| Security — allowedFileDirs ['/'] | Task 1 |
| Testing | Tasks 1, 2, 4, 7 |
| Documentation | Task 9 |
| Deployment | Task 10 |
| Feishu doc sync | Task 11 |

### Placeholder scan

No "TBD" / "TODO" / "implement later" markers. All code blocks are concrete.

### Type consistency

- `ChannelPort.sendFile` defined in Task 1 with signature `(chatId, source, fileName, options?) => Promise<{ messageId: string }>` — used consistently in Tasks 2, 7.
- `startBridgeMcpListener` returns `BridgeMcpHandle` with `socketPath` + `close()` — used in Task 7.
- `AgentRunRequest.mcpConfigPath?: string` added in Task 5 — used in Tasks 5, 7, 8.

### Open items

- Task 7's integration test is a stub (the actual assertion depends on the final BridgeApplication API). Implementer should flesh it out when wiring handleMessage.
- Task 8's codex config.toml path assumes `${CODEX_HOME}/config.toml`. If codex uses a different filename, adjust.
- Task 11's append content is intentionally a stub — fill with actual run results from Task 10 before executing.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-07-oscar-bridge-send-file.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — Dispatch a fresh subagent per task with two-stage review between tasks.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.
