# P0 acceptance runbook

This runbook separates automated evidence, local Agent smoke tests, and real Feishu end-to-end evidence. A lower layer does not prove a higher layer.

## Current test configuration

- Default Agent: `claude`
- Permission mode: `default`
- `maxAccess`: `workspace`
- Run timeout: 30 minutes
- Service: macOS LaunchAgent using the repository's built `dist/cli.js`

Never paste the App Secret, access tokens, prompts containing private data, or approval parameters into an issue or test report.

## Preflight

```bash
node --version
OSCAR_LARK_ENV_FILE="$HOME/.oscar-lark-bridge/service-env.json" node dist/cli.js doctor
OSCAR_LARK_ENV_FILE="$HOME/.oscar-lark-bridge/service-env.json" node dist/cli.js status
node dist/cli.js service status
```

Expected: Node 22.13 or newer, all selected-Agent checks pass, the service is running, and the long-connection log reaches `ws client ready`.

## Real Feishu acceptance sequence

Run these commands in the test bot's private chat. Capture the final card and behavior, but redact identifiers before sharing.

### Claude message and card

1. Send `/new claude-e2e`.
2. Send `/agent claude`.
3. Send `/mode default`.
4. Send `/current` and verify Agent, mode, Workspace, and native session state.
5. Send `只回复 OSCAR_P0_OK，不要使用工具`.

Expected: the source message receives a `Typing` reaction, one streaming card is updated in place, the card reaches completed state with elapsed time and `OSCAR_P0_OK`, and the reaction is removed.

### Stop and Session resume

1. Start a Claude request that takes long enough to remain running.
2. While its card is running, send `/stop`.
3. Verify the card reaches a stopped terminal state and the working reaction disappears.
4. Send a normal follow-up in the same Session and verify `/current` contains a native session ID.
5. Restart the LaunchAgent, then send `/resume` and another follow-up.

Expected: `/stop` is handled by the Bridge rather than passed to the Agent; the process exits through cancellation; after restart, the same named Session and native resume ID remain usable.

### AskUserQuestion and approval

1. Ask Claude to use `AskUserQuestion` with two harmless choices.
2. Submit one choice in the card.
3. Ask Claude to make a harmless Workspace-level edit in a disposable test Workspace.
4. Approve it from the requesting user account.

Expected: the question pauses and resumes the same process; the approval card contains an opaque one-time token rather than raw Agent parameters; another user cannot operate it; replay and expired actions are rejected.

With `maxAccess=workspace`, a Bash/full request must be denied even if mode is `default`; it must not become an approvable bypass. In `yolo`, Workspace-level actions may auto-run, while full actions remain denied.

### Named Session concurrency

1. In `alpha`, start a request that remains running.
2. Send `/new beta` while alpha is still running, then start a beta request.
3. Verify beta begins without cancelling alpha.
4. Switch back with `/switch alpha`; `/stop` should stop alpha only.

Expected: runs inside one Session serialize; alpha and beta can run concurrently in the same private chat.

### Codex through Feishu

1. Send `/new codex-e2e`.
2. Send `/agent codex`.
3. Send `/current` and verify Codex is selected.
4. Send `只回复 OSCAR_CODEX_FEISHU_OK，不要使用工具`.
5. Send a follow-up in the same Session, restart the service, and send another follow-up.

Expected: Codex uses the same streaming card model, records a native thread ID, resumes through `thread/resume`, and preserves the Session across restart.

## Evidence ledger

| Requirement | Current evidence | Status |
|---|---|---|
| Typecheck, tests, build | Node 26; 24 files and 80 tests; ESM/DTS build | Passed |
| Channel connection and service | LaunchAgent running; `ws client ready` | Passed |
| Claude Adapter protocol and permissions | Automated stdio tests; historical real Feishu run | Latest real Feishu regression pending |
| Codex Adapter | Real local app-server smoke returned `OSCAR_CODEX_OK`; protocol tests; bootstrap failure terminates the child process | Real Feishu E2E pending |
| Streaming card, tool/thinking, throttle | Renderer and presenter tests; successful tool output is compact; failed output remains bounded; CardKit failure cancels the invisible Agent run | Latest real Feishu regression pending |
| Stop, shutdown and process escalation | Command integration plus SIGTERM/SIGKILL race tests; shutdown cancels runs and flushes all stores before disconnect | Real Feishu stop pending |
| AskUserQuestion and approval | Bridge token/form integration tests | Real Feishu interaction pending |
| Session concurrency and persistence | Same/different Session integration tests plus JSON reload tests | Real Feishu concurrency/restart pending |
| Workspace selection and persistence | Command, path-policy, JSON reload tests, and realpath revalidation immediately before every Agent start | Real Feishu command regression pending |

P0 is accepted only when every pending real Feishu row has been exercised against the latest deployed build.

## Multi-Profile acceptance

Automated and local CLI checks must prove:

1. Two named Profiles resolve to different `service-env.json`, Session, Workspace, Approval, log, plist, and LaunchAgent label paths.
2. `profile create/list/show/use` never prints App Secret and writes credential files with mode `0600`.
3. `status`, `doctor`, `run`, and every `service` lifecycle command accept `--profile`.
4. The legacy `default` keeps the historical root layout and `com.oscar.lark-bridge` label.
5. A duplicate Profile process or duplicate App ID is rejected; different Profile/App pairs can run concurrently; stale locks are reclaimable.

Real multi-App acceptance requires two disposable Feishu applications:

1. Create `work-claude` and `personal-codex` with distinct App IDs.
2. Install and start both profile services, then verify both dynamic LaunchAgent labels are loaded with different PIDs and log directories.
3. Send a unique marker to each bot and verify each reply uses its own Workspace, Agent, Session store, and card stream.
4. Restart only one Profile and prove the other bot remains connected and its PID is unchanged.
5. Attempt to configure a third Profile with one existing App ID and verify the second consumer is refused.

The structural and local CLI portions are automated. Real two-App Feishu evidence remains pending until a second disposable application is supplied; do not describe it as production E2E before that run.
