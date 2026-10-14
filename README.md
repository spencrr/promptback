# Promptback

**You've asked this before. Find it.**

Semantic search over every prompt you've sent to your AI coding agents: **Copilot CLI** and **autopilot** sessions, the VS Code **Agents window**, and **VS Code Chat** panel history. Local-first: prompts are embedded on your machine, and nothing leaves it unless you configure a remote embedding endpoint.

- **Your prompts, not transcripts.** It indexes the messages sent *to* the agent (by default only the ones you typed), not assistant replies or tool output, so every result is something you can reuse.
- **Hybrid ranking.** Keyword (BM25) and semantic similarity are fused adaptively. On our paraphrase benchmark (25 hard queries over ~900 real prompts) it reached MRR@10 0.51, against 0.19 for keyword search alone ([details](docs/DESIGN.md)).
- **Made to browse.** A full-screen Prompt Explorer with filters, a details pane with session context, and an animated topic graph of each query's results. Copy a prompt, insert it into chat, or resume the session it came from.
- **Agents can search it too.** An MCP server gives agents read-only tools over your history. VS Code and the Agents window pick it up from the extension automatically; Copilot CLI runs it as `promptback mcp`.

## Packages

- **`packages/core`** (`@promptback/core`): ingestion, SQLite index, pluggable embeddings, hybrid ranking and the MCP server. It has no VS Code dependency and is the API that the CLI and the extension share.
- **`packages/vscode`** (`spencrr.promptback-vscode`): the VS Code extension: Prompt Explorer, quick search, a sidebar, and the MCP server registration. See [its README](packages/vscode/README.md).
- **`packages/cli`** (`promptback`): index, search and status from a terminal, and `promptback mcp`.

Design rationale, benchmarks and the five proposals it was synthesized from are in [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Requires Node ≥ 22.13 (for `node:sqlite`).

```powershell
npm install
npm test                      # unit + engine tests (synthetic fixtures)

# CLI
npm run build -w packages/cli
npm link -w packages/cli                     # puts `promptback` on your PATH (undo: npm unlink -g promptback)
promptback index                                 # first run downloads the pinned model (~33 MB, sha256-verified) and embeds your prompts
promptback search "that prompt about the tree view design doc" --limit 5
promptback search "retry_policy repo:PyRIT after:2026-09 mode:lex"
promptback status

# VS Code extension (platform-specific VSIX with bundled model)
cd packages/vscode
node scripts/package.mjs --target win32-x64
code --install-extension promptback-0.5.1-win32-x64.vsix
node test/integration/runTest.mjs            # runs the extension in an isolated VS Code instance against your real history (read-only)
```

Then press **Ctrl+Alt+E** for the Prompt Explorer, or **Ctrl+Alt+H** for quick search. To use it inside the Agents window, accept the one-time prompt (or run **Promptback: Enable in Agents Window**) and reload that window.

Benchmark retrieval quality and latency against your own index with `npm run bench -w packages/core -- --model-dir <dir>`. It reads labelled queries from `packages/core/bench/data/*.local.json`, which are gitignored because they reference private prompts.

## Query syntax

Free text plus `repo:` `branch:` `cwd:` `after:` `before:` `on:` `from:(me|agent|skill|system|any)` `src:(cli|vscode)` `client:(agent-host|cli|autopilot|chat)` `session:` `model:` `mode:(lex|sem)` `sort:recent` `is:ack` `"exact phrase"` `-exclude`.

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

  When this file defines `promptback`, the extension stops registering its own copy. The Copilot runtime behind Agents-window sessions reads this file itself, and VS Code forwards extension servers to every agent session, so a second copy would give each session the tools twice. VS Code's own chat panel reads the file only when `chat.mcp.discovery.enabled` has `copilot` on, which is off by default in VS Code 1.141. To use the tools there, turn that on (it also brings in your other Copilot CLI servers) or remove the entry.

Each agent session starts its own server and keeps it for the session's lifetime, so an idle server holds as little as possible. It picks up new prompts when a tool is called (waiting at most 2 s) and loads the embedding model only for queries that need semantic search; keyword-only and empty queries never load it. After 5 idle minutes it releases the model and its prompt cache. Private memory, measured with Node 26 on Windows: 33 MB idle (Node alone is 19 MB), 148 MB right after a semantic search, 56 MB once released.

Tool results reach the agent's model like any other context, so a past prompt can end up in a different project or model than the one it was written for.

## Where things live

- **Index:** `~/.promptback/index.db` on every platform, with downloaded models in `~/.promptback/models`. It is shared by every VS Code window, the CLI and the MCP server. Override it with `PROMPTBACK_HOME` (or the `promptback.index.directory` setting, VS Code only). Delete the folder to reset.
- **Source settings:** the extension saves its `promptback.sources.*` settings (which sources, the Copilot home, keeping deleted sessions) in the index. The CLI and `promptback mcp` use those saved settings, so every process updates the shared index by the same rules.
- **Read-only inputs:**
  - `~/.copilot/session-state/*/events.jsonl` and `workspace.yaml`
  - `<appData>/Code*/User/workspaceStorage/*/chatSessions/*`
  - `<appData>/Code*/agentSessionData/*/session.db`
