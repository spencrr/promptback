# Promptback: design

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
| Claude Code | `~/.claude/projects/<encoded cwd>/<sessionId>.jsonl` (`$CLAUDE_CONFIG_DIR`) | One JSON object per line; prompts are `type: "user"` with `message.content` as a string or `[{ type: "text", text }]` blocks (`tool_result` blocks are tool output, not prompts). `isSidechain` marks sub-agent conversations (the parent agent's prompts; stored in the same file), `isMeta` and `turnOrigin: "task_notification"` mark injected messages, `promptSource: "sdk"` marks Agent SDK input, `entrypoint` (`cli`, `sdk-ts`, `claude-vscode`) names the client. Injected text starts with a tag (`<task-notification>`, `<command-name>`, `<local-command-stdout>`, `<ide_opened_file>`, …) and compaction inserts "This session is being continued…" as a user message. `ai-title` / `summary` lines carry the title; `assistant` lines carry `message.model`. Measured on 78 files / 36.8 MB: 2,305 user lines, 33 of them typed prompts. |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` and `archived_sessions` (`$CODEX_HOME`) | First line `session_meta` (`id`, `cwd`, `originator` such as `codex_cli_rs` or `vscode_agent_host`, `git.{branch,repository_url}`, `source` is an object for sub-agent threads). Prompts are `response_item` with `payload.type: "message"`, `role: "user"` and `input_text` blocks; older rollouts carry them only as `event_msg` / `user_message`. `turn_context.model` is the model of the following turn. Injected context starts with `<environment_context>`, `<subagent_notification>`, `<turn_aborted>` or `<side-chat-context>`. || `~/.copilot/session-store.db` | | **Not used.** Its `turns` table is incomplete (1,088 of 2,830 prompts), its FTS has no stemming and mixes in assistant text, and it is a live WAL database owned by the runtime. |

## Architecture

```
VS Code window(s) / Agents window             CLI (promptback)          MCP server (stdio)
  extension (extension host, ~15 KB)              │                        │
    Quick Pick, commands, preview, open-session   │                        │
    └─ fork(ELECTRON_RUN_AS_NODE) ─► host.js       │                        │
                                     │            │                        │
                                     ▼            ▼                        ▼
                         ┌──────── @promptback/core: PromptSearchEngine ────────┐
                         │ sources/ (streaming, incremental, read-only)           │
                         │ store.ts  node:sqlite: prompts, FTS5, chunks, vectors   │
                         │ embed/    pluggable: local ONNX | OpenAI-compatible     │
                         │ search/   query language, hybrid ranking                │
                         └────────────────────────────────────────────────────────┘
                                     │
                  ~/.promptback/index.db (shared, WAL, single-writer lease)
```

- **Core has no `vscode` dependency.** The extension, the CLI and the MCP server are thin adapters over `PromptSearchEngine` (`sync`, `search`, `getPrompt`, `getSessionPrompts`, `status`).
- **Inference runs in a child process.** The child is forked with VS Code's own runtime, so there's nothing to install. It unloads the model after 15 min idle, and it is restarted if it crashes.
- **One index for all windows.** The index lives in a fixed per-user folder (`~/.promptback`, or `$PROMPTBACK_HOME`), so the main window, the Agents window (separate profile), the CLI and MCP share it. A lease row in SQLite elects a single writer. Other processes just read.
- **The index owns its source settings.** Which sources to index, the Copilot home, and whether to keep deleted sessions are saved in the index (`meta.sources`) by every process that sets them, which is the extension and the MCP server it launches. Processes that set none, such as the CLI and `promptback mcp`, use the saved values. Otherwise any writer with default options, for example a Copilot CLI MCP server refreshing the index, would delete sessions that `retainDeleted` keeps and would index sources the user turned off.
- **No native modules beyond onnxruntime.** `node:sqlite` with FTS5 ships in VS Code's Electron Node 24 and in Node ≥ 22.13.

## Embeddings

- **Provider interface.** `EmbeddingProvider { info: { fingerprint, dims, local }, embedDocuments, embedQuery }`. Vectors are stored per `(fingerprint, chunk-hash)`, so switching models re-embeds in the background, and identical text (forks, re-pastes) is embedded once.
- **MVP.** `Xenova/bge-small-en-v1.5`, int8 ONNX (32 MB, 384 dims, 512 tokens, CLS pooling). It uses the query prefix `Represent this sentence for searching relevant passages: `, a pinned revision and SHA-256 hashes. It is downloaded on first use (see *Model distribution* below) and runs on native onnxruntime-node (CPU, 4 threads) with the pure-JS `@huggingface/tokenizers`.
- **Alternatives.**
  - `all-MiniLM-L6-v2`: faster, lower quality.
  - `openai-compatible`: Azure OpenAI v1, Foundry, Ollama, LM Studio. This sends text off-box unless it points at loopback.
  - `hashed`: feature hashing of word unigrams and bigrams into 256 buckets (Weinberger et al. 2009), no model and no native code. It approximates word overlap, so it finds few paraphrases, but it keeps the whole pipeline (vectors, topics, similarity bars) working on platforms without onnxruntime binaries (Intel Macs) and in tests. It is the shipped dependency-free fallback.

- **Model distribution.** Early VSIXes bundled the 33 MB model, so every extension update re-shipped it and the npm CLI could never have it. Now every surface downloads it on first use from the pinned revision and verifies SHA-256, into `~/.promptback/models`, which the CLI, the MCP server and the extension share. Offline machines use `promptback.embedding.modelDir` / a copied folder, `package.mjs --bundle-model` for an offline VSIX, or the `hashed` provider. Downloads are refused for manifests without pinned hashes.

- **When the runtime cannot load (`embed/ort.ts`).** The first real-world failure was a win32-x64 VSIX installed on arm64 VS Code: VS Code does not reject a VSIX for another target, each VSIX stages one platform's onnxruntime binaries, and the loader's `Cannot find module '../bin/napi-v6/win32/arm64/onnxruntime_binding.node'` reached the user verbatim after a 33 MB model download, while every surface still said "warming up". Decisions:
  - The native runtime is loaded before the model is resolved, so the cheap check fails first.
  - Loader errors are classified from `code`, the message and `requireStack` into one sentence with the remedy: which targets the installation contains versus the running process (wrong-architecture build); the missing Visual C++ runtime on Windows, with the installer for the running architecture (both `onnxruntime.dll` builds import MSVCP140/VCRUNTIME140, verified from their import tables; DirectML is loaded lazily, so pruning it from the VSIX is safe); no onnxruntime-node build for the platform, pointing at `hashed`; a dependency problem on Linux.
  - Results carry a `SemanticStatus` (`ready | pending | off | failed + reason`) next to the older `semanticUnavailable` flag, so surfaces can distinguish "still embedding" from "broken" from "turned off" instead of guessing. `off` is now silent in the Explorer (it used to show "warming up" forever).
  - No automatic provider fallback. Switching to `hashed` would change the index's vectors and hide the problem; the user is told and offered the switch (one VS Code warning per session, `promptback doctor` in the CLI).
  - Search-triggered loads back off for 30 s after a failure so typing in the Explorer does not retry a download or a `dlopen` per keystroke; syncs always retry, so **Scan now** and `promptback index` pick up a fixed installation.
  - `ort.test.ts` runs a real inference through a 60-byte hand-encoded ONNX graph (`y = Identity(x)`) on every CI cell, and the matrix includes `windows-11-arm` and `ubuntu-24.04-arm` (standard runners, free minutes for private repos too); `macos-latest` is arm64 already.

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

- **Quick search.** A Quick Pick with live debounced search. `sortByLabel = false` is set at runtime (the setter isn't gated by the proposal) plus `alwaysShow`, to keep our ranking. Each item has Copy, Insert into chat (`workbench.action.chat.open {query, isPartialQuery}`), Preview (virtual `promptback-prompt:` document) and Open session buttons. A title button hands the query to the Explorer.
- **Prompt Explorer.** A read-only **custom editor** on a virtual `promptback:` file. In the Agents window, custom editors on a non-untitled resource get the whole editor area with no docked Details panel (`vs/sessions/contrib/layout/browser/desktop/desktopSharedHelpers.ts` `isEditorWithoutDockedDetails`); plain webview panels don't.
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
  - The virtual resource `promptback:/Prompt Explorer` has no extension, so VS Code doesn't offer "Configure default editor for '*.x'", which is gated on `extname(resource) !== ''` in `editorResolverService.ts`.
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

`core/src/mcp.ts` (`@promptback/core/mcp`) builds the server with the official TypeScript SDK and serves it over stdio. Two launchers share it:
- `promptback mcp`;
- `dist/mcp.js` in the VSIX. VS Code starts it with its own runtime (`process.execPath` plus `ELECTRON_RUN_AS_NODE`, as the `McpStdioServerDefinition` docs suggest), and the extension passes its engine options in `PROMPTBACK_OPTIONS`.

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
  - So whenever that file defines `promptback`, the extension registers nothing, whatever the discovery setting, and logs why (`mcpProvider.ts`). It checks again when the file or its settings change.
  - Cost of this rule:
    - With VS Code 1.141's defaults, VS Code's own chat panel then has no Promptback tools. Turning on `copilot` discovery restores them, and also brings in the file's other servers.
    - Claude and Codex sessions in the Agents window never receive Copilot-home servers (`CopilotHomeNotForwarded`), so they lose the tools as well.
  - VS Code caches extension server definitions per workspace (`mcp.extCachedServers` in `extensionMcpDiscovery.ts`) and forwards the cached copy until the extension's provider replaces it. After an upgrade that changes the provider's answer, windows need a reload.
- **Privacy.** Tool results are sent to the agent's model. Registration can be turned off with `promptback.mcp.enabled`, and the server's instructions ask agents to quote only what the task needs.
- **Reviewed, then corrected.** An independent review found two issues.
  - A `promptback mcp` refresh used default source settings, so it could delete sessions the extension keeps. The index now owns its source settings.
  - The step-aside check didn't follow VS Code's discovery rules. Making it follow them was still wrong: the Copilot runtime reads the file regardless, so Agents-window sessions kept getting the tools twice. A probe of VS Code 1.141's extension host showed the real defaults, and the rule is now the plain one above.

## Plugin registries

Three concepts were growing `switch` statements and hard-coded tables spread over core, the CLI, the MCP server and the webview: embedding backends, prompt sources and local models. Each is now a `Registry` of plugins (`registry.ts`) whose options are a zod schema, validated once with a readable error (`PluginOptionsError` names the plugin and every bad path).

- **Sources** (`sources/base.ts`) declare their clients (id, label, codicon, chart colour, `client:` aliases) and `src:` aliases. The query parser, the MCP instructions, the CLI, the sidebar and the Explorer (which receives a *catalog* with `init`, since it imports only types from core) all derive from that. `openTargets` lives on the plugin, so `links.ts` is a one-line delegation. Saved source settings moved to a per-source shape (`meta.sources` v2); the flat v1 shape is still read.
- **Providers** (`embed/registry.ts`): `create(options, env)` returns an `EmbeddingProvider` or `undefined` for keyword-only. The environment carries an injectable `fetch` so tests never touch the network.
- **Models** (`embed/models.ts`): the pinned specs are validated by the same schema users can write in `<modelDir>/model.json`; manifests without hashes are usable locally but never downloaded.

Plugin interfaces use **method** signatures for `sync`/`create` on purpose: methods are bivariant in their parameters, which is what lets `PromptSourcePlugin<SpecificOptions>` live in a `Registry<PromptSourcePlugin>`. Property-style signatures (what Biome's `useConsistentMethodSignatures` prefers) would reject every concrete plugin.

Sources that read whole files per session (Claude Code, Codex, VS Code Chat) share one loop, `syncSessionFiles`: skip unchanged files by size + mtime + projection version, replace the prompts of changed ones, drop sessions whose file disappeared unless `retainDeleted`. Copilot keeps its byte-cursor reader because its files reach hundreds of MB. The line scanner takes a `headBytes` hint so a plugin can pre-filter lines whose type appears early and parse the rest; Claude Code lines put `"type"` around byte 90–125 but some lines bury it at 70 kB, so unknown heads are parsed rather than skipped.

Verified on this machine's real data (Windows, Node 26): Claude Code + Codex, 261 prompts from 35 sessions, 385 ms cold, 6 ms when nothing changed.

## Toolchain

- **Biome 2** for lint + format + import order, one config (`biome.jsonc`). Every stable group is on with its full preset; the rules that are off each carry a reason in the config (browser-only rules in a Node code base, React-specific attribute rules in a Preact webview, opinion rules such as `noNonNullAssertion` under `noUncheckedIndexedAccess`, and `noUnnecessaryConditions`, which misjudged every nullable value it saw). `useExhaustiveDependencies` reports only missing dependencies: listing a value to re-run an effect is a deliberate Preact idiom here. The Explorer's table keeps ARIA grid roles (`useSemanticElements` is suppressed for that one file) because a virtualized, absolutely positioned, column-resizable grid cannot be a `<table>`; rows and headers are keyboard-operable with a roving tabindex instead.
- **Biome's unsafe fixes were reviewed line by line**: they rewrote `!!x` to `Boolean(x)` (which loses TypeScript narrowing), deleted `console` calls (`noConsole`'s fix), rewrote `import './styles.css'` to `styles.js` (`useImportExtensions` with `forceJsExtensions`; replaced by explicit `ts → js` mappings) and rewrote hook dependency arrays. Two Biome 2.5.15 false positives are worked around: `noInvalidGridAreas` on single-line multi-row `grid-template-areas` values (now one row per line) and `noSvgWithoutTitle` requiring a `<title>` on the icon.
- **npm 11.19** blocks dependency install scripts by default. None of ours are needed, so `allowScripts` denies them explicitly. With older npm, onnxruntime-node's postinstall downloads CUDA binaries on linux-x64 unless `ONNXRUNTIME_NODE_INSTALL=skip`.
- **Pins**: Node floor 22.13.0 (`.node-version`, `@types/node@22` so the type-checked API surface is the floor's), TypeScript 5.9, Vitest 4, esbuild 0.28, onnxruntime-node exactly 1.30.0 (its binaries are the shipped artifact: win32-x64/arm64, linux-x64/arm64, darwin-arm64; no darwin-x64).
- **Tests are offline by construction**: `test/setup.ts` stubs `fetch` and points every source's default home at an empty folder; the end-to-end test builds and spawns the real CLI and talks to `promptback mcp` over stdio.
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
- **More sources.** Cursor, Cline/Roo Code, Gemini CLI, Continue, Aider, OpenCode, Windsurf and chat-export imports; candidate locations are listed in the README and need verifying. Each is one plugin file plus a fixture test.
- **Projection versions for stored flags.** `isAck` is computed when a prompt is inserted; a change to the rule needs a re-classification pass like the one chunking options now trigger.
- **Intel Macs.** onnxruntime-node 1.30 ships no darwin-x64 binary; the `hashed` provider covers it until a WASM backend is worth its 7× slowdown.
