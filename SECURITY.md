# Security

## What Promptback touches

- **Reads** the local session stores of Copilot, Claude Code, Codex and VS Code Chat. It never writes to them.
- **Writes** one folder: the index (`~/.promptback`, or `PROMPTBACK_HOME`).
- **Network:** only the one-time embedding-model download from a pinned, SHA-256-verified Hugging Face revision, and, if you opt in, the OpenAI-compatible endpoint you configure. There is no telemetry.
- **Secrets:** an API key for a remote embedding endpoint is read from the environment variable you name and is never stored or logged.
- **Agents:** the MCP tools are read-only. Whatever they return becomes part of the calling agent's context and is sent to its model.

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately through [GitHub's private vulnerability reporting](https://github.com/spencrr/promptback/security/advisories/new) for this repository. Include the version (`promptback --version` or the extension version), your platform, and steps to reproduce.

You will get an acknowledgement within a few days. Fixes ship as a patch release of every package (they share one version), with the advisory published once the fix is available.

## Supported versions

Only the latest release is supported.
