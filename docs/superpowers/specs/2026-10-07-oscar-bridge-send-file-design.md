# Oscar Bridge Send File — Design Spec

- **Date**: 2026-10-07
- **Author**: brainstorming session between user and Claude Code
- **Status**: draft, awaiting user approval
- **Branch**: will be branched off `main` after spec approval

## Background

本机同时跑着 `oscar-lark-bridge` (PID 35117) 和 `OpenClaw Gateway` (PID 68608)。OpenClaw 端的 M5 Blonde bot 已被修好（通过 `alsoAllow: ["message"]` 暴露 `message` 工具，可以直接发文件附件）。oscar-lark-bridge 这边目前**没有让 agent 主动发送飞书文件**的能力，agent 只能生成文件，然后输出"已生成 X 文件"之类的文本。

本次设计目标：让 oscar-lark-bridge 的 Claude 和 Codex profile 都能像 OpenClaw 那样，**让 agent 在对话中显式触发文件附件发送**。

设计沿用之前对话总结的三层结构：
1. `ChannelPort.sendFile` 出站接口
2. `LarkChannelGateway` 调 `@larksuite/channel` SDK 的 `channel.send({ file })`
3. 通过结构化协议让 agent 显式调用，**不从普通文本猜路径**

第 3 层的具体形态是 **MCP `send_file` 工具**——agent 写完文件后调 `send_file(path, file_name?)`，bridge 收到工具调用后调 `ChannelPort.sendFile`。

## Goals / Non-Goals

### Goals
- 用户在飞书对 oscar-lark-bridge bot 说"创建一个 Excel 发给我"或"把这个文件发给我"，bot 真的能把文件作为附件发到当前 chat。
- Claude 和 Codex 两个 profile 都支持。
- 跟 OpenClaw 的体验对齐（"Agent 自己触发"，不是 bridge 主动扫文件）。
- 失败可观测：agent 收到错误后可以自主重试或告知用户。

### Non-Goals
- 不支持一次性发多个文件（每次 send_file 一个文件）。
- 不支持 caption / 附带说明文字——文件单独一条消息。
- 不实现接收文件 / 处理飞书收到的附件（Inbound 端不动）。
- 不修改 `ChannelPort` 现有方法签名（`sendMarkdown` / `sendCard` / `streamCard` / `addReaction` / `removeReaction` 保持不变）。
- 不引入新的安全敏感机制：路径默认 allow all，依赖 SDK 自带的 `/etc/` `/proc/` `/sys/` `/dev/` blocklist。
- 不支持 bridge 重启 / SIGTERM 等冷启动恢复 send_file 请求——agent 重启后未完成的请求丢失（agent 自己会决定重试）。

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ 飞书 chatId=oc_xxx                                              │
│   │                                                             │
│   ▼                                                             │
│ LarkChannelGateway (ChannelPort 实现)                           │
│   ├─ sendMarkdown                                              │
│   ├─ sendCard                                                  │
│   ├─ streamCard                                                │
│   ├─ sendFile  ★ 新增                                          │
│   └─ addReaction / removeReaction                              │
│                                                                 │
│ ChannelPort.sendFile(chatId, source, fileName)                  │
│   → channel.send(chatId, { file: { source, fileName } })        │
│   → @larksuite/channel SDK                                     │
│      → im.file.create (上传)                                    │
│      → im.message.create (发消息)                               │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ BridgeApplication.handleMessage()                               │
│   │                                                             │
│   ▼                                                             │
│ Agent.start()                                                   │
│   ├─ claude profile → spawn claude CLI                          │
│   │   args: --mcp-config { oscar-bridge-mcp ... }               │
│   │                                                             │
│   └─ codex profile → spawn codex CLI                            │
│       args: 包含 MCP config 指向 oscar-bridge-mcp                │
│                                                                 │
│ Agent 调 send_file(path, file_name?)                            │
│   │ stdio JSON-RPC                                              │
│   ▼                                                             │
│ oscar-bridge-mcp 子进程 (stdin/stdout JSON-RPC server)          │
│   │ send_file 调用 →                                            │
│   │ Unix domain socket: /tmp/oscar-bridge-{runId}.sock          │
│   ▼                                                             │
│ bridge 进程内 socket listener                                   │
│   → ChannelPort.sendFile(chatId, source, fileName)              │
│   → 结果返回 MCP 子进程 → 通过 stdio JSON-RPC 通知 agent        │
└─────────────────────────────────────────────────────────────────┘
```

## Design Details

### Layer 1 — `ChannelPort.sendFile` 接口

文件：`src/channel/port.ts`

新增方法签名：

```typescript
export interface ChannelPort {
  // ... 现有方法保持不变 ...

  /**
   * 上传并发送一个文件到 chatId。
   *
   * @param chatId - 飞书会话 ID
   * @param source - 文件来源：本地绝对路径、http(s) URL 或 Buffer
   * @param fileName - 发送时显示的文件名（必填，SDK 要求）
   * @param options - replyTo / replyInThread
   * @returns 飞书返回的 messageId
   * @throws LarkChannelError 当 upload / send 失败时
   */
  sendFile(
    chatId: string,
    source: string | Buffer,
    fileName: string,
    options?: StreamCardOptions,
  ): Promise<{ messageId: string }>;
}
```

放在 `sendCard` 后面、`addReaction` 前面，保持出站方法的语义分组（content → reactions → lifecycle）。

### Layer 2 — `LarkChannelGateway.sendFile` 实现

文件：`src/channel/lark-channel.ts`

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

构造函数里新增配置：

```typescript
outbound: {
  streamThrottleMs: 400,
  allowedFileDirs: ['/'],  // ★ 新增：默认 allow all
},
```

SDK 在 `allowedFileDirs` 设了 `/` 之后的行为：
- 任何绝对路径都在白名单内
- `/etc/` `/proc/` `/sys/` `/dev/` 由 SDK 内置 blocklist 仍然 deny
- `http(s)://` URL 不受白名单限制
- `Buffer` 不受白名单限制

不通过环境变量暴露 `OSCAR_LARK_ALLOWED_FILE_DIRS`——MVP 范围里只 allow all，后续如果要收紧再加。

### Layer 3 — MCP `send_file` 工具

#### 3.1 MCP 子进程

新文件：`src/mcp/oscar-bridge-mcp.ts`（编译为 `dist/mcp/oscar-bridge-mcp.js`）

这是一个独立的 stdio JSON-RPC server，**不依赖任何 bridge 内部模块**，可执行性独立。

伪代码：

```typescript
// src/mcp/oscar-bridge-mcp.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { connect } from 'node:net';

const SOCKET_PATH = process.env.OSCAR_BRIDGE_SOCKET;
if (!SOCKET_PATH) throw new Error('OSCAR_BRIDGE_SOCKET is required');

const server = new Server(
  { name: 'oscar-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'send_file',
    description: 'Send a file as an attachment to the current Feishu chat. ...',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file.' },
        file_name: { type: 'string', description: 'Optional display filename. Default: basename(path).' },
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
  const { path, file_name } = request.params.arguments as { path: string; file_name?: string };
  return await callBridge('send_file', { path, file_name });
});

async function callBridge(method: string, args: unknown): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCKET_PATH);
    let buffer = '';
    let timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('bridge timeout'));
    }, 30_000);
    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        const response = JSON.parse(buffer.slice(0, nl));
        sock.end();
        resolve(response);
      }
    });
    sock.on('error', (err) => { clearTimeout(timer); reject(err); });
    sock.write(JSON.stringify({ method, args }) + '\n');
  });
}

const transport = new StdioServerTransport();
await server.connect(transport);
```

依赖：在 `package.json` 加 `@modelcontextprotocol/sdk`。

#### 3.2 Bridge 侧 socket listener

新文件：`src/mcp/bridge-mcp-listener.ts`

```typescript
import { createServer, type Server as NetServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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

  const server = createServer((sock) => {
    let buffer = '';
    sock.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      const request = JSON.parse(buffer.slice(0, nl));
      buffer = '';
      try {
        if (request.method === 'send_file') {
          const { path: filePath, file_name } = request.args as { path: string; file_name?: string };
          const result = await options.channel.sendFile(
            options.chatId,
            filePath,
            file_name ?? path.basename(filePath),
          );
          sock.write(JSON.stringify({
            content: [{ type: 'text', text: `sent as message ${result.messageId}` }],
          }) + '\n');
        } else {
          sock.write(JSON.stringify({
            content: [{ type: 'text', text: `unknown method: ${request.method}` }],
            isError: true,
          }) + '\n');
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        sock.write(JSON.stringify({
          content: [{ type: 'text', text: `send_file failed: ${msg}` }],
          isError: true,
        }) + '\n');
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    socketPath,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(socketPath).catch(() => undefined);
    },
  };
}
```

#### 3.3 Bridge 启动 agent 时注入 MCP

修改：`src/agents/claude/adapter.ts` 和 `src/agents/codex/adapter.ts`

**Claude 侧**：

`buildClaudeArgs` 当前是 argv 构造。在 run 启动前（`BridgeApplication.handleMessage`）临时生成 MCP config JSON 写到 `~/.oscar-lark-bridge/runs/{runId}/mcp-config.json`，在 argv 加 `--mcp-config <path>`。

**Codex 侧**：

Codex 的 MCP config 通过不同机制：codex 支持 `--config` 覆盖 mcp_servers 段，或者通过 `~/.codex/config.toml` 里的 `[mcp_servers.oscar_bridge]` 段。MVP 里走 `--config mcp_servers.oscar_bridge.command=...` 这种覆盖式参数（如果 codex 支持的话）；不支持的话回退到临时写 `~/.codex/config.toml`。

这是代码改动量较大的一块。Codex 的 MCP 接入方式需要查 codex CLI 文档；当前假设 `--config 'mcp_servers.oscar_bridge={...}'` 形式可用，实施时若不行再调整。

具体实现：在 `BridgeApplication.handleMessage` 里：
1. 创建 socket listener，拿到 socketPath
2. 创建临时 MCP config 文件，写入：
   ```json
   {
     "mcpServers": {
       "oscar-bridge": {
         "command": "node",
         "args": ["/abs/path/to/dist/mcp/oscar-bridge-mcp.js"],
         "env": { "OSCAR_BRIDGE_SOCKET": socketPath }
       }
     }
   }
   ```
3. 通过 `agent.start({ ..., mcpConfigPath })` 把路径传到 adapter
4. adapter 在 argv 里加 `--mcp-config <mcpConfigPath>`
5. run 结束时（无论成功/失败/取消）关闭 socket listener，删除 MCP config 文件

`AgentRunRequest` 加一个可选字段 `mcpConfigPath?: string`。

### Error Handling

**send_file 调用失败**（MCP 工具结果层）：
- 文件不存在 → `send_file failed: ENOENT: no such file or directory`
- 路径越界 → `send_file failed: permission_denied`
- 上传失败（飞书 SDK 报错） → `send_file failed: upload_failed: <detail>`
- 路径是目录 → `send_file failed: EISDIR`
- 超时（30s） → `send_file failed: bridge timeout`

以上都以 MCP `isError: true` 形式返回给 agent。**bridge 不额外给用户发任何消息**——这是用户选择的"错误返回给 agent"行为。

**socket listener 异常**：
- 子进程连不上 socket → MCP 子进程启动报错，stderr 写到 bridge stderr，run 继续（agent 没收到 send_file 工具响应，但其他工作正常）
- socket 泄漏（run 结束后未 close） → BridgeApplication.run 终态确保 close

**MCP config 文件泄漏**：
- run 结束后无论成功/失败/取消都 unlink 临时文件

### Security

- **默认 allow all 路径**：通过 `allowedFileDirs: ['/']` 配置
- **SDK 内置 blocklist**：`/etc/`、`/proc/`、`/sys/`、`/dev/` 仍然被拒
- **socket auth**：socket 在 `/tmp/` 创建后立即 `chmod 0600`。`bridge-mcp-listener` 在 `server.listen` 之前或之后显式 `chmod(socketPath, 0o600)`。socket 文件名同时含 runId + 8 位随机后缀，避免被猜到。依赖 OS 文件权限隔离，无需额外 token。
- **runId 限定**：socket 文件名含 runId 随机后缀，避免冲突
- **不暴露 Buffer source**：MVP 阶段 MCP `send_file` 只支持 `path`（字符串）；`Buffer` source 通过其他途径发送不在本设计范围
- **不暴露 URL source**：同上

### Testing

新增单测：
- `tests/channel/lark-channel.sendFile.test.ts` —— mock `@larksuite/channel`，验证 `sendFile` 调用透传
- `tests/mcp/bridge-mcp-listener.test.ts` —— 启动 listener，用 net.connect 发请求，验证响应
- `tests/mcp/oscar-bridge-mcp.test.ts` —— 启动子进程，通过 stdio JSON-RPC 调 send_file，验证流程

集成测试（人工）：
- `pnpm dev` + 给 claude profile 发消息："创建一个 hello.txt，内容是 'hi from claude'，然后调 send_file 发给我"
- 验证飞书收到 hello.txt 附件

测试环境：
- 本机 macOS + 真实的飞书 sandbox
- 不上 CI（涉及真实网络和凭证）

### Deployment

部署改动：
1. 重新构建：`pnpm build` —— `dist/` 多出 `mcp/oscar-bridge-mcp.js`
2. 重启 LaunchAgent：
   ```bash
   launchctl unload ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
   launchctl load ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
   ```
3. 用户在飞书跟 bridge 说"创建 X 发给我"，验证

不涉及数据库迁移、不涉及飞书后台配置变更。

### Open Items / Future Work

- 路径白名单收紧（按 workspace / profile 配置）
- 支持 caption / 多个文件一次发送
- 支持图片预览（image 类型）
- 接收飞书文件附件（inbound 端）
- 不重启 bridge 切换 MCP 配置

## Files Changed

| 文件 | 改动 |
|---|---|
| `package.json` | 加 `@modelcontextprotocol/sdk` 依赖 |
| `src/channel/port.ts` | `ChannelPort` 加 `sendFile` 方法 |
| `src/channel/lark-channel.ts` | `LarkChannelGateway.sendFile` 实现 + `allowedFileDirs` 配置 |
| `src/mcp/oscar-bridge-mcp.ts` | 新增：stdio JSON-RPC MCP server 子进程入口 |
| `src/mcp/bridge-mcp-listener.ts` | 新增：bridge 进程内 unix socket listener |
| `src/domain/agent.ts` | `AgentRunRequest` 加 `mcpConfigPath?: string` |
| `src/agents/claude/argv.ts` | `buildClaudeArgs` 加 `--mcp-config` 支持 |
| `src/agents/codex/argv.ts` | `buildCodexArgs` 加 MCP 配置支持 |
| `src/application/bridge-application.ts` | `handleMessage` 启动 listener、生成 MCP config、传入 agent、run 结束清理 |
| `tests/channel/lark-channel.sendFile.test.ts` | 新增单测 |
| `tests/mcp/bridge-mcp-listener.test.ts` | 新增单测 |
| `tests/mcp/oscar-bridge-mcp.test.ts` | 新增单测 |
| `docs/send-file.md` | 新增：用户文档 |

## Estimated Effort

- Layer 1+2：`ChannelPort` 接口 + LarkChannelGateway 实现 —— 1 小时
- Layer 3.1：MCP 子进程 —— 1.5 小时（含 SDK 接入）
- Layer 3.2：bridge 侧 socket listener —— 1 小时
- Layer 3.3：注入 MCP 到 claude + codex argv —— 2 小时（含 codex 的 MCP 接入方式调研）
- 单测 —— 2 小时
- 文档 —— 0.5 小时
- 集成验证 —— 1 小时

总计约 **9 小时**，可分两个 commit：
1. Layer 1 + 2 + Layer 3.2（接口 + 实现 + listener）—— 可独立工作
2. Layer 3.1 + 3.3（MCP 子进程 + 注入）—— 端到端打通
