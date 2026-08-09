# oscar-lark-bridge

把飞书/Lark 私聊和群聊连接到本机 Claude Code 的开源 Bridge。项目也包含实验性的 Codex Adapter，但 Claude-only 是默认且完整支持的使用方式。

当前版本为 `0.1.0` Alpha：真实飞书长连接、Claude 流式回复、工具事件、审批、AskUserQuestion、原生 Session 续聊、Workspace、安全取消和 macOS launchd 已完成验证。

> 本项目不是 Anthropic、飞书/Lark 或字节跳动的官方产品，也不受其背书。Claude Code 不随本项目分发；用户必须自行安装、认证并遵守 Anthropic 的适用条款。

## 功能

- 基于 `@larksuite/channel` 的飞书长连接和 CardKit 2.0 流式卡片。
- Claude Code 双向 `stream-json`/stdio Adapter。
- 文本、思考、工具、权限、问答、完成、失败和取消等统一事件。
- `default` 审批、`yolo` 与 `maxAccess` 权限上限。
- 命名 Session、Claude 原生 Session 恢复和 Workspace 管理。
- 同一会话串行、不同会话并行。
- `/stop`、SIGTERM 和超时 SIGKILL 进程回收。
- macOS LaunchAgent 安装、状态、重启和卸载。

详细设计见 [docs/architecture.md](docs/architecture.md)，第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 前置条件

- Node.js 22.13 或更新版本。
- pnpm 10。
- 一个启用了机器人、消息事件和 `card.action.trigger` 的飞书自建应用。
- 已安装并完成认证的 Claude Code。安装与认证方式以 Anthropic 官方文档为准。

确认 Claude 可用：

```bash
claude --version
```

## 安装与构建

```bash
git clone https://github.com/xxcupid/cc-bridge.git
cd oscar-lark-bridge
pnpm install
pnpm check
```

当前不要从未知来源下载预构建产物。

## Claude-only 配置

凭据只通过环境变量或私有服务配置文件提供，不要写入仓库：

```bash
export OSCAR_LARK_APP_ID='cli_xxx'
export OSCAR_LARK_APP_SECRET='xxx'
export OSCAR_LARK_WORKSPACE='/absolute/path/to/project'
export OSCAR_LARK_DEFAULT_AGENT='claude'
export OSCAR_LARK_CLAUDE_BINARY='/absolute/path/to/claude'
export OSCAR_LARK_MODE='default'
export OSCAR_LARK_MAX_ACCESS='workspace'
```

可选变量：

- `OSCAR_LARK_DM_ALLOWLIST`：逗号分隔的用户 `open_id`。
- `OSCAR_LARK_GROUP_ALLOWLIST`：逗号分隔的群 `chat_id`。
- `OSCAR_LARK_REQUIRE_MENTION`：群聊是否必须 @机器人，默认 `true`。
- `OSCAR_LARK_DATA_DIR`：状态目录，默认 `~/.oscar-lark-bridge`。
- `OSCAR_LARK_DOMAIN`：自定义 Lark/飞书域名。

生产或共享环境应配置用户和群白名单。

## 启动与诊断

```bash
pnpm build
node dist/cli.js doctor
node dist/cli.js status
node dist/cli.js run
```

Claude-only 模式下，`doctor` 只要求 Claude 可用，未选择的 Codex 显示为 `SKIP`。`status` 只显示 App ID 后六位，不打印 App Secret。

## macOS 常驻服务

配置环境变量并完成构建后执行：

```bash
node dist/cli.js service install
node dist/cli.js service status
node dist/cli.js service restart
node dist/cli.js service stop
node dist/cli.js service start
node dist/cli.js service uninstall
```

`service install` 将受控配置写入 `~/.oscar-lark-bridge/service-env.json` 并设置为 `0600`。LaunchAgent plist 只保存该文件路径，不包含 App Secret。

## 飞书命令

- `/new [名称]`：创建并切换 Session。
- `/list`、`/sessions`：查看 Session。
- `/switch <名称或 ID 前缀>`：切换 Session。
- `/current`：查看当前 Agent、模式、Workspace 和原生会话。
- `/resume [名称或 ID 前缀]`：查看或选择可恢复 Session。
- `/end`：停止并结束当前 Session。
- `/stop`：停止当前运行中的任务。
- `/cd <路径>`：切换 Workspace 并重置原生会话。
- `/ws list|save|use|remove`：管理命名 Workspace。
- `/mode default|yolo`：切换权限模式。
- `/agent claude|codex`：切换 Adapter；Codex 属于实验性能力且需要单独安装。

`/verbose off|on|full` 是计划中的 Bridge 展示级别命令，当前尚未实现。

## 权限与安全

`default` 模式把 Claude control request 转换为飞书审批卡片。按钮只携带短时、一次性、绑定操作者和 Run 的不透明 token；原始审批参数不会进入按钮。AskUserQuestion 支持选项和自由文本表单。

`yolo` 仍受 `maxAccess` 限制，但会降低人工确认强度。未知 Claude 工具和 Bash 默认按 `full` 处理。Workspace 会执行 realpath 和危险根目录检查，但 cwd 不是操作系统沙箱。对不可信用户开放前，请使用专用系统账户、容器或额外沙箱。

日志不应包含 Prompt、审批参数、token 或 App Secret。发布日志或漏洞报告前仍应人工脱敏。

## 开发与发布

```bash
pnpm check
npm pack --dry-run
```

`pnpm check` 执行严格类型检查、全部测试和 ESM/DTS 构建。npm 包仅包含 `dist`、README、LICENSE 和第三方声明。

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

## 当前边界

- 当前常驻服务管理只支持 macOS launchd。
- 附件、引用、合并转发、表情和复杂 mention 属于后续能力。
- Codex Adapter 已实现并通过 smoke test，但本 README 的稳定使用路径只承诺 Claude-only。
- `0.x` 版本 API、命令和卡片布局可能变化。

## License

MIT。详见 [LICENSE](LICENSE)。Claude Code 和其他外部产品不包含在本许可证内。
