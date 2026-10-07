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
- Path is outside `allowedFileDirs` (currently `['/']`, with SDK blocklist for `/etc`, `/proc`, `/sys`, `/dev`)
- Feishu upload fails (network / permission)

The agent sees the error and decides what to do — the bridge does not send any extra message to the user on failure. To recover, the agent may try a different path, regenerate the file, or report the error back to you in the streaming card.

## Security

The default `allowedFileDirs: ['/']` allows the agent to read any local file path. This is suitable for a personal-use bridge on a trusted machine. The SDK still blocks `/etc`, `/proc`, `/sys`, `/dev` from being read, so secrets under those paths cannot be exfiltrated.

If you need to restrict the agent's read scope, edit `src/channel/lark-channel.ts` and set a tighter allowlist, then rebuild.

## Architecture

- `ChannelPort.sendFile(chatId, source, fileName)` — typed outbound interface.
- `LarkChannelGateway.sendFile` — wraps `@larksuite/channel`'s `{ file: { source, fileName } }` send.
- `oscar-bridge-mcp` — stdio JSON-RPC MCP server child process exposing `send_file`.
- `bridge-mcp-listener` — unix socket listener inside the bridge, dispatches `send_file` calls to `ChannelPort.sendFile`.

For each run the bridge:

1. Creates a unix domain socket listener (path under `os.tmpdir()`, `chmod 0600`).
2. Spawns Claude/Codex with an `--mcp-config` (Claude) or `CODEX_HOME/config.toml` (Codex) pointing at the bridge-written MCP server definition.
3. After the run finishes, closes the listener and removes the run-scoped MCP config file.

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
- **Agent can't find the `send_file` tool** — check `~/.oscar-lark-bridge/logs/supervisor.stdout.log` for `MCP config written:` lines. If absent, your profile is missing `OSCAR_LARK_DATA_DIR`/data dir config.
- **Feishu rejects the upload with "permission denied"** — the Feishu app may need the `im:message` and `im:resource` scopes enabled in the developer console.
