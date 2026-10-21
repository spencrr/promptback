# AGENTS.md

You're working on **Promptback**: local-first semantic search over every prompt a user has sent to AI coding agents (Copilot CLI/autopilot and the VS Code Agents window, Claude Code, Codex, VS Code Chat). It indexes the user's own prompts, not whole transcripts, ranks them with a keyword + embedding hybrid, and serves them through a VS Code extension, a CLI (`promptback`) and an MCP server.

[README.md](README.md) covers usage and how to extend. [docs/DESIGN.md](docs/DESIGN.md) records why things are the way they are: benchmarks, rejected alternatives and review findings. Read the relevant section before changing ranking, ingestion, the Explorer or MCP.

## Commands

```
npm ci                                                       # Node >= 22.16 (node:sqlite with FTS5), npm >= 10; installs the git hooks (lefthook)
npm run check                                                # typecheck + lint + test: run before finishing
npm run typecheck                                            # 4 tsconfigs: strict, noUnused*, noUncheckedIndexedAccess, verbatimModuleSyntax
npm run lint                                                 # Biome (lint + format + import order); `npm run lint:fix` applies safe fixes
npm test                                                     # vitest, offline, on synthetic fixtures; one file: npx vitest run <path>
npm run build -w packages/cli                                # packages/cli/dist/cli.js (the e2e test builds this itself)
node packages/vscode/scripts/build.mjs                       # dist/{extension,host,mcp,webview}.js
node packages/vscode/scripts/package.mjs --target win32-x64  # platform VSIX; add --bundle-model for an offline VSIX
node packages/vscode/test/integration/runTest.mjs            # real VS Code against the user's real history (read-only), temp index
node packages/cli/dist/cli.js doctor                         # platform, native runtime, model, one embedding; exit 1 when semantic search is unavailable
npm run bench                                                # retrieval benchmark; needs gitignored packages/core/bench/data/*.local.json
node scripts/release.mjs <version|patch|minor|major> --push  # from main: lockstep version bump + CHANGELOG + commit + tag + push; release.yml takes over
```

Also run the integration test when you touch the extension, the host, the webview or `protocol.ts`. CI runs lint, the tests on Linux/macOS/Windows × Node 22/24/26, and builds every artifact.

## Architecture

npm workspaces, TypeScript throughout, one Biome config. `packages/core` ships as TypeScript source (its `exports` map points at `src/*.ts`); the CLI and the extension bundle it with esbuild, so core is never published.

- **`packages/core`** (`@promptback/core`) holds all the logic and must never import `vscode`.
  - `engine.ts`: `PromptSearchEngine`, the facade every surface calls. `sync()` runs every registered source, then embeds.
  - `registry.ts`: the generic `Registry` + `parseOptions` (zod). Every pluggable concept goes through one.
  - `sources/`: `base.ts` is the plugin contract; `registry.ts` registers the built-ins (`copilot`, `vscode-chat`, `agent-host`, `claude-code`, `codex`); `sessionFiles.ts` is the shared loop for whole-file logs.
  - `embed/`: provider registry (`local` ONNX, `openai-compatible`, `hashed`, `none`), pinned model specs + `model.json` manifests, the model store. `ort.ts` loads onnxruntime-node and turns loader failures into a diagnosis (`NativeRuntimeError`: wrong-architecture build, missing VC++ runtime, unsupported platform).
  - `store.ts`: the SQLite index (`node:sqlite`, FTS5, chunks, embedding BLOBs, writer lease, migrations).
  - `search/`: query language (`query.ts`), hybrid ranking (`rank.ts`), topics, fork lineage (`corpus.ts`). `searcher.ts` has two paths: `search` for the quick pick, `explore` for the Explorer.
  - `host.ts` / `protocol.ts`: the child process the extension talks to. `mcp.ts`: the MCP server.
- **`packages/cli`** (`promptback` on npm): `src/cli.ts`; `server.json` is the MCP registry manifest.
- **`packages/vscode`** (`spencrr.promptback-vscode`): `src/extension.ts` (activation, commands, settings → engine options), `src/hostClient.ts`, `src/explorer/` + `webview/` (Preact custom editor; `webview/model.ts` filters and facets client-side), `src/mcpProvider.ts`.

## Invariants

- **Inputs are read-only.** Never write to `~/.copilot`, `~/.claude`, `~/.codex` or VS Code's storage. Only the index folder is written.
- **One shared index.** Every process opens `~/.promptback/index.db` (`PROMPTBACK_HOME`, or `promptback.index.directory`). Indexing runs only in the process holding the SQLite `lease` row. Schema changes are additive migrations in `store.ts`; older builds open the same file.
- **The index owns its source settings** (`meta.sources`, version 2, per-source options; version 1 is still read). Processes that pass no `sources` (CLI, `promptback mcp`) use the saved ones.
- **Registries, not name switches.** New sources, providers and models register a plugin with a zod `options` schema. Labels, icons, `src:`/`client:` aliases, open targets and settings all derive from the plugin. Plugin interfaces use method signatures on purpose (bivariance lets plugins with specific option types share one registry).
- **No model inference in the extension host.** The extension forks `dist/host.js`; host calls are typed in `protocol.ts`.
- **MCP stdout is the protocol.** Nothing reachable from `serveMcp` may print to stdout. Tools stay read-only (`readOnlyHint`) and return plain text for a model, including the ids the next call needs.
- **Privacy.** No telemetry. Network only for the pinned model download and the opt-in OpenAI-compatible embedder, both through an injectable `fetch`. API keys are read from a user-named env var, never stored or logged (`OpenAICompatibleEmbeddingProvider.toJSON` redacts). The webview has a strict CSP (crypto nonce) and renders prompt text as text, never HTML/Markdown.
- **Ranking is measured.** Change `DEFAULT_RANKING` only with before/after benchmark numbers.
- **Degradation is announced, never silent.** When the model cannot load, results still come back (keywords) but carry `semantic: { state: 'failed', reason }`; every surface shows the reason. The engine never switches providers on its own (that would change the index's vectors and hide the problem); the user is offered `hashed`. Load the native runtime before fetching a model.

## Conventions

- Tabs, single quotes, 120 columns, LF, UTF-8 (`.editorconfig`, Biome). ESM with `.js` import suffixes; `import type` for type-only imports. JSON files use two spaces because npm rewrites `package.json` that way.
- Every stable Biome group is on. Disabled rules are listed in `biome.jsonc` with a reason each. Suppress inline only per file/range/line with a reason (`// biome-ignore <rule>: why`); never silence a rule globally to make a finding go away.
- No shell-string execution: `execFile`/`fork` with argument arrays and `process.execPath`; scripts are resolved with `require.resolve`. Session ids go into terminal commands only when `isShellSafeId` says so.
- Every stochastic step is seeded or cryptographic: k-means uses deterministic farthest-first seeding, the hashed embedder takes a seed, nonces come from `node:crypto`.
- Cache keys cover what changes results: vectors are keyed by model fingerprint + chunk-text hash; chunking options are recorded in `meta.chunking` and a change re-chunks everything; source cursors carry a `version` to force re-reads when a projection changes.
- Tests never touch real data or the network (`test/setup.ts` stubs `fetch` and points default homes at an empty folder). Use temp dirs, explicit `sources: { <id>: { home } }`, and `embedding: { kind: 'none' | 'hashed' }` or a fake provider. The e2e test (`packages/cli/test`) spawns the built CLI.
- Comment only what needs explaining; exported APIs get JSDoc.
- Keep the four `package.json` versions and `server.json` in lockstep (`versions.test.ts` enforces it; `scripts/release.mjs` does the bump). The MCP server reports the version. User-visible changes get a line under **Unreleased** in `CHANGELOG.md`.
- User-visible changes update `README.md`, `packages/cli/README.md` (npm page) and `packages/vscode/README.md` (Marketplace page). Design decisions go in `docs/DESIGN.md`.
- No `Co-authored-by` trailers in commits.
- Git hooks (`lefthook.yml`): Biome on staged files at commit, `npm run typecheck` at push. `LEFTHOOK=0` skips once. They are installed by the root `prepare` script, so `npm ci --ignore-scripts` needs a manual `npx lefthook install`.
- Node policy: `engines.node` is the floor (22.16, the first 22.x whose `node:sqlite` has FTS5; Maintenance LTS until 2027-04-30), `.node-version` and `@types/node` track it, and the CI matrix adds the newer LTS lines. Bump the floor when 22 reaches end of life or a dependency forces it; Dependabot is told not to bump `@types/node` majors on its own.
- Releases: odd minor = pre-release, even = release (Marketplace convention, applied to every registry). `release.yml` publishes to a registry only when its `PUBLISH_*` repository variable is `true`; none are set while publishing is on hold. All registry auth is GitHub OIDC; the MCP server is `io.github.spencrr/promptback` for that reason. See CONTRIBUTING.md → Releases.
- Dependencies: Dependabot runs weekly with a 7-day cooldown; dev-tooling minors/patches arrive as one grouped PR, majors (TypeScript, Vitest, Preact, vsce) are taken deliberately. Actions are pinned to commit SHAs. `npm ci --ignore-scripts` in CI; no dependency may need an install script.

## Gotchas

- `node file.ts` can't run core sources (TypeScript parameter properties defeat type stripping). Use vitest, or bundle with esbuild as `bench` and `examples/run.mjs` do.
- `~/.promptback` is the user's live index. Inspect it read-only (`new DatabaseSync(file, { readOnly: true })`); never delete or rewrite it.
- If `promptback` is npm-linked, it runs this checkout's `packages/cli/dist/cli.js`, and so does any `promptback mcp` entry in `~/.copilot/mcp-config.json`. A broken CLI build then breaks the user's MCP tools in every agent session.
- npm ≥ 11.19 blocks dependency install scripts; `allowScripts` in the root `package.json` denies ours on purpose (onnxruntime ships CPU binaries; esbuild uses optional packages). Older npm runs onnxruntime's postinstall, which downloads CUDA binaries on linux-x64 unless `ONNXRUNTIME_NODE_INSTALL=skip` (CI sets it).
- onnxruntime-node 1.30 ships win32-x64/arm64, linux-x64/arm64 and darwin-arm64 only (`ONNX_RUNTIME_TARGETS`); `package.mjs` refuses other targets and stages one platform's binaries per VSIX. VS Code installs a VSIX for the wrong architecture without complaint; the result is `Cannot find module '../bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node'`, which `ort.ts` turns into "only contains binaries for win32-x64, not win32-arm64". Windows builds of onnxruntime.dll link the VC++ runtime (MSVCP140, VCRUNTIME140); without it the load fails with "The specified module could not be found". Intel Macs get the `hashed` provider or keyword search. `ort.test.ts` runs a real inference on every CI cell, including the arm64 runners.
- Biome's unsafe fixes change semantics (`Boolean(x)` drops narrowing, `noConsole` deletes calls, hook deps get rewritten). Review every `--unsafe` diff.
- The Agents window runs only extensions listed in `extensions.supportAgentsWindow`, uses its own profile and has no status bar or activity bar; that's why the Explorer is a custom editor with its own keybinding.
