# Changelog

All notable changes to this project are documented in this file. The format follows Keep a Changelog, and versions follow Semantic Versioning.

## Unreleased

### Added

- Add isolated named Profiles so one machine can connect multiple Feishu/Lark apps through independent Bridge and LaunchAgent instances.
- Add `profile create/list/show/use/remove` and `--profile` support for run, diagnostics, and service lifecycle commands.
- Add cross-process Profile and App ID locks to prevent duplicate WebSocket consumers, with stale-lock recovery.
- Add and remove a `Typing` reaction around regular Agent runs.
- Show compact `Skill` and `Terminal` tool summaries in streaming cards.
- Add a configurable per-run timeout with a 30-minute default.

### Changed

- Serialize runs by Session ID so different named Sessions can run concurrently in the same chat.
- Add concrete installation and runtime troubleshooting guidance to the README.
- Add a requirement-by-requirement P0 acceptance runbook that separates automated, local smoke, and real Feishu evidence.
- Prefer a concrete command over its human-readable description in tool cards.
- Hide successful raw tool output by default while retaining concise input details.
- Show the question text and a bounded, allowlisted action summary before the user answers or approves; callback buttons still carry only opaque tokens.
- Probe both local Agent CLIs in `doctor`, while requiring only the configured default Agent.

### Fixed

- Complete Claude and Codex card footers with the actual model, input/output and cache usage, cache hit rate, and context-window utilization when the underlying runtime reports them.
- Remove the working reaction when an Agent fails during startup.
- Route `/stop` to the active Agent cancellation path instead of treating it as an Agent prompt.
- Enforce `maxAccess` before Claude approvals in every permission mode and auto-allow default read-only control requests.
- Start Claude stream-json with `--print`, as required by current Claude Code, to prevent stdin tasks from hanging without events.
- Cancel active Agent processes before disconnecting the channel during service shutdown.
- Correct architecture documentation that overstated named-session concurrency and persisted Run state.
- Flush Session, Workspace, and approval stores before channel disconnect during graceful shutdown.
- Revalidate persisted Workspace realpaths immediately before every Agent run.
- Stop an Agent when CardKit presentation fails, and prevent background card-update promise rejections from escaping.
- Terminate Codex app-server processes when initialize, thread, or turn bootstrap fails.
- Preserve bounded failed-tool diagnostics while continuing to hide successful raw output.
- Handle child processes that exit synchronously after SIGTERM without waiting for the full grace interval.

## 0.1.0 - 2026-08-09

### Added

- Initial open-source release with Feishu long connection, Claude and experimental Codex adapters, streaming cards, approvals, resumable sessions, Workspace management, and macOS LaunchAgent support.
