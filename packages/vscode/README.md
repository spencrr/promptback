# Prompt History Search

Semantic search over every prompt you have sent to Copilot agents, across all sessions:

- **Agents window** sessions (VS Code agent host)
- **Copilot CLI** and **autopilot** sessions (`~/.copilot/session-state`)
- **VS Code Chat panel** history (Stable and Insiders, every workspace)

Everything runs locally. Prompts are embedded on your machine with a small ONNX model (`bge-small-en-v1.5`, bundled), and the index lives in a per-user folder shared by every VS Code window. No prompt text leaves the machine unless you explicitly configure a remote embedding endpoint.

## Usage

### Prompt Explorer (full screen)

Press **Ctrl+Alt+E** (macOS **Cmd+Ctrl+E**), click **$(history) Prompts** in the status bar, or run **Prompt History: Open Prompt Explorer**.

- **Search bar.** Type words or a description. Results combine keyword and semantic matches; an empty query lists every prompt, newest first. Click **?** for the query syntax.
- **Filters** (left). Filter by Author (you / agent / skill / system), Source (Agents window, Copilot CLI, autopilot, Chat panel) and Repository. Each count assumes every other filter, so options never disappear. Drag across the **When** histogram to pick a date range.
- **Table** (center). Click a column header to sort; drag a header edge to resize. A **×N** badge marks prompts sent several times (forks, re-pasted prompts); **Hide duplicates** collapses them. The **Match** column shows why a row matched: **words** means it contains every search word, and the bar shows semantic similarity.
- **Graph** (center, **G**). The query sits in the middle and results ripple out around it: the closer a dot, the more relevant. Colour = repository; lines join prompts of the same session; dashed lines connect a forked session to its parent. Click a dot to select it, double-click to copy.
- **Details** (right). The full prompt with matches highlighted, buttons to **Copy**, **Insert into chat**, **Open session** and **Open as document**, and every prompt from the same session (including where a fork branched off).
- **Keyboard.** `/` focus search · `↑` `↓` move · `Enter` copy · `Ctrl+Enter` insert into chat · `O` open session · `G` toggle graph.

### Quick search

Press **Ctrl+Alt+H** (macOS **Cmd+Ctrl+H**), or run **Prompt History: Quick Search Prompt History**. Then:

- Type to search. An empty query lists your most recent prompts.
- **Enter** copies the prompt. Change this with `awss.defaultAction`.
- Each result has buttons to **Copy**, **Insert into chat** (pre-fills the chat input without sending), **Show full prompt**, and **Open / resume session**. "+N more in this session" means further matches from that session were folded away; open the Explorer to see them all.
- The **filter** button includes agent, skill and system messages. The **table** button opens the current query in the Explorer.

### Query syntax

Combine free text with filters, for example `tree view design doc repo:PyRIT after:2026-09 client:cli`.

| Filter | Meaning |
|---|---|
| `repo:`, `branch:`, `cwd:` | Substring match on session repository / branch / folder |
| `after:`, `before:`, `on:` | `2026`, `2026-09`, `2026-09-30`, `7d`, `2w`, `3m`, `today`, `yesterday` |
| `client:` | `agent-host`, `cli`, `autopilot`, `chat` |
| `src:` | `cli` (all Copilot sessions) or `vscode` (Chat panel) |
| `from:` | `me` (default), `agent`, `skill`, `system`, `any` |
| `session:`, `model:` | Session id prefix, model id substring |
| `"exact phrase"`, `-word` | Must contain / must not contain |
| `mode:lex`, `mode:sem` | Keyword-only or semantic-only |
| `sort:recent` | Newest first instead of by relevance |
| `is:ack` | Include trivial replies such as "continue" or "yes" |

### Opening a session

- **Agents window sessions** open through `vscode://agents/agent-host-session/copilotcli/<id>`.
- **Copilot CLI and autopilot sessions** can be resumed with `copilot --resume <id>`. The command is typed into a terminal for you to review before running. The Agents window only lists CLI sessions changed in the last 7 days.
- **Chat panel sessions** open as a chat editor when the current window is on that session's workspace.

## Using it inside the Agents window

The Agents window runs extensions only if they are explicitly allowed. This extension offers to enable itself once (from a normal window), or you can run **Prompt History: Enable in Agents Window**, which adds it to `extensions.supportAgentsWindow`. Then reload the Agents window. This is experimental and depends on the VS Code build.

There, the Explorer opens as a full-area tab and adapts to the narrower pane (filters move above the table, details below). The Agents window has no status bar, so use the keyboard shortcuts or the Command Palette.

## Privacy

- **Read-only access.** Session files are only ever read. The index (`index.db`) is a separate SQLite file under `%LOCALAPPDATA%\agent-window-semantic-search`, or `~/.cache/…` / `~/Library/Caches/…` on Linux and macOS. Delete that folder to forget everything.
- **Model downloads.** The default model ships inside the extension. If you pick another local model, only model files are downloaded, from a pinned Hugging Face revision verified by SHA-256. Set `awss.embedding.allowDownload` to `false` to forbid downloads.
- **Remote embeddings.** `awss.embedding.provider: "openai-compatible"` sends prompt text to the configured endpoint. Only use it with endpoints you trust, such as Azure OpenAI in your tenant or local Ollama.

## Settings

| Setting | Default | |
|---|---|---|
| `awss.defaultAction` | `copy` | What Enter does: `copy`, `insert`, `preview`, `open` |
| `awss.embedding.provider` | `local` | `local`, `openai-compatible`, `none` |
| `awss.embedding.model` | `bge-small-en-v1.5` | Or `all-MiniLM-L6-v2` (faster to index, lower quality) |
| `awss.embedding.threads` | `4` | CPU threads for local embedding |
| `awss.index.embedOrigins` | `["human"]` | Which messages get semantic embeddings; all are keyword-searchable |
| `awss.index.backgroundIntervalMinutes` | `2` | Background pick-up of new prompts |
| `awss.sources.*` | | Enable or disable sources, override `~/.copilot`, keep deleted sessions |
