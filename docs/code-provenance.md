# Code provenance review

Reviewed on 2026-08-09 before the first GitHub Release.

## Scope

The review compared this repository's `src` and `tests` trees with these pinned local checkouts:

- `larksuite/openclaw-lark` at `dde0be3680d6fd5443cab426c8f4b3216266346a`
- `zarazhangrui/lark-coding-agent-bridge` at `e5d3ce57ca95212cfa53965a6f2cc2d998aa691c`
- `chenhg5/cc-connect` at `3fc360ee6acc9bab13ab1b48ddde3af44062903b`

The automated pass used jscpd 4.0.5 with a minimum of 5 lines and 40 tokens, followed by manual review of the reported cross-repository match and upstream license files.

## Findings

One cross-repository match was found: the `ContentBlock` event-shape interface in `src/agents/claude/stream-json.ts` corresponds to the Claude stream translator in `lark-coding-agent-bridge`. The source file now carries an attribution header, and the upstream MIT copyright and license are preserved under `LICENSES/`.

No matching block at the configured threshold was found between this repository and `openclaw-lark`. Oscar's run-card implementation remains explicitly attributed because its interaction and presentation design was informed by OpenClaw. The upstream MIT notice is preserved under `LICENSES/` as a conservative compliance measure.

No matching block at the configured threshold was found between this repository and `cc-connect`. It is classified as a design-only reference. Because the pinned repository exposes only a short “MIT License” statement in its README and no complete license file detectable through GitHub's license endpoint, this repository does not rely on that statement to redistribute `cc-connect` code.

## Limits

Clone detection is evidence, not proof of independent creation. It can miss heavily rewritten code, short fragments, generated code, renamed structures, assets, documentation, or similarities below the configured threshold. Future contributions that copy or adapt upstream code must identify the source, pinned version, license, affected files, and required copyright notice in `THIRD_PARTY_NOTICES.md`.
