# Promptback

**You've asked this before. Get it back.** Semantic search over every prompt you've sent to your AI coding agents, across all sessions:

- **GitHub Copilot**: Agents window sessions, Copilot CLI and autopilot (`~/.copilot/session-state`)
- **Claude Code**: CLI, Agent SDK and the VS Code extension (`~/.claude/projects`)
- **OpenAI Codex**: CLI, `codex exec` and the VS Code integration (`~/.codex/sessions`)
- **VS Code Chat panel** history (Stable and Insiders, every workspace)

Everything runs locally. Prompts are embedded on your machine with a small ONNX model (`bge-small-en-v1.5`, downloaded once from a pinned, SHA-256-verified revision), and the index lives in `~/.promptback`, shared by every VS Code window (including the Agents window), the `promptback` CLI and the MCP server. No prompt text leaves the machine unless you explicitly configure a remote embedding endpoint.

## Usage

### Prompt Explorer (full screen)

Press **Ctrl+Alt+E** (macOS **Cmd+Ctrl+E**), click **$(history) Prompts** in the status bar, or run **Promptback: Open Prompt Explorer**.

- **Search bar.** Type words or a description. Results combine keyword and semantic matches; an empty query lists every prompt, newest first. Click **?** for the query syntax.
- **Filters** (left). Filter by Author (you / agent / skill / system), Source (Agents window, Copilot CLI, Claude Code, Codex, Chat panel, …) and Repository. Each count assumes every other filter, so options never disappear. Drag across the **When** histogram to pick a date range.
- **Table** (center). Click a column header to sort; drag a header edge to resize. A **×N** badge marks prompts sent several times (forks, re-pasted prompts); **Hide duplicates** collapses them. The **Match** column shows why a row matched: **words** means it contains every search word, and the bar shows semantic similarity.
- **Graph** (center, **G**). The query sits in the middle and results ripple out around it: the closer a dot, the more relevant.
  - **Slices (Colour by):** by default each slice is a **topic**, a cluster of prompts with similar meaning named after its most central prompt. You can switch to colouring by repository, source or session.
  - **Angle within a slice** runs from older to newer, clockwise.
  - **Lines** join prompts of the same session; dashed lines connect a forked session to its parent.
  - **Interaction:** click a legend entry to highlight that group, click a dot to select it, and double-click to copy.
- **Group by** (table). Group rows by day, session, repository or topic.
- **Index** (toolbar, or **Promptback: Index & Model Settings**). Shows index status and live progress. Lets you choose the embedding provider and model, set threads and which messages get embedded, scan now, pause or resume embedding, and rebuild embeddings.
- **Details** (right). The full prompt with matches highlighted; Copy, Insert into chat, Open session and Document actions; and every prompt from the same session, including where a fork branched off. Rows from the selected prompt's session are tinted in the table.
- **Keyboard.** `/` focus search · `↑` `↓` move · `Enter` copy · `Ctrl+Enter` insert into chat · `O` open session · `G` toggle graph. Column headers and rows are focusable; `Enter` or `Space` activates them.

The **Source** pill shows where a prompt was sent. The **Repository** chip shows one of four things: the session's repository; a repository *inferred* from the files a folder-less chat worked on; a plain folder; or **No folder**.

### Sidebar

The **Promptback** activity-bar view lists recent sessions (Today, Yesterday, This week, Earlier). Expand a session to see its prompts, and click one to show it in the Explorer. The **Index** section summarizes indexing health. The Agents window has no activity bar, so use the keyboard shortcuts there.

### Quick search

Press **Ctrl+Alt+H** (macOS **Cmd+Ctrl+H**), or run **Promptback: Quick Search**. Then:

- Type to search. An empty query lists your most recent prompts.
- **Enter** copies the prompt. Change this with `promptback.defaultAction`.
- Each result has buttons to **Copy**, **Insert into chat** (pre-fills the chat input without sending), **Show full prompt**, and **Open / resume session**. "+N more in this session" means further matches from that session were folded away; open the Explorer to see them all.
- The **filter** button includes agent, skill and system messages. The **table** button opens the current query in the Explorer.

### Query syntax

Combine free text with filters, for example `tree view design doc repo:PyRIT after:2026-09 client:cli`.

| Filter | Meaning |
|---|---|
| `repo:`, `branch:`, `cwd:` | Substring match on session repository / branch / folder |
| `after:`, `before:`, `on:` | `2026`, `2026-09`, `2026-09-30`, `7d`, `2w`, `3m`, `today`, `yesterday` |
| `src:` | A source: `copilot`, `vscode-chat`, `claude-code`, `codex` (or `cli`, `chat`, `claude`) |
| `client:` | `agent-host`, `cli`, `autopilot`, `chat`, `claude`, `claude-sdk`, `codex`, `codex-vscode`, … |
| `from:` | `me` (default), `agent`, `skill`, `system`, `any` |
| `session:`, `model:` | Session id prefix, model id substring |
| `"exact phrase"`, `-word` | Must contain / must not contain |
| `mode:lex`, `mode:sem` | Keyword-only or semantic-only |
| `sort:recent` | Newest first instead of by relevance |
| `is:ack` | Include trivial replies such as "continue" or "yes" |

### Agent tools (MCP)

The extension registers an MCP server, so chat agents in VS Code, including Agents-window sessions, can search your prompt history themselves. Ask things like "find what I asked about the retry policy last month and reuse it". The tools are `search_prompts`, `get_prompt`, `get_session`, `list_recent_sessions` and `index_status`. All are read-only, so VS Code runs them without a confirmation prompt.

- Turn it off with `promptback.mcp.enabled`.
- Copilot CLI in a terminal can run the same server as `promptback mcp` (see the [repository README](https://github.com/spencrr/promptback#mcp-server)). If Copilot CLI's `mcp-config.json` defines a `promptback` server, the extension doesn't register its own copy, because Copilot sessions load that entry themselves. VS Code's own chat panel reads that file only when `chat.mcp.discovery.enabled` has `copilot` on.

### Opening a session

- **Agents window sessions** open through `vscode://agents/agent-host-session/copilotcli/<id>`.
- **Copilot CLI, Claude Code and Codex sessions** can be resumed with `copilot --resume <id>`, `claude --resume <id>` or `codex resume <id>`. The command is typed into a terminal in the session's folder for you to review before running. The Agents window only lists Copilot CLI sessions changed in the last 7 days.
- **Chat panel sessions** open as a chat editor when the current window is on that session's workspace.

## Using it inside the Agents window

The Agents window runs extensions only if they are explicitly allowed. This extension offers to enable itself once (from a normal window), or you can run **Promptback: Enable in Agents Window**, which adds it to `extensions.supportAgentsWindow`. Then reload the Agents window. This is experimental and depends on the VS Code build.

There, the Explorer opens as a full-area tab and adapts to the narrower pane (filters move above the table, details below). The Agents window has no status bar, so use the keyboard shortcuts or the Command Palette.

## Privacy

- **Read-only access.** Session files are only ever read. The index (`index.db`) is a separate SQLite file in `~/.promptback` (override with `PROMPTBACK_HOME` or `promptback.index.directory`). Delete that folder to forget everything.
- **Model downloads.** The default model is downloaded on first use from a pinned Hugging Face revision verified by SHA-256; only model files are downloaded, never prompt text. Set `promptback.embedding.allowDownload` to `false` to forbid downloads, point `promptback.embedding.modelDir` at a folder you copied the files to, or choose the `hashed` provider, which needs no model at all.
- **Remote embeddings.** `promptback.embedding.provider: "openai-compatible"` sends prompt text to the configured endpoint. Only use it with endpoints you trust, such as Azure OpenAI in your tenant or local Ollama. The API key is read from the environment variable you name and is never stored or logged.
- **Agent tools.** When an agent calls the MCP tools, the prompts they return become part of that agent's context and are sent to its model, which may be a different model or project than the one they were written for. Set `promptback.mcp.enabled` to `false` to keep agents out.
- **No telemetry.** The extension makes no network calls besides the two above.

## Settings

| Setting | Default | |
|---|---|---|
| `promptback.defaultAction` | `copy` | What Enter does: `copy`, `insert`, `preview`, `open` |
| `promptback.mcp.enabled` | `true` | Offer the MCP tools to chat agents (including the Agents window) |
| `promptback.embedding.provider` | `local` | `local`, `openai-compatible`, `hashed` (no model), `none` (keywords only) |
| `promptback.embedding.model` | `bge-small-en-v1.5` | Or `all-MiniLM-L6-v2` (faster to index, lower quality) |
| `promptback.embedding.modelDir` | | Folder with the model files (offline machines, or your own model described by `model.json`) |
| `promptback.embedding.threads` | `4` | CPU threads for local embedding |
| `promptback.index.embedOrigins` | `["human"]` | Which messages get semantic embeddings; all are keyword-searchable |
| `promptback.index.backgroundIntervalMinutes` | `2` | Background pick-up of new prompts |
| `promptback.sources.copilot`, `.vscodeChat`, `.agentHost`, `.claudeCode`, `.codex` | `true` | Turn a source on or off |
| `promptback.sources.copilotHome`, `.claudeCodeHome`, `.codexHome` | | Override `~/.copilot`, `~/.claude`, `~/.codex` |
| `promptback.sources.retainDeleted` | `false` | Keep prompts after their session is deleted from disk |

## Platforms and troubleshooting

Windows (x64, arm64), Linux (x64, arm64) and macOS (Apple silicon), one VSIX each because the embedding runtime is native; the Marketplace picks the right one. When installing a VSIX by hand it must match your VS Code's architecture (**Help → About**, e.g. `arm64`). Keyword search works everywhere.

If semantic search cannot run you get one warning that says why, with **Show Log** and **Use hashed embeddings** (word-overlap vectors, no native code), and the Explorer shows the reason in a banner until it is fixed. The usual causes: a VSIX built for the other architecture (the message names what the build contains); on Windows, a missing [Visual C++ Redistributable](https://learn.microsoft.com/cpp/windows/latest-supported-vc-redist) for your architecture; downloads disabled with no model installed. **Promptback: Show Index Status** and the Index panel show the same state; the CLI's `promptback doctor` checks the whole path.

Source, issues and the CLI: [github.com/spencrr/promptback](https://github.com/spencrr/promptback). MIT.
