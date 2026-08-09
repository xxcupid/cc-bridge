# Third-party notices

This project is licensed under the MIT License. It depends on and was informed by other open-source projects. The notices below distinguish code adaptation from design-only references.

## Runtime dependencies

- `@larksuite/channel` 0.4.1 — MIT License.
- `commander` 12.1.0 — MIT License.
- `cross-spawn` 7.0.6 — MIT License.

Their license texts are distributed with their respective packages.

## Adapted code

- `zarazhangrui/lark-coding-agent-bridge` (locally cloned as `feishu-claude-code-bridge`), commit `e5d3ce57ca95212cfa53965a6f2cc2d998aa691c`, MIT License. The Claude stream event shape in `src/agents/claude/stream-json.ts` contains an adapted interface block. Copyright (c) 2026 Lark Channel Bridge contributors. The complete upstream license is preserved in `LICENSES/lark-coding-agent-bridge-MIT.txt`.

## Rewritten presentation informed by an MIT project

- `larksuite/openclaw-lark`, commit `dde0be3680d6fd5443cab426c8f4b3216266346a`, MIT License. Its CardKit builder, tool-use display, reasoning panel, footer, and AskUserQuestion interaction informed Oscar's independently structured `AgentEvent` presentation layer. A cross-repository clone scan found no matching block at the configured threshold. Copyright (c) 2026 Lark Technologies Pte. Ltd. The complete upstream license is preserved in `LICENSES/openclaw-lark-MIT.txt`.

## Design-only references

- `chenhg5/cc-connect`, commit `3fc360ee6acc9bab13ab1b48ddde3af44062903b`. Referenced for Claude stdio/process lifecycle and approval concepts. A cross-repository clone scan found no matching block at the configured threshold. The pinned README labels the project “MIT License”, but the pinned repository does not contain a complete license file detectable through GitHub's license endpoint; therefore this project does not rely on that label as permission to redistribute `cc-connect` code.
- `zarazhangrui/lark-coding-agent-bridge`, at the commit above, also informed Channel SDK integration, CardKit form callbacks, and launchd boundaries beyond the specifically identified adapted interface.

No Claude Code or Codex executable is bundled. Users install and authenticate those products separately under their respective terms.

The provenance review and its detection limits are documented in `docs/code-provenance.md`.
