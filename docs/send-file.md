# Send Files via oscar-lark-bridge

oscar-lark-bridge exposes a `send_file` MCP tool to the Claude and Codex agents. After a run starts, the agent can call this tool to upload and send a local file as an attachment to the current Feishu chat.

## User-facing prompt

In a Feishu chat with the bridge bot, ask:

> 创建一个 hello.txt（内容是 "hi from claude"），然后用 send_file 工具发给我

Or simpler, with a file you already have:

> 帮我把这个文件发给我：/tmp/report.xlsx

The agent will run `send_file(path, file_name?)` on your behalf and the file lands as an attachment in the same chat.

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
- Path is relative, outside the run workspace or host temporary directories, or resolves into a blocked directory
- File is empty, is not a regular file, exceeds 30 MiB, or changes size while being read
- Feishu upload fails (network / permission)

The agent sees the error and decides what to do — the bridge does not send any extra message to the user on failure. To recover, the agent may try a different path, regenerate the file, or report the error back to you in the streaming card.

## Security

Bridge validates local paths itself before passing a Buffer to the SDK. String sources must use an absolute path and resolve inside the current run workspace, `os.tmpdir()`, or `/tmp`. Symlinks resolving outside these roots are rejected. System directories `/etc`, `/proc`, `/sys`, `/dev` (including `/private/etc`) and protected state directories `.ssh`, `.aws`, `.codex`, `.claude`, `.openclaw`, `.oscar-lark-bridge`, `.git` are blocked even inside an allowed root. Files must be regular, non-empty and at most 30 MiB. The same limit applies to Buffer sources.

These checks are Bridge-side checks; Buffer input bypasses SDK path checks. The tool does not scan contents for secrets. Generate intended attachments in the run workspace or a temporary directory. To approve additional roots, extend the explicit run roots in `BridgeApplication`; do not disable validation in the channel.

The tool is scoped to the triggering chat and inherits its reply/topic options. Only Claude and Codex runs receive MCP configuration; unrelated adapters keep their prior behavior.

## Architecture

- `ChannelPort.sendFile(chatId, source, fileName)` — typed outbound interface.
- `LarkChannelGateway.sendFile` — wraps `@larksuite/channel`'s `{ file: { source, fileName } }` send.
- `oscar-bridge-mcp` — stdio JSON-RPC MCP server child process exposing `send_file`.
- `bridge-mcp-listener` — unix socket listener inside the bridge, dispatches `send_file` calls to `ChannelPort.sendFile`.

For each run the bridge:

1. Creates a unix domain socket listener (path under `os.tmpdir()`, `chmod 0600`).
2. Writes a run-scoped JSON MCP definition. Claude uses `--mcp-config`; Codex receives `-c mcp_servers.oscar-bridge.*` command-line overrides. The existing `CODEX_HOME`, login, settings and native session store remain unchanged.
3. On completion, startup/setup failure or shutdown, destroys client sockets, closes the listener, and removes the run directory. A stalled client cannot block session cleanup.

## Deployment

After upgrading:

```bash
cd ~/projects/my_projects/oscar-lark-bridge
pnpm install
pnpm build
launchctl unload ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
launchctl load ~/Library/LaunchAgents/com.oscar.lark-bridge.supervisor.plist
```

## Troubleshooting

- **Agent says "send_file failed: channel does not support sendFile"** — bridge is running an older version without `sendFile`. Rebuild and restart the LaunchAgent.
- **Agent can't find the `send_file` tool** — confirm the profile has a data directory, runs Claude/Codex, and the built `dist/mcp/oscar-bridge-mcp.js` exists. Source-mode `pnpm dev` also requires a build. Check for `Bridge MCP setup failed` and agent startup errors.
- **Feishu rejects the upload with "permission denied"** — the Feishu app may need the `im:message` and `im:resource` scopes enabled in the developer console.

### Delivery timeouts

The MCP call allows 120 seconds for file upload plus message dispatch. If the connection closes or times out after dispatch may have begun, the result is unknown; do not automatically retry, as that could duplicate the attachment. Confirm delivery in Feishu first.

### Validation

Run `pnpm typecheck`, `pnpm build`, then `pnpm test` (the MCP child-process tests exercise the built script). Regression coverage includes Codex MCP injection across two turns without moving its home, real-path boundaries, topic reply options, idle connections, setup/startup failure and shutdown cleanup. Automated tests use fake channels and do not send real Feishu messages.
