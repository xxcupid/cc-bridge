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

### Fixed

- Remove the working reaction when an Agent fails during startup.
- Route `/stop` to the active Agent cancellation path instead of treating it as an Agent prompt.
- Enforce `maxAccess` before Claude approvals in every permission mode and auto-allow default read-only control requests.
- Start Claude stream-json with `--print`, as required by current Claude Code, to prevent stdin tasks from hanging without events.
- Cancel active Agent processes before disconnecting the channel during service shutdown.
- Correct architecture documentation that overstated named-session concurrency and persisted Run state.

## 0.1.0 - 2026-08-09

### Added

- Initial open-source release with Feishu long connection, Claude and experimental Codex adapters, streaming cards, approvals, resumable sessions, Workspace management, and macOS LaunchAgent support.
