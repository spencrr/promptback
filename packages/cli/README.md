# promptback

**You've asked this before. Get it back.** Search every prompt you've sent to your AI coding agents, from the terminal, and let agents search them over MCP.

Reads the local history of **GitHub Copilot** (Agents window, Copilot CLI, autopilot), **Claude Code**, **OpenAI Codex** and the **VS Code Chat** panel. Everything stays on your machine: the index is a SQLite file in `~/.promptback`, prompts are embedded locally with a small ONNX model, and the only network call is the one-time, SHA-256-verified model download.

```sh
npm install -g promptback          # Node >= 22.16
promptback index                   # scan and embed your history (first run downloads the model, 33 MB)
promptback search "the prompt about the retry policy" --limit 5
promptback search "tree view design doc repo:PyRIT after:2026-09 client:cli"
promptback sources                 # which sources are on and where they read from
promptback status
```

Nothing to download? `promptback search ... --no-model` searches by keywords only.

## Commands

| Command | |
|---|---|
| `promptback index [--no-embed]` | Ingest new prompts and embed them |
| `promptback search <query...> [--json] [--limit N] [--mode hybrid\|semantic\|lexical]` | Best matches, with ids and how to reopen each session |
| `promptback get <promptId>` | One prompt's full text |
| `promptback status [--json]` | Index statistics, including whether semantic search is ready |
| `promptback doctor` | Checks semantic search end to end on this machine (platform, native runtime, model, one embedding); exit code 1 when it is unavailable |
| `promptback sources [--json]` | Prompt sources and whether each is on |
| `promptback models` | Local embedding models |
| `promptback mcp` | Run the MCP server on stdio |

Options: `--index-dir <dir>` (default `~/.promptback`, or `$PROMPTBACK_HOME`), `--model <id>`, `--no-model`, `--no-download`, `--verbose`, `--version`.

Semantic search runs on Windows and Linux (x64 and arm64) and Apple silicon; elsewhere, and whenever the model cannot load, `search` falls back to keyword matches and says why on stderr. `promptback doctor` tells you what is wrong (a build for another architecture, a missing Visual C++ runtime on Windows, no model and downloads disabled, ...).

### Query syntax

Free text plus `repo:` `branch:` `cwd:` `after:` `before:` `on:` `from:(me|agent|skill|system|any)` `src:(copilot|vscode-chat|claude-code|codex)` `client:(agent-host|cli|autopilot|chat|claude|codex)` `session:` `model:` `mode:(lex|sem)` `sort:recent` `is:ack` `"exact phrase"` `-exclude`. Dates accept `2026-09-30`, `2026-09`, `7d`, `2w`, `3m`, `today`, `yesterday`.

## MCP server

`promptback mcp` serves five read-only tools over stdio: `search_prompts`, `get_prompt`, `get_session`, `list_recent_sessions`, `index_status`. For Copilot CLI, add to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "promptback": { "type": "local", "command": "promptback", "args": ["mcp"], "tools": ["*"] }
  }
}
```

Any MCP client works the same way (`command: promptback`, `args: ["mcp"]`). The server refreshes the index when a tool is called, loads the model only for queries that need it, and releases it after five idle minutes.

## Where it reads from

| Source | Location (override) |
|---|---|
| Copilot | `~/.copilot/session-state` (`$COPILOT_HOME`) |
| VS Code Chat | `<appData>/Code*/User/workspaceStorage/*/chatSessions` |
| Claude Code | `~/.claude/projects` (`$CLAUDE_CONFIG_DIR`) |
| Codex | `~/.codex/sessions` and `archived_sessions` (`$CODEX_HOME`) |

All inputs are read-only. If the VS Code extension is installed, it saves which sources are on in the shared index and the CLI follows those settings.

Part of [Promptback](https://github.com/spencrr/promptback); the VS Code extension is `spencrr.promptback-vscode`. MIT.
