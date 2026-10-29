# Contributing

Thanks for helping. This file is the short version; [AGENTS.md](AGENTS.md) has the exact commands and the conventions that are not obvious from the code, and [docs/DESIGN.md](docs/DESIGN.md) records why things are the way they are.

## Setup

```sh
npm ci            # Node >= 22.16, npm >= 10; also installs the git hooks (lefthook)
npm run check     # typecheck + lint + tests; what CI runs
```

Tests are offline and never read your own history. The git hooks run Biome on staged files when you commit and the typecheck when you push; skip one with `LEFTHOOK=0 git commit`.

## Package registries

Nothing here assumes the public npm registry. If your organization routes npm through a package proxy (an Azure Artifacts upstream, Artifactory, Verdaccio, …), keep that configuration where it belongs, in your user-level `~/.npmrc` or your organization's managed npm defaults, and `npm ci` just works: the committed [`.npmrc`](.npmrc) sets `omit-lockfile-registry-resolved`, so `package-lock.json` pins versions and integrity hashes but no registry URL, and every contributor's installs go through whatever registry their own npm configuration names (measured: no slower than with URLs).

Two things keep it that way, both checked by `npm run check` and by the pre-commit hook:

- The repository's `.npmrc` never names a registry or carries credentials. A repository-level `registry=` would override your organization's managed default (and fail where public registries are network-isolated).
- No lockfile entry resolves from a private feed. If a tool writes such `resolved` URLs anyway, `npm install --package-lock-only` strips them again.

Proxies commonly hold new package versions back for a few days; Dependabot's 7-day cooldown in [`.github/dependabot.yml`](.github/dependabot.yml) matches that window, so its PRs install on managed devices too. Everything else the toolchain fetches is pinned and opt-out-able: the embedding model (first use, from a pinned Hugging Face revision; `promptback.embedding.modelDir` or `package.mjs --bundle-model` for machines that cannot reach it, `hashed` for no model at all) and VS Code for the integration test. No dependency needs an install script (`npm ci --ignore-scripts` is what CI runs), so nothing reaches for NuGet or GitHub releases during install.

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

`.github/workflows/release.yml` then runs four stages: **check** (the tag is on `main` or a `release/*` branch and matches every version field) → **checks** (lint, typecheck and the full test matrix from `test.yml`, the same jobs CI runs, so the release is tested in its own right) → **build** (CLI tarball and five VSIXes, read-only token, no package cache) → **publish**. The publish job runs no build tooling at all: it downloads the artifacts, attests their provenance (`actions/attest-build-provenance`), creates the GitHub Release (draft → assets → publish, which is what release immutability needs) and publishes to each registry whose repository variable is `true`. It is the only job with a write token or an OIDC token, and it waits in the `release` environment for the maintainer's approval (**Actions → the run → Review deployments**): a leaked push credential can start a build, not a publish.

The variables are the publishing hold: with none set, a tag produces only the GitHub Release. There is no manual trigger; CI's **Build artifacts** job uploads the same tarball and VSIXes on every push, which is the dry run.

Patch releases normally come from `main`. When `main` carries unfinished work: `git switch -c release/0.8 v0.8.0`, cherry-pick with `-x`, `node scripts/release.mjs patch --push` from that branch, and copy the changelog section to `main` by hand.

After a release, anyone can check a downloaded file against what was published and how it was built (update `gh` if the commands are missing):

```sh
gh release verify v0.8.0                                     # immutable and attested
gh release verify-asset v0.8.0 promptback-vscode-0.8.0-win32-x64.vsix
gh attestation verify promptback-vscode-0.8.0-win32-x64.vsix --owner spencrr
```

| Variable | Registry | Auth | One-time setup |
|---|---|---|---|
| `PUBLISH_NPM` | npm `promptback` | trusted publishing (GitHub OIDC) | First publish by hand (`npm publish -w packages/cli --access public`), then **Package → Settings → Trusted publishing**: owner `spencrr`, repo `promptback`, workflow `release.yml`. Provenance switches on by itself once the repository is public. |
| `PUBLISH_MARKETPLACE` | VS Code Marketplace, publisher `spencrr` | `vsce publish --oidc` | Create the publisher at marketplace.visualstudio.com/manage. The Marketplace's trusted-publishing backend was still rolling out in October 2026 (microsoft/vscode-vsce#1275); until it accepts `--oidc`, publish by hand with a PAT from a machine, never from CI. |
| `PUBLISH_OPENVSX` | Open VSX, namespace `spencrr` | trusted publishing (GitHub OIDC) | Eclipse account, sign the publisher agreement, `npx ovsx create-namespace spencrr -p <token>`, then **Settings → Trusted Publishers**: owner, repo, workflow `release.yml`. |
| `PUBLISH_MCP` | MCP registry `io.github.spencrr/promptback` | GitHub OIDC (`io.github.spencrr/*`) | None; runs after npm because the registry fetches `promptback@<version>` from npm and checks its `mcpName`. |

Every publish step is idempotent for a re-run (`--skip-duplicate`; npm and the MCP registry reject the duplicate, which the step reports). Before the first tag: turn on **Settings → General → Immutable releases**, create the `release` environment with yourself as required reviewer and a `v*` tag deployment policy, and add a tag ruleset for `v*` that forbids updates and deletions.

Workflow files are linted with [zizmor](https://docs.zizmor.sh) (`uvx zizmor .github/workflows`; CI uploads its findings to code scanning). Actions are pinned to commit SHAs with a version comment, checkouts don't persist credentials, and no job that produces an artifact uses a package cache.
