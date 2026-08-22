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

进程外层由 Profile 隔离：一个 Profile 对应一个飞书 App、一个 Channel/Bridge 实例和一套本地状态。第一版采用每 Profile 一个 OS 进程，不引入单进程 Supervisor。

## 3. Agent 契约

每个 Adapter 实现 `start`、`cancel`、`approve` 和 `answer`；恢复所需的原生 Session ID 通过 `start` 请求的 `resumeId` 传入。输出统一为异步 `AgentEvent`：文本增量、思考增量、工具调用、审批请求、用户问题、Session 建立、错误和完成。

Claude 使用 print 模式下的双向 stream-json/stdio 控制协议：`--print --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --replay-user-messages`。当前 Claude Code 明确要求 input/output format 与 print 模式配套；缺少 `--print` 会使 JSONL stdin 不进入预期协议路径并造成任务无终态。用户消息以 JSONL 写入 stdin；权限请求从 `control_request` 转换成统一事件；飞书批准、拒绝或 AskUserQuestion 回答以 `control_response` 写回同一进程。该实现参考 `cc-connect/agent/claudecode/session.go` 的协议处理方式，但使用本项目自己的 TypeScript Adapter 和事件模型。

Codex 生产路径使用 `codex app-server --listen stdio://`。Adapter 完成 initialize、thread/start|resume、turn/start|interrupt 的 JSON-RPC 生命周期，并将 item/turn 通知映射为统一事件。服务端发起的 command/file/permissions approval 和 `request_user_input` 会暂停在同一进程内，等待飞书回调写回 JSON-RPC response。旧 `codex exec --json` Adapter 保留用于传输层回归与明确降级场景，但 CLI 默认注册 app-server Adapter。

## 4. Session 与并发

`SessionScope` 由租户、用户、聊天和话题构成。私聊可建立多个命名 Session；群话题默认独立绑定 Session。Coordinator 按 Session ID 串行：同一 Session 中的任务排队，不同 Session 可以并行，包括同一私聊中切换到另一个命名 Session 后启动的新任务。活动 Run 也按 Session ID 索引，`/stop`、`/end`、`/cd` 和 `/agent` 只取消当前选中 Session 的任务，`/new` 与 `/switch` 不会取消旧 Session。领域模型保留 Run 状态类型，但当前 P0 不持久化 Run 状态机，运行态由活动句柄与卡片事件维护。

## 5. 权限

`mode=default` 时，超过自动放行范围的动作进入 `waiting_approval` 并发送卡片；`mode=yolo` 时在 `maxAccess` 内自动允许。`maxAccess` 按 `read-only < workspace < full` 比较。审批令牌绑定 runId、sessionId、scope、操作者、动作摘要、参数指纹和过期时间，并且只能消费一次。飞书卡片不携带原始 requestId、scope 或审批参数；回调先从本地存储解析 token，再与当前活动 Run 二次匹配。

Claude 工具按最低所需访问级别分类：Read/Glob/Grep/WebSearch/WebFetch 为 `read-only`，Edit/Write/NotebookEdit/MultiEdit 为 `workspace`，Bash 和未识别工具按 `full` 处理。`yolo` 不是无条件 bypass：超过 `maxAccess` 的 control request 自动拒绝。飞书卡片回调必须同时匹配当前 scope、runId 和 requestId，旧 Run 的按钮返回过期提示。

审批卡片展示动作名称、访问级别和经过字段白名单与长度限制的必要摘要，AskUserQuestion 卡片展示实际问题正文；这些内容只用于当前聊天中的决策界面。按钮仍只携带不透明 token，不携带原始 requestId、scope 或完整参数。成功工具输出默认不进入卡片，失败工具保留最多 2000 字符的诊断摘要。

## 6. Workspace

本地目录在选择时以及每次真正启动 Agent 前执行 realpath、存在性、目录类型及危险根目录校验。重复校验用于防止持久化后目录被删除，或被替换为指向危险根目录的符号链接。命名 Workspace 只是安全路径的别名。Workspace 决定 Agent cwd，但不是安全沙箱；Claude/Codex 的权限参数仍必须与本项目权限决策一致。

## 7. 持久化

第一阶段使用本地 JSON 文件并采用原子替换写入，保存 Session 索引、Workspace 和待审批记录。服务配置保存在权限为 `0600` 的独立 JSON 文件中。当前不持久化完整 Prompt、Agent 输出、Run transcript 或 Run 摘要，避免在默认配置下扩大敏感数据落盘范围；未来如增加审计记录，需要单独定义脱敏、保留周期和清理策略。存储接口保持可替换，数据量或并发增加后可迁移 SQLite。

命名 Profile 位于 `<root>/profiles/<name>/`，独立保存 `service-env.json`、Session、Workspace、Approval 和日志。历史 `default` 继续使用根目录原布局，避免自动移动或破坏已有状态。`active-profile` 只决定没有显式 `--profile` 的交互式命令默认值；LaunchAgent 通过固定的 `run --profile <name>` 与环境文件路径绑定，不随 active profile 漂移。

## 8. 实施顺序

1. Claude 私聊流式卡片纵向闭环。
2. 取消、超时及错误恢复。
3. 命名 Session、话题隔离和并行队列。
4. default/yolo/maxAccess 与审批卡片。
5. AskUserQuestion。
6. Codex Adapter。
7. launchd/systemd、doctor 和完整验收。

## 9. macOS 服务与密钥

LaunchAgent 使用 `KeepAlive.SuccessfulExit=false`：异常退出自动拉起，正常退出不反复重启。默认 Profile 保留 `com.oscar.lark-bridge`，命名 Profile 使用 `com.oscar.lark-bridge.<profile>`。plist 只包含 Node/CLI 路径、PATH、Profile 根目录、`OSCAR_LARK_ENV_FILE` 路径和 `run --profile <name>`，不包含 App Secret。appId、appSecret、Workspace 和权限配置写入独立 JSON 文件，并在每次安装后强制设置 `0600`。`status` 与 service status 只输出非敏感元数据和日志路径。

每个进程启动前同时获取 Profile 锁和 App ID 哈希锁。同一 Profile 不能被前台与后台重复启动，同一飞书 App ID 也不能被两个 Profile 建立竞争性长连接。锁文件只保存 PID、Profile、App ID 后缀和随机所有权 token；进程退出时按 token 删除，异常退出后仅在原 PID 不存在时回收。

服务停止时先拒绝新消息，取消所有活动 Agent，等待在途消息和 Session/Workspace/Approval 原子写入完成，再断开飞书连接。单次任务默认 30 分钟超时，可通过 `OSCAR_LARK_RUN_TIMEOUT_MS` 调整或设为 `0` 禁用。取消最终由各 Adapter 的进程终止器执行：先注册退出监听并发送 SIGTERM，宽限期结束后仍未退出则升级为 SIGKILL。Codex 在 initialize、thread 或 turn 启动阶段失败时也走同一回收路径，避免孤儿 app-server。

CardKit 创建或更新失败时，Bridge 不继续留下不可见的后台任务：对应 Agent Run 会被取消，工作表情被清理，并尝试发送不包含 Prompt、审批参数或底层异常对象的通用失败提示。

## 10. 参考实现与来源记录

本项目没有整文件复制参考仓库代码。Agent 协议与生命周期经过独立 TypeScript 实现；CardKit 展示层根据 `openclaw-lark` 的 MIT 许可设计进行了改写适配，具体归属见 `THIRD_PARTY_NOTICES.md`。设计与实现时核对了以下本地版本：

- `cc-connect` commit `3fc360ee6acc9bab13ab1b48ddde3af44062903b`：参考 Claude stream-json/stdio、Codex app-server JSON-RPC、进程回收和审批生命周期。仓库 README 声明 MIT License。
- `feishu-claude-code-bridge` commit `e5d3ce57ca95212cfa53965a6f2cc2d998aa691c`：参考 Channel SDK 接入、CardKit 2.0 `form_value` 和 launchd 命令边界。MIT License。
- `openclaw-lark` commit `dde0be3680d6fd5443cab426c8f4b3216266346a`：参考并改写适配 Card Builder、工具展示、思考面板、页脚与 AskUserQuestion 交互设计。MIT License。
- `@larksuite/channel` 本地包版本 `0.4.1` 及恢复源码：作为直接运行依赖并核对事件类型、`includeRawEvent`、stream API 与安全策略。MIT License。该本地目录不是 Git checkout，因此以包版本而非 commit 标识。

若未来直接复制或大段改编参考实现，应在新增文件头或本章节补充具体源文件、commit、修改说明和许可证归属。

## 11. 工作表情生命周期

普通 Agent 任务在进入执行链时尝试向原消息添加 `Typing` 表情，并保存飞书返回的 `reaction_id`。任务正常完成、失败、取消或 Agent 启动失败时，Bridge 都按 `message_id + reaction_id` 做 best-effort 清理。表情 API 的添加或删除失败不能阻断 Agent 主链路。

工作表情属于即时确认和运行状态装饰，不参与任务状态机，也不能替代流式卡片。命令消息由 Command Router 直接处理，不添加工作表情。

## 12. 版本与分支治理

`main` 是可发布集成分支，功能和修复从独立分支通过 Pull Request 合入。未发布的用户可见变化记录在 `CHANGELOG.md` 的 `Unreleased` 部分。发布时同步更新 `package.json`、锁文件和 Changelog，再创建不可移动的 annotated `vX.Y.Z` 标签。

历史基线 `v0.1.0` 指向 `dcd8620`；其后的 `f40ff6f` 曾直接进入 `main`，现作为未发布变化记录。后续开发不再直接提交到 `main`。
