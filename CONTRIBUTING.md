# Contributing

Thanks for helping. This file is the short version; [AGENTS.md](AGENTS.md) has the exact commands and the conventions that are not obvious from the code, and [docs/DESIGN.md](docs/DESIGN.md) records why things are the way they are.

## Setup

```sh
npm ci            # Node >= 22.16, npm >= 10; also installs the git hooks (lefthook)
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

One version for every package. Even minors (`0.8.x`) are releases, odd minors (`0.7.x`) pre-releases (the Marketplace convention); the tag's parity picks the channel everywhere.

```sh
git switch main && git pull
node scripts/release.mjs 0.8.0 --dry-run   # shows the files it would touch
node scripts/release.mjs 0.8.0 --push      # bumps 5 version fields + CHANGELOG, commits, tags v0.8.0, pushes
```

`.github/workflows/release.yml` then: verifies the tag points at `main` and matches every version field → `npm run check` → builds the CLI tarball, five VSIXes and `SHA256SUMS.txt` → publishes the GitHub Release (draft, assets, publish; compatible with immutable releases) → publishes to each registry whose repository variable is `true`. The variables are the publishing hold: with none set, a tag produces only the GitHub Release. Run the workflow by hand (**Actions → Release → Run workflow**) on any branch for a dry run that builds everything and publishes nothing.

| Variable | Registry | Auth | One-time setup |
|---|---|---|---|
| `PUBLISH_NPM` | npm `promptback` | trusted publishing (GitHub OIDC) | First publish by hand (`npm publish -w packages/cli --access public`), then **Package → Settings → Trusted publishing**: owner `spencrr`, repo `promptback`, workflow `release.yml`. Provenance switches on by itself once the repository is public. |
| `PUBLISH_MARKETPLACE` | VS Code Marketplace, publisher `spencrr` | `vsce publish --oidc` | Create the publisher at marketplace.visualstudio.com/manage. The Marketplace's trusted-publishing backend was still rolling out in October 2026 (microsoft/vscode-vsce#1275); until it accepts `--oidc`, publish by hand with a PAT from a machine, never from CI. |
| `PUBLISH_OPENVSX` | Open VSX, namespace `spencrr` | trusted publishing (GitHub OIDC) | Eclipse account, sign the publisher agreement, `npx ovsx create-namespace spencrr -p <token>`, then **Settings → Trusted Publishers**: owner, repo, workflow `release.yml`. |
| `PUBLISH_MCP` | MCP registry `io.github.spencrr/promptback` | GitHub OIDC (`io.github.spencrr/*`) | None; runs after npm because the registry fetches `promptback@<version>` from npm and checks its `mcpName`. |

Every publish step is idempotent for a re-run (`--skip-duplicate`; npm and the MCP registry reject the duplicate, which the job reports). Before the first tag, turn on **Settings → General → Immutable releases**.
