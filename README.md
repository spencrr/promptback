# Promptback

**You've asked this before. Get it back.**

Semantic search over every prompt you've sent to your AI coding agents: **GitHub Copilot** (the VS Code Agents window, Copilot CLI, autopilot), **Claude Code**, **OpenAI Codex** and the **VS Code Chat** panel. Local-first: prompts are indexed and embedded on your machine, and nothing leaves it unless you configure a remote embedding endpoint.

- **Your prompts, not transcripts.** It indexes the messages sent *to* the agent (by default only the ones you typed), not assistant replies or tool output, so every result is something you can reuse.
- **Hybrid ranking.** Keyword (BM25) and semantic similarity are fused adaptively. On our paraphrase benchmark (25 hard queries over ~900 real prompts) it reached MRR@10 0.51, against 0.19 for keyword search alone ([details](docs/DESIGN.md#embeddings)).
- **Made to browse.** A full-screen Prompt Explorer with filters, a details pane with session context, and an animated topic graph of each query's results. Copy a prompt, insert it into chat, or resume the session it came from.
- **Agents can search it too.** An MCP server gives agents read-only tools over your history. VS Code and the Agents window pick it up from the extension; everything else runs `promptback mcp`.
- **Pluggable.** Prompt sources, embedding providers and local models are registries with validated options. Adding a source is one file ([how](#extending)).

## Packages

| Package | What it is | Where it ships |
|---|---|---|
| [`packages/vscode`](packages/vscode/README.md) | The VS Code extension (`spencrr.promptback-vscode`): Prompt Explorer, quick search, sidebar, MCP registration | VS Code Marketplace / Open VSX, one VSIX per platform |
| [`packages/cli`](packages/cli/README.md) | `promptback`: index, search and inspect from a terminal; `promptback mcp` serves the tools over stdio | npm (`promptback`) and the MCP registry (`io.github.spencrr/promptback`) |
| [`packages/core`](packages/core/README.md) | Ingestion, SQLite index, ranking, embeddings, sources and the MCP server. No VS Code dependency | Bundled into the two above; not published on its own |

The three share one index, so whatever indexed your history last is what every surface searches.

## Quick start

Requires **Node ≥ 22.16** (for `node:sqlite` with FTS5) and npm ≥ 10. Everything below works offline except the one-time model download.

```sh
git clone https://github.com/spencrr/promptback.git
cd promptback
npm ci
npm test                                   # 98 tests on synthetic fixtures; never touches your history

# CLI
npm run build -w packages/cli
node packages/cli/dist/cli.js index        # scans ~/.copilot, ~/.claude, ~/.codex and VS Code; first run downloads the model (33 MB, SHA-256-verified)
node packages/cli/dist/cli.js search "that prompt about the tree view design doc" --limit 5
node packages/cli/dist/cli.js sources      # which sources are on, and where they read from
npm link -w packages/cli                   # optional: puts `promptback` on your PATH (undo: npm unlink -g promptback)

# VS Code extension (one VSIX per platform; the model is downloaded on first use)
node packages/vscode/scripts/package.mjs --target win32-x64     # or linux-x64, linux-arm64, win32-arm64, darwin-arm64
code --install-extension packages/vscode/promptback-vscode-0.6.0-win32-x64.vsix
```

Then press **Ctrl+Alt+E** (macOS **Cmd+Ctrl+E**) for the Prompt Explorer, or **Ctrl+Alt+H** for quick search. To use it inside the Agents window, accept the one-time prompt (or run **Promptback: Enable in Agents Window**) and reload that window.

No model, no download: pass `--no-model` to the CLI (keyword search only), or set `promptback.embedding.provider` to `hashed` (word-overlap vectors, works everywhere) or `none`. See [`examples/`](examples/README.md) for runnable scripts, including one that needs nothing beyond Node.

### Platforms

| | x64 | arm64 |
|---|---|---|
| Windows | semantic | semantic |
| Linux | semantic | semantic |
| macOS | keyword or `hashed` (no onnxruntime-node build) | semantic |

"Semantic" means the local ONNX model; keyword search works everywhere. The VSIX must match your VS Code's architecture (**Help → About** shows it, e.g. `arm64`): VS Code installs a mismatched VSIX without complaint, and semantic search then reports that the build only contains binaries for the other architecture. On Windows the runtime needs the [Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist) for the same architecture (`vc_redist.arm64.exe` on ARM PCs). CI runs the tests, including a real ONNX inference, on Windows and Linux for both architectures and on Apple silicon.

### When semantic search is unavailable

Keyword search keeps working and every surface says why semantic search did not run: the CLI on stderr, MCP results in their first line, the Explorer in a banner, VS Code in a one-time warning with a **Use hashed embeddings** shortcut. `promptback doctor` checks the whole path (platform, native runtime, model, one embedding) and exits 1 when it fails; paste its output into a bug report.

### Query syntax

Free text plus `repo:` `branch:` `cwd:` `after:` `before:` `on:` `from:(me|agent|skill|system|any)` `src:(copilot|vscode-chat|claude-code|codex)` `client:(agent-host|cli|autopilot|chat|claude|codex)` `session:` `model:` `mode:(lex|sem)` `sort:recent` `is:ack` `"exact phrase"` `-exclude`. Dates accept `2026-09-30`, `2026-09`, `7d`, `2w`, `3m`, `today`, `yesterday`.

## Architecture

```
VS Code window(s) / Agents window                 promptback (CLI)             MCP clients (stdio)
  extension host (thin: commands, quick pick,         │                             │
  Explorer webview, sidebar, MCP registration)        │                             │
    └─ fork(dist/host.js)                             │                             │
                      ▼                               ▼                             ▼
            ┌──────────────────── @promptback/core: PromptSearchEngine ─────────────────────┐
            │ sources/   registry of readers: copilot, vscode-chat, agent-host links,         │
            │            claude-code, codex (incremental, read-only)                          │
            │ embed/     registry of providers: local ONNX (pinned models), openai-compatible, │
            │            hashed (no model), none; local models have a registry + model.json    │
            │ store.ts   node:sqlite: prompts, FTS5, chunks, vectors, writer lease, migrations │
            │ search/    query language, hybrid ranking, topics, fork lineage                  │
            │ mcp.ts     read-only tools for agents                                             │
            └──────────────────────────────────────────────────────────────────────────────────┘
                                                 │
                        ~/.promptback/index.db  (shared, WAL, single writer at a time)
```

- **Inputs are read-only.** Session files are only ever read; the index is a separate SQLite file.
- **One shared index** at `~/.promptback` (override with `PROMPTBACK_HOME`, or `promptback.index.directory` in VS Code). A lease row elects a single writer; everyone else reads. Schema changes are additive, so older and newer builds can share a file.
- **The index owns its source settings.** The extension saves which sources are on and where they read from; the CLI and `promptback mcp` use the saved settings unless told otherwise, so no process deletes sessions another chose to keep.
- **No inference in the extension host.** The extension forks a child process with VS Code's own Node; the model loads only for queries that need it and is released when idle.

[docs/DESIGN.md](docs/DESIGN.md) records the decisions: benchmarks, rejected alternatives, review findings.

## Sources

| Source | Reads | Clients it labels |
|---|---|---|
| `copilot` | `~/.copilot/session-state/<id>/events.jsonl` + `workspace.yaml` (`$COPILOT_HOME`) | Agents window, Copilot CLI, Autopilot |
| `vscode-chat` | `<appData>/Code*/User/workspaceStorage/*/chatSessions/*` | Chat panel |
| `agent-host` | `<appData>/Code*/agentSessionData/*/session.db` (links Copilot sessions to Agents-window sessions; no prompts) | |
| `claude-code` | `~/.claude/projects/<project>/<session>.jsonl` (`$CLAUDE_CONFIG_DIR`) | Claude Code, Claude Agent SDK, Claude Code (VS Code) |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` and `archived_sessions` (`$CODEX_HOME`) | Codex CLI, Codex exec, Codex (VS Code) |

Each source classifies who wrote a message (`human`, `agent`, `skill`, `system`, `autopilot`), so sub-agent prompts, injected context and slash commands stay out of your results unless you ask (`from:any`). Each session can be reopened: Agents-window deep links, `copilot --resume`, `claude --resume`, `codex resume`, or the chat editor.

### Roadmap: more sources

Candidates, roughly by how many people would benefit. Locations are from public documentation or inspection and should be re-verified before implementing; a source is about 150 lines plus a fixture test (see [Extending](#extending)).

| Tool | Where its history lives (to verify) |
|---|---|
| Cursor | `<appData>/Cursor/User/workspaceStorage/*/state.vscdb` (SQLite; chat data in `ItemTable`) and `globalStorage/state.vscdb` |
| Cline / Roo Code | `<appData>/Code/User/globalStorage/<publisher.extension>/tasks/<id>/api_conversation_history.json` |
| Gemini CLI | `~/.gemini/tmp/<project-hash>/` session logs |
| Continue | `~/.continue/sessions/*.json` |
| Aider | `.aider.chat.history.md` in each repository |
| OpenCode | `~/.local/share/opencode/` (SQLite) |
| Windsurf | `<appData>/Windsurf/User/workspaceStorage/*/state.vscdb` |
| ChatGPT / Claude.ai exports | `conversations.json` from the account export (one-off import rather than a live source) |

## MCP server

Agents get five read-only tools:

| Tool | Returns |
|---|---|
| `search_prompts(query, limit?)` | The best matches for a query (same syntax as above), with prompt and session ids |
| `get_prompt(id)` | One prompt's full text, its session, and how to reopen that session |
| `get_session(session_id, include_all_authors?)` | A session's details and your prompts in order (a unique id prefix works) |
| `list_recent_sessions(limit?)` | Your most recently active sessions |
| `index_status()` | Index size, freshness and whether semantic search is ready |

- **VS Code and the Agents window:** nothing to set up. The extension registers the server, and VS Code forwards it to Agents-window sessions. Turn it off with `promptback.mcp.enabled`.
- **Copilot CLI and other MCP clients:** run `promptback mcp` over stdio. For Copilot CLI, add it to `~/.copilot/mcp-config.json`:

  ```json
  {
    "mcpServers": {
      "promptback": { "type": "local", "command": "promptback", "args": ["mcp"], "tools": ["*"] }
    }
  }
  ```

  When this file defines `promptback`, the extension stops registering its own copy, because the Copilot runtime behind Agents-window sessions reads this file itself and the tools would appear twice. VS Code's own chat panel reads the file only when `chat.mcp.discovery.enabled` has `copilot` on.

Each agent session starts its own server and keeps it for the session's lifetime, so an idle server holds as little as possible: it refreshes the index when a tool is called (waiting at most 2 s), loads the embedding model only for queries that need it, and releases the model and its prompt cache after 5 idle minutes. Measured on Windows with Node 26: 33 MB private memory idle, 148 MB right after a semantic search, 56 MB once released.

Tool results reach the agent's model like any other context, so a past prompt can end up in a different project or model than the one it was written for.

## Extending

Every pluggable concept is a registry of plugins with a [zod](https://zod.dev) schema for its options, so configuration is validated with readable errors and nothing dispatches on names.

- **A prompt source** implements `PromptSourcePlugin` (`packages/core/src/sources/base.ts`): an `id`, a `label`, an `options` schema extending `baseSourceOptions`, the `clients` it produces (label, icon, colour, query aliases), `sync(options, ctx)` and optionally `openTargets(session)`. `sync` is incremental and idempotent: compare what is on disk with the cursors saved through `ctx.store.loadFileStates`, write only the difference, and drop sessions whose files disappeared unless `ctx.retainDeleted`. Whole-file logs can use the shared `syncSessionFiles` loop (`sources/sessionFiles.ts`); `claudeCode.ts` is the model to copy. Register it with `promptSources.register(plugin)` before opening an engine, and its `src:`/`client:` aliases, labels and icons flow through to the CLI, the MCP server and the Explorer. [`examples/custom-source.ts`](examples/custom-source.ts) does this end to end.
- **An embedding provider** implements `EmbeddingProviderPlugin` (`packages/core/src/embed/registry.ts`) and returns an `EmbeddingProvider` whose `info.fingerprint` changes whenever its vectors become incomparable. Register it with `embeddingProviders.register(plugin)`; the `hashed` provider is the smallest example.
- **A local model** is a validated spec (`localModelSpecSchema`). Built-ins are pinned to a Hugging Face revision with SHA-256 hashes. Point `promptback.embedding.modelDir` (or `--model-dir` in the benchmark) at a folder containing the files and a `model.json` with the same shape to use your own ONNX model without changing code.

Ranking parameters (`search/rank.ts`) are deliberately not pluggable: change them only with before/after numbers from `npm run bench -w packages/core`, which needs your own labelled queries in the gitignored `packages/core/bench/data/*.local.json`.

## Where things live

- **Index:** `~/.promptback/index.db` on every platform, with downloaded models in `~/.promptback/models`. Delete the folder to reset.
- **Source settings:** saved in the index by the extension (`promptback.sources.*`), used by the CLI and `promptback mcp`.
- **Read-only inputs:** see [Sources](#sources).

## Contributing

`npm ci` installs the dependencies and the git hooks; `npm run check` runs typecheck, lint (Biome) and the tests; CI runs them on Linux, macOS and Windows with Node 22, 24 and 26 and builds every artifact. See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for the exact commands and conventions, [CHANGELOG.md](CHANGELOG.md) for what changed, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities. Licensed under [MIT](LICENSE).
