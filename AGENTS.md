# AGENTS.md

You're working on **Promptback**: local-first semantic search over every prompt a user has sent to AI coding agents (Copilot CLI and autopilot, the VS Code Agents window, VS Code Chat). It indexes the user's own prompts, not whole transcripts. It ranks them with a keyword + embedding hybrid and serves them through a VS Code extension, a CLI (`promptback`) and an MCP server.

[README.md](README.md) covers usage. [docs/DESIGN.md](docs/DESIGN.md) records why things are the way they are: benchmarks, rejected alternatives and review findings. Read the relevant section before changing ranking, ingestion, the Explorer or MCP.

## Architecture

npm workspaces, TypeScript throughout. `packages/core` ships as TypeScript source (its `exports` map points at `src/*.ts`); the CLI and the extension bundle it with esbuild.

- **`packages/core`** (`@promptback/core`) holds all the logic and must never import `vscode`.
  - `engine.ts`: `PromptSearchEngine`, the facade every surface calls.
  - `sources/`: incremental, read-only readers for Copilot `events.jsonl`, VS Code chat mutation logs, and Agents-window `session.db` links.
  - `store.ts`: the SQLite index (`node:sqlite`, FTS5, embedding BLOBs, writer lease, migrations).
  - `search/`: the query language (`query.ts`), hybrid ranking (`rank.ts`), topics, and fork lineage (`corpus.ts`). `searcher.ts` has two paths: `search` serves the quick pick (the user's own prompts, duplicates collapsed, capped per session), and `explore` returns every match for the Explorer.
  - `embed/`: local ONNX models (pinned, SHA-256-verified) and an OpenAI-compatible provider.
  - `host.ts` and `protocol.ts`: the child process the extension talks to.
  - `mcp.ts`: the MCP server.
- **`packages/cli`** (`promptback`): everything is in `src/cli.ts`.
- **`packages/vscode`** (`spencrr.promptback-vscode`):
  - `src/extension.ts`: activation, commands, status bar item, sidebar.
  - `src/hostClient.ts`: runs `dist/host.js`.
  - `src/explorer/` and `webview/`: the Prompt Explorer, a custom editor with a Preact webview. `webview/model.ts` does all filtering and faceting client-side.
  - `src/mcpProvider.ts`: registers the MCP server (`dist/mcp.js`).

## Invariants

- **Inputs are read-only.** The code never writes to what it reads: `~/.copilot/session-state`, VS Code's `workspaceStorage` and `agentSessionData`. It writes only to the index folder.
- **One shared index.** Every VS Code window (the Agents window too), the CLI and each MCP server process open `~/.promptback/index.db`. Override the location with `PROMPTBACK_HOME`, or `promptback.index.directory` in VS Code. Indexing (`engine.sync()`) runs only in the process holding the SQLite `lease` row. Schema changes must be additive migrations in `store.ts`, because older builds open the same file.
- **The index owns its source settings** (`meta.sources`). Processes that pass no source options (the CLI, `promptback mcp`) use the saved ones, so no process deletes sessions another chose to keep.
- **No model inference in the extension host.** The extension forks `dist/host.js` with VS Code's own runtime. Add host calls to `protocol.ts`, which types both ends.
- **MCP stdout is the protocol.** Nothing reachable from `serveMcp` may print to stdout. Tools stay read-only (`readOnlyHint`). They return plain text written for a model, including the ids the next call needs.
- **Privacy.** No telemetry. The product makes no network calls except the pinned model download and the opt-in OpenAI-compatible embedder. The webview has a strict CSP and renders prompt text as text, never as HTML or Markdown.
- **Ranking is measured.** Change `DEFAULT_RANKING` (`search/rank.ts`) only with before/after benchmark numbers. The benchmark is `npm run bench -w packages/core` and needs the user's labelled queries in the gitignored `bench/data/*.local.json`.

## Build and test

```
npm install                                                  # Node >= 22.13 (node:sqlite)
npm run typecheck                                            # 4 tsconfigs: strict, noUnused*, noUncheckedIndexedAccess, verbatimModuleSyntax
npm test                                                     # vitest on synthetic fixtures; one file: npx vitest run <path>
npm run build -w packages/cli                                # packages/cli/dist/cli.js
node packages/vscode/scripts/build.mjs                       # dist/{extension,host,mcp,webview}.js
node packages/vscode/scripts/package.mjs --target win32-x64  # platform VSIX with the bundled model
node packages/vscode/test/integration/runTest.mjs            # real VS Code against the user's real history (read-only), temp index
```

Run typecheck and the tests before finishing. Also run the integration test when you touch the extension, the host or `protocol.ts`.

## Conventions

- Tabs, single quotes, LF. ESM with `.js` import suffixes; `import type` for type-only imports.
- Comment only what needs explaining; give exported APIs JSDoc.
- Tests never touch real data. Use temp dirs, explicit `copilotHome`/`vscodeRoots`, and `embedding: { kind: 'none' }` or a fake provider (see `packages/core/test/engine.test.ts`).
- The webview is a browser bundle, so it imports only types from core (`@promptback/core/types`).
- Keep the four `package.json` versions in lockstep; the MCP server reports the version.
- User-visible changes update `README.md` and `packages/vscode/README.md` (the Marketplace page). Design decisions go in `docs/DESIGN.md`.
- No `Co-authored-by` trailers in commits.

## Gotchas

- `node file.ts` can't run core sources, because Node's type stripping rejects TypeScript parameter properties. Use vitest, or bundle with esbuild as the `bench` script does.
- `~/.promptback` is the user's live index. Inspect it read-only (`new DatabaseSync(file, { readOnly: true })`); never delete or rewrite it.
- If `promptback` is npm-linked, it runs this checkout's `packages/cli/dist/cli.js`, and so does any `promptback mcp` entry in `~/.copilot/mcp-config.json`. A broken CLI build then breaks the user's MCP tools in every agent session.
- VSIXes are per platform because onnxruntime-node is native; only `win32-x64` is built today. `package.mjs` downloads the model into `packages/vscode/models/`, which is gitignored.
- The Agents window runs only extensions listed in `extensions.supportAgentsWindow`. It uses its own profile and has no status bar or activity bar. That's why the Explorer is a custom editor, which gets the full editor area there, with its own keybinding.
