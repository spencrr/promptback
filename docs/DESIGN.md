# Design: semantic search over agent prompt history

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
VS Code window(s) / Agents window             CLI (awss)            MCP server (planned)
  extension (extension host, ~15 KB)              │                        │
    Quick Pick, commands, preview, open-session   │                        │
    └─ fork(ELECTRON_RUN_AS_NODE) ─► host.js       │                        │
                                     │            │                        │
                                     ▼            ▼                        ▼
                         ┌──────────── @awss/core: PromptSearchEngine ────────────┐
                         │ sources/ (streaming, incremental, read-only)           │
                         │ store.ts  node:sqlite: prompts, FTS5, chunks, vectors   │
                         │ embed/    pluggable: local ONNX | OpenAI-compatible     │
                         │ search/   query language, hybrid ranking                │
                         └────────────────────────────────────────────────────────┘
                                     │
               %LOCALAPPDATA%/agent-window-semantic-search/index.db (shared, WAL, single-writer lease)
```

- **Core has no `vscode` dependency.** The extension, the CLI and a future MCP server are thin adapters over `PromptSearchEngine` (`sync`, `search`, `getPrompt`, `getSessionPrompts`, `status`).
- **Inference runs in a child process.** The child is forked with VS Code's own runtime, so there's nothing to install. It unloads the model after 15 min idle, and it is restarted if it crashes.
- **One index for all windows.** The index lives in a fixed per-user folder, so the main window, the Agents window (separate profile), the CLI and MCP share it. A lease row in SQLite elects a single writer. Other processes just read.
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

## Ranking (exact parameters, `search/searcher.ts`)

1. **Parse** the query language. Allow-listed `key:value` operators only, so Windows paths and URLs stay free text.
2. **Pre-filter** in memory: origin (default human only), trivial acks hidden, repo / branch / cwd / client / source / session / model / date.
3. **Lexical:** FTS5 `porter unicode61` over the full text. Two lists, `AND` and `OR`, top 300 each.
4. **Dense:** brute-force cosine. Score per prompt = `0.5·max(chunk) + 0.5·head chunk`. Chunks are 1,434 chars (≈512 tokens) with 15% overlap and at most 12 per prompt; text beyond that is covered by lexical search.
5. **Weighted RRF, k = 60.** The lexical weight is 0.8 for identifier-like queries (digits, `_./\#-`, camelCase, quotes) or queries of ≤ 3 content tokens, and 0.2 otherwise. The OR list gets 0.4× that weight; dense gets 1.0.
6. **Recency:** `× (1 + 0.15 · 2^(−age/30d))`.
7. **Collapse** identical texts into one hit with `duplicates[]`, cap 3 hits per session, verify `"phrases"` and `-exclusions` on the original text.

## Ingestion details

- **Streaming.** `events.jsonl` is read with a byte scanner that only materializes lines whose first 96 bytes name a wanted event type. Tool-output lines (up to hundreds of MB) are never decoded.
- **Incremental.** Each session keeps a cursor `{size, mtime, cursor, headHash(headLen)}`. Appends read only new bytes, and a rewrite or truncation triggers a re-read of that session. A trailing partial line is retried on the next sync.
- **Chat logs.** Logs are replayed whole when size or mtime changes, and the session's prompts are diffed by `requestId`.
- **Deletion.** Sessions deleted from disk are removed from the index, unless `retainDeleted` is set.
- **Agents-window databases** (~1.4k files) are cached by mtime of the db and its `-wal`.
- **Measured.** The first lexical index of 3,150 prompts takes about 24 s cold. A no-op re-sync takes about 0.5 s warm. Embedding 2,663 distinct human chunks took about 4 min on a loaded machine and runs in the background; keyword search works immediately.

## VS Code integration

- **UI.** A Quick Pick with live debounced search. `sortByLabel = false` is set at runtime (the setter isn't gated by the proposal) plus `alwaysShow`, to keep our ranking. Each item has Copy, Insert into chat (`workbench.action.chat.open {query, isPartialQuery}`), Preview (virtual `awss-prompt:` document) and Open session buttons.
- **Open session** (`links.ts`, pure data):
  - Agents-window deep link via the agent-host mapping.
  - Best-effort link for recent CLI and autopilot sessions.
  - `copilot --resume <id>` typed, not executed, in a terminal.
  - `vscode-chat-session://local/<b64url(id)>` for chat-panel sessions, from a window on the matching workspace.
- **Agents window.** **Prompt History: Enable in Agents Window** adds the extension to `extensions.supportAgentsWindow`.
- **Packaging.** One VSIX per platform (onnxruntime-node is native), about 33 MB for win32-x64, including the model. DirectML and DXC DLLs are pruned because we run on CPU.

## Roadmap

- **MCP server** (`packages/mcp`). A stdio server over `PromptSearchEngine` with tools `search_prompts(query, limit, filters)`, `get_prompt(id)` and `get_session_prompts(sessionKey)`. It shares the index with the extension. The core API is already transport-neutral and JSON-serializable.
- **Language-model tool** `#pastPrompts` (`vscode.lm.registerTool`), so agents in VS Code can recall earlier prompts.
- **Optional cross-encoder rerank** ("Refine"). mxbai-rerank-xsmall helped hard queries but costs ~6 s per query.
- **Near-duplicate clustering** with MinHash. Only 21 clusters in the current corpus, so it was deferred.
- **More platforms.** macOS and Linux VSIX targets via `scripts/package.mjs --target`. A WASM fallback provider would cover platforms without onnxruntime binaries.
