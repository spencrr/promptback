# Changelog

All notable changes to Promptback are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Every package (`promptback` on npm, the `promptback-vscode` extension, the MCP server) shares one version.

## Unreleased

### Added
- Claude Code (`~/.claude/projects`) and OpenAI Codex (`~/.codex/sessions`) as prompt sources, with `src:`/`client:` filters, source-specific resume commands and a sources roadmap.
- Plugin registries with validated options for prompt sources, embedding providers and local models; `model.json` manifests for custom ONNX models.
- `hashed` embedding provider: word-overlap vectors with no model or native code, for platforms without onnxruntime binaries.
- `promptback sources` and `promptback --version`; `server.json` for the MCP registry (`dev.spencrr/promptback`).
- Git hooks (lefthook): Biome on staged files at commit, typecheck on push.
- `promptback doctor`: checks platform support, the native ONNX runtime, the model and one embedding; exit code 1 when semantic search is unavailable.
- Results and status carry a `semantic` state (`ready`, `pending`, `off`, `failed` with the reason), and every surface shows the reason semantic search did not run: CLI stderr, the first line of MCP results, an Explorer banner, the Index panel, and a one-time VS Code warning with **Use hashed embeddings**.
- CI runs the tests on Windows and Linux arm64 as well, including a real ONNX inference.

### Changed
- Renamed from Yesterprompt to **Promptback**: `PROMPTBACK_HOME`, `~/.promptback`, `promptback.*` settings, extension id `spencrr.promptback-vscode`, CLI `promptback`.
- The embedding model is downloaded on first use (pinned revision, SHA-256-verified) instead of shipping in every VSIX; `package.mjs --bundle-model` still builds an offline VSIX.
- Saved source settings use a per-source shape; the previous flat shape is still read.
- Changing the chunking options re-chunks every stored prompt instead of leaving stale chunk boundaries.
- Terminal resume commands are offered only for shell-safe session ids; CSP nonces come from `node:crypto`.
- The Explorer webview runs on Preact 11 (ESM-only, `useRef` initial values, `Object.is` hook dependencies); no visible change. Build and test tooling on TypeScript 7, Vitest 5 and vsce 4.

### Fixed
- Repository inference from tool calls recognises POSIX paths (previously Windows paths only).
- A VSIX installed on VS Code of the other architecture (VS Code allows it) failed with a raw `Cannot find module '../bin/napi-v6/.../onnxruntime_binding.node'` after downloading the model, while the UI said "warming up". The runtime is now checked before any download, and the message names the architectures the build contains and the one to install; a missing Visual C++ runtime on Windows is diagnosed with the matching installer link.
- Embeddings turned off (`none`) no longer show a permanent "warming up" banner in the Explorer.
- A failed model load is no longer retried on every search; syncs still retry.

[unreleased]: https://github.com/spencrr/promptback/compare/6564669...HEAD
