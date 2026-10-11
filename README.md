# Yesterprompt

**You've asked this before. Find it.**

Semantic search over every prompt you've sent to your AI coding agents: **Copilot CLI** and **autopilot** sessions, the VS Code **Agents window**, and **VS Code Chat** panel history. Local-first: prompts are embedded on your machine, and nothing leaves it unless you configure a remote embedding endpoint.

- **Your prompts, not transcripts.** It indexes the messages sent *to* the agent (by default only the ones you typed), not assistant replies or tool output, so every result is something you can reuse.
- **Hybrid ranking.** Keyword (BM25) and semantic similarity are fused adaptively. On our paraphrase benchmark (25 hard queries over ~900 real prompts) it reached MRR@10 0.51, against 0.19 for keyword search alone ([details](docs/DESIGN.md)).
- **Made to browse.** A full-screen Prompt Explorer with filters, a details pane with session context, and an animated topic graph of each query's results. Copy a prompt, insert it into chat, or resume the session it came from.

Formerly `agent-window-semantic-search` (`awss`).

## Packages

- **`packages/core`** (`@yesterprompt/core`): ingestion, SQLite index, pluggable embeddings and hybrid ranking. It has no VS Code dependency and is the API that the CLI, the extension and the planned MCP server share.
- **`packages/vscode`** (`spencrr.yesterprompt`): the VS Code extension: Prompt Explorer, quick search and a sidebar. See [its README](packages/vscode/README.md).
- **`packages/cli`** (`yester`): index, search and status from a terminal.

Design rationale, benchmarks and the five proposals it was synthesized from are in [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Requires Node ≥ 22.13 (for `node:sqlite`).

```powershell
npm install
npm test                      # unit + engine tests (synthetic fixtures)

# CLI
npm run build -w packages/cli
npm link -w packages/cli                     # puts `yester` on your PATH (undo: npm unlink -g @yesterprompt/cli)
yester index                                 # first run downloads the pinned model (~33 MB, sha256-verified) and embeds your prompts
yester search "that prompt about the tree view design doc" --limit 5
yester search "retry_policy repo:PyRIT after:2026-09 mode:lex"
yester status

# VS Code extension (platform-specific VSIX with bundled model)
cd packages/vscode
node scripts/package.mjs --target win32-x64
code --install-extension yesterprompt-0.4.0-win32-x64.vsix
node test/integration/runTest.mjs            # runs the extension in an isolated VS Code instance against your real history (read-only)
```

Then press **Ctrl+Alt+E** for the Prompt Explorer, or **Ctrl+Alt+H** for quick search. To use it inside the Agents window, accept the one-time prompt (or run **Yesterprompt: Enable in Agents Window**) and reload that window.

Benchmark retrieval quality and latency against your own index with `npm run bench -w packages/core -- --model-dir <dir>`. It reads labelled queries from `packages/core/bench/data/*.local.json`, which are gitignored because they reference private prompts.

## Query syntax

Free text plus `repo:` `branch:` `cwd:` `after:` `before:` `on:` `from:(me|agent|skill|system|any)` `src:(cli|vscode)` `client:(agent-host|cli|autopilot|chat)` `session:` `model:` `mode:(lex|sem)` `sort:recent` `is:ack` `"exact phrase"` `-exclude`.

## Where things live

- **Index:** `~/.yesterprompt/index.db` on every platform, with downloaded models in `~/.yesterprompt/models`. It is shared by every VS Code window, the CLI and the MCP server. Override it with `YESTERPROMPT_HOME` (or the `yesterprompt.index.directory` setting, VS Code only). Delete the folder to reset.
- **Read-only inputs:**
  - `~/.copilot/session-state/*/events.jsonl` and `workspace.yaml`
  - `<appData>/Code*/User/workspaceStorage/*/chatSessions/*`
  - `<appData>/Code*/agentSessionData/*/session.db`
