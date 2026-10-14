# Examples

Runnable from a fresh clone after `npm ci`. None of them reads your real history unless it says so.

| Example | Needs | What it shows |
|---|---|---|
| `node examples/run.mjs examples/custom-source.ts` | Node only (no model, no download, no native code: it uses the `hashed` embedder) | A complete custom prompt source registered at runtime: validated options, the shared sync loop, a client with aliases, an open target. Indexes two throwaway Markdown notes and searches them with `src:`/`client:` operators. |
| `npm run build -w packages/cli && node examples/mcp-client.mjs "retry policy" --no-model` | The built CLI | An MCP client talking to `promptback mcp` over stdio: lists tools, searches **your real index** (keyword-only with `--no-model`), fetches a prompt. |
| `node packages/cli/dist/cli.js search "..." --no-model --json` | The built CLI | The CLI's JSON output, for scripting. |

`run.mjs` bundles a TypeScript file with esbuild before running it, because core uses TypeScript features Node's type stripping cannot handle.
