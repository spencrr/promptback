# @promptback/core

The engine behind [Promptback](../../README.md): ingestion, the SQLite index, embeddings, hybrid ranking and the MCP server. It has no VS Code dependency and ships as TypeScript source; the CLI and the extension bundle it with esbuild, so it is not published on its own.

```ts
import { PromptSearchEngine } from '@promptback/core';

const engine = PromptSearchEngine.open({ indexDir: '/tmp/index', embedding: { kind: 'hashed' } });
await engine.sync();
const { hits } = await engine.search('tree view design doc repo:PyRIT');
await engine.close();
```

## Layout

| Module | |
|---|---|
| `engine.ts` | `PromptSearchEngine`: the facade every surface calls (`sync`, `search`, `explore`, `status`, …) |
| `sources/` | The prompt-source registry and its plugins: `copilot`, `vscode-chat`, `agent-host`, `claude-code`, `codex` |
| `embed/` | The embedding-provider registry (`local`, `openai-compatible`, `hashed`, `none`), local model specs and the model store |
| `store.ts` | The index: `node:sqlite`, FTS5, chunks, vectors, writer lease, additive migrations |
| `search/` | Query language, ranking, topics, fork lineage |
| `mcp.ts` | The MCP server (read-only tools; stdout is the protocol) |
| `host.ts`, `protocol.ts` | The child process the VS Code extension talks to |
| `registry.ts` | The generic registry and option validation shared by the above |

## Extension points

Plugins are plain objects with an `id`, an `options` zod schema and a factory or `sync` method; see the root README's [Extending](../../README.md#extending) section and [`examples/custom-source.ts`](../../examples/custom-source.ts).

- `promptSources.register(plugin)` adds a prompt source.
- `embeddingProviders.register(plugin)` adds an embedding backend.
- `localModels.register(spec)` or a `model.json` next to the model files adds a local model.

## Tests and benchmark

`npm test` from the repository root runs this package's tests on synthetic fixtures; they never touch real history and never reach the network. `npm run bench -w packages/core -- --model-dir <dir>` measures retrieval quality and latency against your own index using labelled queries in the gitignored `bench/data/*.local.json`.
