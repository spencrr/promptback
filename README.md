# agent-window-semantic-search

Local semantic search over every prompt you've sent to Copilot agents: VS Code **Agents window** sessions, **Copilot CLI** and **autopilot** sessions, and **VS Code Chat panel** history. Prompts are embedded on your machine and nothing leaves it.

- **`packages/core`** (`@awss/core`): ingestion, SQLite index, pluggable embeddings and hybrid ranking. It has no VS Code dependency and is the API that the CLI, the extension and the planned MCP server share.
- **`packages/vscode`**: the VS Code extension. A full-screen **Prompt Explorer** (filterable table, a details pane with session context, and an animated graph of each query's results) plus a quick search; both copy a prompt, insert it into chat, or open/resume the session it came from. See [its README](packages/vscode/README.md).
- **`packages/cli`** (`awss`): index, search and status from a terminal.

Design rationale, benchmarks and the five proposals it was synthesized from are in [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Requires Node ≥ 22.13 (for `node:sqlite`).

```powershell
npm install
npm test                      # unit + engine tests (synthetic fixtures)

# CLI
npm run build -w packages/cli
node packages/cli/dist/cli.js index          # first run downloads the pinned model (~33 MB, sha256-verified) and embeds your prompts
node packages/cli/dist/cli.js search "that prompt about the tree view design doc" --limit 5
node packages/cli/dist/cli.js search "retry_policy repo:PyRIT after:2026-09 mode:lex"
node packages/cli/dist/cli.js status

# VS Code extension (platform-specific VSIX with bundled model)
cd packages/vscode
node scripts/package.mjs --target win32-x64
code --install-extension agent-window-semantic-search-0.1.0-win32-x64.vsix
node test/integration/runTest.mjs            # runs the extension in an isolated VS Code instance against your real history (read-only)
```

Then press **Ctrl+Alt+E** for the Prompt Explorer, or **Ctrl+Alt+H** for quick search. To use it inside the Agents window, accept the one-time prompt (or run **Prompt History: Enable in Agents Window**) and reload that window.

Benchmark retrieval quality and latency against your own index with `npm run bench -w packages/core -- --model-dir <dir>`. It reads labelled queries from `packages/core/bench/data/*.local.json`, which are gitignored because they reference private prompts.

## Query syntax

Free text plus `repo:` `branch:` `cwd:` `after:` `before:` `on:` `from:(me|agent|skill|system|any)` `src:(cli|vscode)` `client:(agent-host|cli|autopilot|chat)` `session:` `model:` `mode:(lex|sem)` `sort:recent` `is:ack` `"exact phrase"` `-exclude`.

## Where things live

- **Index:** `%LOCALAPPDATA%\agent-window-semantic-search\index.db` (macOS `~/Library/Caches/…`, Linux `~/.cache/…`). It is shared by every VS Code window, the CLI and the MCP server. Override it with `AWSS_HOME`. Delete the folder to reset.
- **Read-only inputs:**
  - `~/.copilot/session-state/*/events.jsonl` and `workspace.yaml`
  - `<appData>/Code*/User/workspaceStorage/*/chatSessions/*`
  - `<appData>/Code*/agentSessionData/*/session.db`
