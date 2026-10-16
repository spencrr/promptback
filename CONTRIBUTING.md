# Contributing

Thanks for helping. This file is the short version; [AGENTS.md](AGENTS.md) has the exact commands and the conventions that are not obvious from the code, and [docs/DESIGN.md](docs/DESIGN.md) records why things are the way they are.

## Setup

```sh
npm ci            # Node >= 22.13, npm >= 10; also installs the git hooks (lefthook)
npm run check     # typecheck + lint + tests; what CI runs
```

Tests are offline and never read your own history. The git hooks run Biome on staged files when you commit and the typecheck when you push; skip one with `LEFTHOOK=0 git commit`.

## Changes

- Open an issue first for anything beyond a small fix, especially a new prompt source or a change to ranking.
- One concern per pull request. Keep the commit messages in plain prose, like the existing history; no `Co-authored-by` trailers.
- Update the docs that users read: `README.md`, `packages/cli/README.md` (npm page), `packages/vscode/README.md` (Marketplace page). Add an entry under **Unreleased** in `CHANGELOG.md`. Record design decisions in `docs/DESIGN.md`.
- Ranking parameters change only with before/after numbers from `npm run bench`.
- Never commit anything from your own `~/.promptback`, `~/.copilot`, `~/.claude` or `~/.codex`; fixtures are synthetic.

## Adding a prompt source

A source is one plugin file plus a fixture test. Start from `packages/core/src/sources/claudeCode.ts`, read the contract in `sources/base.ts`, and see the [Extending](README.md#extending) section of the README. Classify who wrote each message (`human`, `agent`, `skill`, `system`) so injected context stays out of search results by default, and give the source an `openTargets` so sessions can be reopened.

## Releases

Maintainers cut releases with `node scripts/release.mjs <version>` and push the tag; `.github/workflows/release.yml` builds and publishes the GitHub Release.
