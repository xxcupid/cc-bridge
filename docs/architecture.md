# oscar-lark-bridge 技术设计

## 1. 边界

本项目直接启动并管理本机 Claude Code 和 Codex。它拥有飞书连接、消息路由、Session、Run、Workspace、权限审批、Agent 适配、事件归一化、流式卡片和本地持久化，不调用 `oscar-agent-center`。

## 2. 分层

```text
Feishu Channel Adapter
        ↓
Message / Command Router
        ↓
Session + Run Coordinator
        ↓
Permission Manager ── Approval Card
        ↓
Agent Adapter Registry
   ├── Claude Adapter
   └── Codex Adapter
        ↓
Unified AgentEvent stream
        ↓
Streaming Card Renderer
```

`channel` 负责 SDK 事件和飞书 API；`application` 编排用例；`domain` 定义稳定模型；`agents` 隔离 CLI 差异；`infrastructure` 负责进程、文件存储、日志和 daemon。

## 3. Agent 契约

每个 Adapter 实现 `start`、`resume`、`cancel`、`approve` 和 `answer`。输出统一为异步 `AgentEvent`：文本增量、思考增量、工具调用、审批请求、用户问题、Session 建立、错误和完成。

Claude 使用双向 stream-json/stdio 控制协议：`--input-format stream-json --output-format stream-json --permission-prompt-tool stdio --replay-user-messages`。用户消息以 JSONL 写入 stdin；权限请求从 `control_request` 转换成统一事件；飞书批准、拒绝或 AskUserQuestion 回答以 `control_response` 写回同一进程。该实现参考 `cc-connect/agent/claudecode/session.go` 的协议处理方式，但使用本项目自己的 TypeScript Adapter 和事件模型。

Codex 生产路径使用 `codex app-server --listen stdio://`。Adapter 完成 initialize、thread/start|resume、turn/start|interrupt 的 JSON-RPC 生命周期，并将 item/turn 通知映射为统一事件。服务端发起的 command/file/permissions approval 和 `request_user_input` 会暂停在同一进程内，等待飞书回调写回 JSON-RPC response。旧 `codex exec --json` Adapter 保留用于传输层回归与明确降级场景，但 CLI 默认注册 app-server Adapter。

## 4. Session 与并发

`SessionScope` 由租户、用户、聊天和话题构成。私聊可建立多个命名 Session；群话题默认独立绑定 Session。Coordinator 对每个 Session 使用串行队列，不同 Session 互不阻塞。Run 具有明确状态机：`queued → running → waiting_approval|waiting_answer → completed|failed|cancelled|timed_out`。

## 5. 权限

`mode=default` 时，超过自动放行范围的动作进入 `waiting_approval` 并发送卡片；`mode=yolo` 时在 `maxAccess` 内自动允许。`maxAccess` 按 `read-only < workspace < full` 比较。审批令牌绑定 runId、sessionId、scope、操作者、动作摘要、参数指纹和过期时间，并且只能消费一次。飞书卡片不携带原始 requestId、scope 或审批参数；回调先从本地存储解析 token，再与当前活动 Run 二次匹配。

Claude 工具按最低所需访问级别分类：Read/Glob/Grep/WebSearch/WebFetch 为 `read-only`，Edit/Write/NotebookEdit/MultiEdit 为 `workspace`，Bash 和未识别工具按 `full` 处理。`yolo` 不是无条件 bypass：超过 `maxAccess` 的 control request 自动拒绝。飞书卡片回调必须同时匹配当前 scope、runId 和 requestId，旧 Run 的按钮返回过期提示。

## 6. Workspace

本地目录在使用前执行 realpath、存在性、目录类型及危险根目录校验。命名 Workspace 只是安全路径的别名。Workspace 决定 Agent cwd，但不是安全沙箱；Claude/Codex 的权限参数仍必须与本项目权限决策一致。

## 7. 持久化

第一阶段使用本地 JSON 文件并采用原子替换写入，保存配置、Session 索引、Workspace、Run 摘要和待审批记录。事件 transcript 使用追加写。存储接口保持可替换，数据量或并发增加后可迁移 SQLite。

## 8. 实施顺序

1. Claude 私聊流式卡片纵向闭环。
2. 取消、超时及错误恢复。
3. 命名 Session、话题隔离和并行队列。
4. default/yolo/maxAccess 与审批卡片。
5. AskUserQuestion。
6. Codex Adapter。
7. launchd/systemd、doctor 和完整验收。

## 9. macOS 服务与密钥

LaunchAgent 使用 `KeepAlive.SuccessfulExit=false`：异常退出自动拉起，正常退出不反复重启。plist 只包含 Node/CLI 路径、PATH 和 `OSCAR_LARK_ENV_FILE` 路径。appId、appSecret、Workspace 和权限配置写入独立 JSON 文件，并在每次安装后强制设置 `0600`。`status` 与 service status 只输出非敏感元数据和日志路径。

## 10. 参考实现与来源记录

本项目没有整文件复制参考仓库代码。Agent 协议与生命周期经过独立 TypeScript 实现；CardKit 展示层根据 `openclaw-lark` 的 MIT 许可设计进行了改写适配，具体归属见 `THIRD_PARTY_NOTICES.md`。设计与实现时核对了以下本地版本：

- `cc-connect` commit `3fc360ee6acc9bab13ab1b48ddde3af44062903b`：参考 Claude stream-json/stdio、Codex app-server JSON-RPC、进程回收和审批生命周期。仓库 README 声明 MIT License。
- `feishu-claude-code-bridge` commit `e5d3ce57ca95212cfa53965a6f2cc2d998aa691c`：参考 Channel SDK 接入、CardKit 2.0 `form_value` 和 launchd 命令边界。MIT License。
- `openclaw-lark` commit `dde0be3680d6fd5443cab426c8f4b3216266346a`：参考并改写适配 Card Builder、工具展示、思考面板、页脚与 AskUserQuestion 交互设计。MIT License。
- `@larksuite/channel` 本地包版本 `0.4.1` 及恢复源码：作为直接运行依赖并核对事件类型、`includeRawEvent`、stream API 与安全策略。MIT License。该本地目录不是 Git checkout，因此以包版本而非 commit 标识。

若未来直接复制或大段改编参考实现，应在新增文件头或本章节补充具体源文件、commit、修改说明和许可证归属。
