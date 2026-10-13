# Yesterprompt: design

This document records the decisions behind this repository. It synthesizes five independent design proposals, each written by a separate research agent from a different angle:

| # | Angle | Key contribution kept |
|---|---|---|
| 1 | Pure in-process VS Code extension (Claude Opus 5.5) | Measured models and runtimes inside VS Code's Electron Node. Showed the extension host is the **wrong** place for inference: batches take up to 3 s and RSS reaches 0.5–1.4 GB. Showed that a cap on hits per session is needed. |
| 2 | Standalone service + thin client (GPT-6 Astra) | Event logs total 2.6 GB with one 750 MB file, so ingestion must **stream**. Contributed byte cursors with head-hash rewrite detection, a single-writer lease, and the SQLite FTS5 + exact-scan storage design. |
| 3 | Retrieval quality first (Claude Opus 5.5) | Benchmarked models and fusion on the real corpus (below). Produced the ranking parameters. Found that equal-weight hybrid fusion **hurts** paraphrase queries, and that Copilot's own FTS index is not reusable. |
| 4 | Deepest VS Code / Agents-window integration (Claude Opus 5.5) | Sourced the facts about the Agents window: it opts extensions in via `extensions.supportAgentsWindow`, runs under a separate profile (so `globalStorage` is not shared), offers Quick Picks and commands but no sidebar views, and uses the `vscode://agents/...` deep link with a 7-day window for external sessions. Showed the proposed APIs add little, and the `embeddings` API is cloud-only. |
| 5 | Zero-native, portable (GPT-6 Astra) | Verified the chat mutation-log semantics for all four kinds. Argued for bundling the model for offline, proxy-free installs. Measured WASM: it works but is ~7× slower than native onnxruntime, so it is not the default. |

## Data sources (read-only)

| Source | Location | Notes |
|---|---|---|
| Copilot sessions (Agents window, CLI, autopilot) | `~/.copilot/session-state/<sdkSessionId>/events.jsonl` + `workspace.yaml` | Prompts are `type: "user.message"` with `data.content`. `data.source` is absent for typed prompts and set to `agent-*`, `skill-*` or `system` for injected messages. `isAutopilotContinuation` marks auto-continues, which are blank. Forks copy events, including their ids, into new sessions. |
| VS Code Chat panel | `<appData>/Code[ - Insiders]/User/workspaceStorage/<hash>/chatSessions/*.jsonl` (+ `globalStorage/emptyWindowChatSessions`) | `ObjectMutationLog` (`vs/workbench/contrib/chat/common/model/objectMutationLog.ts`). Kind 0 = replace state, 1 = set at path, 2 = truncate to `i` then append, 3 = set `undefined`. Replay the log, then read `requests[].message.text`. `isSystemInitiated` marks system requests. |
| Agents-window mapping | `<appData>/Code/agentSessionData/<agentHostId>/session.db` | `session_metadata.defaultChatProviderData.sdkSessionId` (and `peerChats`) maps a Copilot session to its Agents-window session for deep links. |
| `~/.copilot/session-store.db` | | **Not used.** Its `turns` table is incomplete (1,088 of 2,830 prompts), its FTS has no stemming and mixes in assistant text, and it is a live WAL database owned by the runtime. |

## Architecture

```
VS Code window(s) / Agents window             CLI (yester)          MCP server (stdio)
  extension (extension host, ~15 KB)              │                        │
    Quick Pick, commands, preview, open-session   │                        │
    └─ fork(ELECTRON_RUN_AS_NODE) ─► host.js       │                        │
                                     │            │                        │
                                     ▼            ▼                        ▼
                         ┌──────── @yesterprompt/core: PromptSearchEngine ────────┐
                         │ sources/ (streaming, incremental, read-only)           │
                         │ store.ts  node:sqlite: prompts, FTS5, chunks, vectors   │
                         │ embed/    pluggable: local ONNX | OpenAI-compatible     │
                         │ search/   query language, hybrid ranking                │
                         └────────────────────────────────────────────────────────┘
                                     │
                  ~/.yesterprompt/index.db (shared, WAL, single-writer lease)
```

- **Core has no `vscode` dependency.** The extension, the CLI and the MCP server are thin adapters over `PromptSearchEngine` (`sync`, `search`, `getPrompt`, `getSessionPrompts`, `status`).
- **Inference runs in a child process.** The child is forked with VS Code's own runtime, so there's nothing to install. It unloads the model after 15 min idle, and it is restarted if it crashes.
- **One index for all windows.** The index lives in a fixed per-user folder (`~/.yesterprompt`, or `$YESTERPROMPT_HOME`), so the main window, the Agents window (separate profile), the CLI and MCP share it. A lease row in SQLite elects a single writer. Other processes just read.
- **The index owns its source settings.** Which sources to index, the Copilot home, and whether to keep deleted sessions are saved in the index (`meta.sources`) by every process that sets them, which is the extension and the MCP server it launches. Processes that set none, such as the CLI and `yester mcp`, use the saved values. Otherwise any writer with default options, for example a Copilot CLI MCP server refreshing the index, would delete sessions that `retainDeleted` keeps and would index sources the user turned off.
- **No native modules beyond onnxruntime.** `node:sqlite` with FTS5 ships in VS Code's Electron Node 24 and in Node ≥ 22.13.

## Embeddings

- **Provider interface.** `EmbeddingProvider { info: { fingerprint, dims, local }, embedDocuments, embedQuery }`. Vectors are stored per `(fingerprint, chunk-hash)`, so switching models re-embeds in the background, and identical text (forks, re-pastes) is embedded once.
- **MVP.** `Xenova/bge-small-en-v1.5`, int8 ONNX (32 MB, 384 dims, 512 tokens, CLS pooling). It uses the query prefix `Represent this sentence for searching relevant passages: `, a pinned revision and SHA-256 hashes. It is bundled in the VSIX and runs on native onnxruntime-node (CPU, 4 threads) with the pure-JS `@huggingface/tokenizers`.
- **Alternatives.**
  - `all-MiniLM-L6-v2`: faster, lower quality.
  - `openai-compatible`: Azure OpenAI v1, Foundry, Ollama, LM Studio. This sends text off-box unless it points at loopback.

Benchmark from proposal 3: 903 deduped human prompts, 40 normal + 25 hard paraphrase queries, MRR@10.

| Config | Normal | Hard |
|---|---|---|
| BM25 (FTS5) | 0.874 | 0.190 |
| MiniLM dense | 0.833 | 0.442 |
| arctic-embed-s dense | 0.847 | 0.460 |
| **bge-small dense** | **0.902** | 0.499 |
| bge + equal-weight RRF | 0.900 | 0.336 |
| **bge + adaptive RRF (shipped)** | 0.893 | **0.510** |

Runtime measurements (proposal 1, Ryzen AI Max+ 395):
- bge-small on native CPU: about 20–44 chunks/s and 3–9 ms per warm query.
- WASM: 2–6 chunks/s.
- DirectML: slower than CPU for this model.
- Exact cosine over 4.3k vectors takes about 4 ms (35 ms at 50k), so no ANN index is needed.

## Ranking (exact parameters, `search/rank.ts`)

Search is a chain of small, pure stages (`rank.ts`), composed by `Searcher` (`searcher.ts`) over an immutable in-memory snapshot (`corpus.ts`, rebuilt only when the index revision or model changes):

1. **Parse** the query language. Allow-listed `key:value` operators only, so Windows paths and URLs stay free text.
2. **Filter** (`allowedRows`): origin, trivial acks, repo / branch / cwd / client / source / session / model / date, `-exclusions` (FTS semantics), `"phrases"` (FTS phrase match).
3. **Lexical** (`lexicalHits`): FTS5 `porter unicode61` over the full text; two lists, `AND` (every term) and `OR`.
4. **Dense** (`denseHits`): exact cosine over every embedded chunk of the allowed rows. Score per prompt = `0.5·max(chunk) + 0.5·head chunk`. Chunks are 1,434 chars (≈512 tokens) with 15% overlap and at most 12 per prompt; text beyond that is covered by lexical search. Query vectors are cached.
5. **Fuse** (`fuse`): weighted RRF, k = 60. The lexical weight is 0.8 for identifier-like queries (digits, `_./\#-`, camelCase, quotes) or queries of ≤ 3 content tokens, and 0.2 otherwise. The OR list gets 0.4× that weight; dense gets 1.0.
6. **Recency:** `× (1 + 0.15 · 2^(−age/30d))`.
7. **Present:**
   - **Quick search** (`search`): human prompts only, acks hidden, identical texts collapsed into one hit with `duplicates[]`, at most 3 hits per session with `moreInSession` reporting the rest.
   - **Explorer** (`explore`): every *matching occurrence* (no collapsing, no cap, all origins), so the client can facet, sort and group exactly. A row matches if it contains every term (`AND`), **or** its similarity is ≥ mean + **2σ** of that query's similarity distribution, **or** it is in the top 20 by fused score. An empty query returns every prompt.

**Explorer match-cutoff calibration** (65 labelled queries on the real index; `npm run bench -w packages/core`):

| Cutoff | Explore recall (normal / hard) | Matches, human (p50 / p90) |
|---|---|---|
| z ≥ 3 | 1.00 / 0.74 | 20 / 24 |
| z ≥ 2.5 | 1.00 / 0.74 | 20 / 32 |
| **z ≥ 2 (shipped)** | 1.00 / **0.78** | 31 / 79 |

Measured latencies, warm, median: quick search 11 ms, explore 7 ms. Cold: browsing all ~3.2k prompts takes 62 ms; the first semantic query (model load) takes about 0.5 s.

## Fork lineage

Copilot forks copy the parent's events, including their ids, into the new session, and prompt ids are `copilot:<session>:<eventId>`. So lineage is derived from the index itself (`corpus.ts` `withLineage`), with no extra parsing:
- **Parent:** the earlier-created session sharing the most events; ties go to the nearest ancestor.
- **Fork point:** the child's last shared prompt.

This finds 27 forked sessions in the current corpus. It needs no re-scan, and it avoids parsing the free-text `session.info` fork notices, which come in several formats and embed prompt-derived titles.

## Ingestion details

- **Streaming.** `events.jsonl` is read with a byte scanner that only materializes lines whose first 96 bytes name a wanted event type. Tool-output lines (up to hundreds of MB) are never decoded.
- **Incremental.** Each session keeps a cursor `{size, mtime, cursor, headHash(headLen)}`. Appends read only new bytes, and a rewrite or truncation triggers a re-read of that session. A trailing partial line is retried on the next sync.
- **Chat logs.** Logs are replayed whole when size or mtime changes, and the session's prompts are diffed by `requestId`.
- **Deletion.** Sessions deleted from disk are removed from the index, unless `retainDeleted` is set.
- **Agents-window databases** (~1.4k files) are cached by mtime of the db and its `-wal`.
- **Measured.** The first lexical index of 3,150 prompts takes about 24 s cold. A no-op re-sync takes about 0.5 s warm. Embedding 2,663 distinct human chunks took about 4 min on a loaded machine and runs in the background; keyword search works immediately.

## VS Code integration

- **Quick search.** A Quick Pick with live debounced search. `sortByLabel = false` is set at runtime (the setter isn't gated by the proposal) plus `alwaysShow`, to keep our ranking. Each item has Copy, Insert into chat (`workbench.action.chat.open {query, isPartialQuery}`), Preview (virtual `yesterprompt-prompt:` document) and Open session buttons. A title button hands the query to the Explorer.
- **Prompt Explorer.** A read-only **custom editor** on a virtual `yesterprompt:` file. In the Agents window, custom editors on a non-untitled resource get the whole editor area with no docked Details panel (`vs/sessions/contrib/layout/browser/desktop/desktopSharedHelpers.ts` `isEditorWithoutDockedDetails`); plain webview panels don't.
  - **Webview.** Preact, ~70 KB, styled only with theme variables. Strict CSP with no remote content (images and links could leak prompt text). Prompt text is rendered as preformatted text with highlights, never as HTML or Markdown.
  - **Data flow.** One `explore(query)` call returns every matching occurrence, from a single snapshot. Facets, counts that exclude their own filter, sorting, duplicate hiding and the date histogram are computed client-side (`webview/model.ts`, unit-tested), so filter clicks are instant and can't disagree with each other. Superseded responses are dropped by request id. Full text and session context are fetched on selection. State is restored with `setState`.
  - **Graph ("constellation").** A per-query radial layout:
    - distance from the centre = 1 − relevance (min–max normalized similarity, or rank for keyword-only results);
    - one slice of the circle per group: **topic** by default, or repository, source or session;
    - angle inside a slice = time (older → newer, clockwise);
    - edges join consecutive prompts of one session, plus dashed fork → parent links.

    When the query changes, kept nodes glide, new ones ripple out in rank order, and old ones fade; reduced motion is honored. No global 2D projection (UMAP) is used: its distances don't represent hybrid relevance, it can't place keyword-only or un-embedded rows, and it needs layout caching and relayout rules.

    An earlier version placed nodes inside a slice in rank order. Since radius also encodes rank, that drew meaningless spiral arms; angle now encodes time instead.
  - **Topics** (`core/src/search/topics.ts`). Spherical k-means on each prompt's first-chunk embedding:
    - Seeding is deterministic farthest-first, starting from the best-ranked prompt, so the same query always gives the same topics.
    - k is 3–8, chosen by the best mean silhouette; clusters smaller than 3 become "Other".
    - Up to 150 distinct prompts are clustered, your own prompts first.
    - Each topic is named after its most central prompt (BERTopic's "representative documents"). Its keywords use a class-based TF-IDF variant (cf. c-TF-IDF, Grootendorst 2022, arXiv:2203.05794) weighted by rarity across your whole history.
    - Average-linkage agglomerative clustering was tried first and rejected: on real data it chained into one giant cluster.
  - **Colours.** Okabe–Ito colour-blind-safe palette (7 colours), plus grey for "Other". The previous 6-colour palette cycled, so different repositories shared a colour.
- **Repository labels.** In order:
  1. the session's recorded repository;
  2. else the git `origin` (`owner/name`) of its folder, or the folder name if it isn't a git repository;
  3. for sessions without a repository folder (workspaceless Agents-window chats in `~/.copilot/chats/<id>`, or `~/src`), the git root that dominates the file paths in the session's tool calls (≥ 3 hits and ≥ 50%), shown as *inferred*;
  4. otherwise **No folder**, never the chat's GUID.

  Tool-call tallies are stored with the incremental read cursor and were backfilled once for existing indexes.
- **Explorer tab.** `panel.title` and `panel.iconPath` override the file name and icon (`CustomEditorInput.getName` prefers the webview title).
  - The virtual resource `yesterprompt:/Prompt Explorer` has no extension, so VS Code doesn't offer "Configure default editor for '*.x'", which is gated on `extname(resource) !== ''` in `editorResolverService.ts`.
  - "Reopen With → Text Editor" can't be hidden: the text editor is registered for `*` and extensions can't declare exclusive priority. That view explains what the page is.
  - Comparable non-file pages in other extensions (GitLens Commit Graph, GitHub PR overview) use plain webview panels. We use a custom editor only because the Agents window gives the full editor area to custom editors, not plain panels.
- **Sidebar.** An activity-bar container (main window only) with a Recent Sessions tree and an Index view. Per the VS Code UX guidelines, the container holds real views rather than acting as a button that opens an editor.
- **Open session** (`links.ts`, pure data):
  - Agents-window deep link via the agent-host mapping.
  - Best-effort link for recent CLI and autopilot sessions.
  - `copilot --resume <id>` typed, not executed, in a terminal.
  - `vscode-chat-session://local/<b64url(id)>` for chat-panel sessions, from a window on the matching workspace.
- **Agents window.** The extension offers once, from a normal window, to add itself to `extensions.supportAgentsWindow`; it can't run in the Agents window before that. The Agents window has no status bar, so the Explorer has its own keybinding (Ctrl+Alt+E). Treated as experimental.
- **Packaging.** One VSIX per platform (onnxruntime-node is native), about 33 MB for win32-x64, including the model. DirectML and DXC DLLs are pruned because we run on CPU.

## MCP server

`core/src/mcp.ts` (`@yesterprompt/core/mcp`) builds the server with the official TypeScript SDK and serves it over stdio. Two launchers share it:
- `yester mcp`;
- `dist/mcp.js` in the VSIX. VS Code starts it with its own runtime (`process.execPath` plus `ELECTRON_RUN_AS_NODE`, as the `McpStdioServerDefinition` docs suggest), and the extension passes its engine options in `YESTERPROMPT_OPTIONS`.

Design points:
- **Tools.**
  - `search_prompts` reuses the quick-search pipeline: your own prompts by default, duplicates collapsed, a cap per session.
  - `get_session` accepts a session key, a native id, an Agents-window id or a unique prefix. Long sessions show the first 20 and last 80 prompts, 400 characters each.
  - `get_prompt`, `list_recent_sessions` and `index_status` complete the set.
  - Output is plain text written for a model. Every hit carries the ids the next call needs, and cut text names the call that returns it in full.
- **Read-only.** Every tool sets `readOnlyHint: true` and `openWorldHint: false`. In `mcpLanguageModelToolContribution.ts`, VS Code skips the "Run tool" confirmation for read-only MCP tools, and asks the user to review results only for open-world ones.
- **Lean when idle.** Agent clients start one server per session and keep it for the session's lifetime. On the development machine, 12 were running by late afternoon. So an idle server must hold as little as possible.
  - When a tool is called, the server runs an incremental sync, at most once every 30 s, and waits for it at most 2 s. It embeds new prompts only after a query has already loaded the model.
  - The model loads only for queries that need semantic search (`wantsDense` in `searcher.ts`). Keyword-only (`mode:lex`) and empty queries never load it; before this rule they loaded it too, adding about 100 MB.
  - After 5 idle minutes the server releases the model and the in-memory corpus, then forces a garbage collection (`util/gc.ts`). An idle process allocates nothing, so without that collection V8 kept the freed memory indefinitely.
  - Private memory, measured with Node 26 on Windows:

    | State | Private memory |
    |---|---|
    | Bare Node | 19 MB |
    | Idle server | 33 MB |
    | Right after a semantic search | 148 MB |
    | Released | 56 MB |

    ONNX Runtime keeps about 20 MB of native state once loaded. A Node MCP server can't go much lower: the SDK and zod alone, unbundled, take 40 MB. The first search takes 1.4 s; later ones take a few milliseconds.
  - Writes take the same single-writer lease as every other process.
- **Agents window.** VS Code forwards MCP servers to agent-host sessions under the definition's label, including servers that extensions contribute (`collectNonPluginMcpServers` in `agentHostLocalCustomizations.ts`, and `agentHostMcpServerSupport.ts`). A `cwd`, a `version` or an env file makes a forwarded definition only partially supported, so the extension sets none of them.
- **One copy per session.** `~/.copilot/mcp-config.json` (or `$COPILOT_HOME/mcp-config.json`) is always read by Copilot CLI and by the Copilot runtime behind Agents-window sessions. VS Code's own chat reads it only when the `copilot` source of `chat.mcp.discovery.enabled` is on. That source is off by default in VS Code 1.141 (checked in its extension host) and on in later source (`mcpConfiguration.ts`).
  - VS Code forwards extension servers to every agent-host session it starts, and an extension can't target session types. The only server VS Code ever withholds is Copilot Chat's built-in GitHub server (`isProviderBuiltInReplacement` in `agentHostMcpServerSupport.ts`).
  - So whenever that file defines `yesterprompt`, the extension registers nothing, whatever the discovery setting, and logs why (`mcpProvider.ts`). It checks again when the file or its settings change.
  - Cost of this rule:
    - With VS Code 1.141's defaults, VS Code's own chat panel then has no Yesterprompt tools. Turning on `copilot` discovery restores them, and also brings in the file's other servers.
    - Claude and Codex sessions in the Agents window never receive Copilot-home servers (`CopilotHomeNotForwarded`), so they lose the tools as well.
  - VS Code caches extension server definitions per workspace (`mcp.extCachedServers` in `extensionMcpDiscovery.ts`) and forwards the cached copy until the extension's provider replaces it. After an upgrade that changes the provider's answer, windows need a reload.
- **Privacy.** Tool results are sent to the agent's model. Registration can be turned off with `yesterprompt.mcp.enabled`, and the server's instructions ask agents to quote only what the task needs.
- **Reviewed, then corrected.** An independent review found two issues.
  - A `yester mcp` refresh used default source settings, so it could delete sessions the extension keeps. The index now owns its source settings.
  - The step-aside check didn't follow VS Code's discovery rules. Making it follow them was still wrong: the Copilot runtime reads the file regardless, so Agents-window sessions kept getting the tools twice. A probe of VS Code 1.141's extension host showed the real defaults, and the rule is now the plain one above.

## Review log

The Explorer plan was critiqued by three independent reviewers (a neutral reviewer, Claude Opus 5.5 and GPT-6 Astra) before implementation. Changes they drove:
- Defined the explore match set before building the grid; the quick search's per-session cap and duplicate collapsing are a quick-search policy only.
- Split search into stages before building the Explorer on top of it.
- Kept command ids, regrouped settings without removing any, and hid **Search All** from the palette instead of deleting it.
- Used a custom editor (full area in the Agents window) and added a dedicated keybinding.
- Dropped UMAP in favour of a per-query graph.
- Derived fork lineage from shared event ids.
- Rendered prompts as preformatted text under a strict CSP.
- Sent all rows to the client instead of server-side paging, and did no IPC versioning (the host ships in the same VSIX).

## Roadmap

- **Optional cross-encoder rerank** ("Refine"). mxbai-rerank-xsmall helped hard queries but costs ~6 s per query.
- **Near-duplicate clustering** with MinHash. Only 21 clusters in the current corpus, so it was deferred.
- **More platforms.** macOS and Linux VSIX targets via `scripts/package.mjs --target`. A WASM fallback provider would cover platforms without onnxruntime binaries.
