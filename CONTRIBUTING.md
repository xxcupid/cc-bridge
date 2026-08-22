# Contributing

Contributions are welcome through issues and pull requests once the public repository is available.

## Branch and release workflow

- Treat `main` as the releasable integration branch. Do not develop directly on it.
- Create a focused branch from the latest `main`, for example `feat/session-picker`, `fix/reaction-cleanup`, or `docs/install-guide`.
- Open a pull request and require `pnpm check` to pass before merging. Prefer squash merge so one pull request produces one focused commit on `main`.
- Keep unreleased user-visible changes in the `Unreleased` section of `CHANGELOG.md`.
- Package versions and Git tags follow SemVer. A release is complete only when `package.json` and the lockfile contain the same version, the changelog has a dated release section, and an annotated `vX.Y.Z` tag points at the release commit.
- Never move or overwrite a published release tag. Create a new patch version for corrections.

Historical note: `v0.1.0` points to commit `dcd8620`. Commit `f40ff6f` was pushed directly to `main` afterward and is therefore recorded under `Unreleased`; future work follows the branch and pull-request workflow above.

## Development

Requirements: Node.js 22.13 or newer and pnpm 10.

```bash
pnpm install
pnpm check
```

Keep changes focused, add tests for behavior changes, and do not commit credentials, local state, logs, generated `dist/`, or workspace data. Changes adapted from another project must record the source, revision, license, and nature of the adaptation in `THIRD_PARTY_NOTICES.md` and relevant source headers.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
