// Every test runs offline. The only network the product ever uses goes through `fetch` (model downloads and the
// OpenAI-compatible embedder), and both accept an injected transport, so a test that reaches the real `fetch` has a
// bug. Tests also never read this machine's history: they pass explicit homes/roots or set the env below.
import { vi } from 'vitest';

vi.stubGlobal('fetch', (input: unknown) => {
	const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
	return Promise.reject(new Error(`Network access is disabled in tests (fetch ${url}); inject a fetch instead.`));
});

// Point every source's default location at an empty folder so a test that forgets to pass one reads nothing.
const empty = process.env['PROMPTBACK_TEST_EMPTY_HOME'];
if (empty) {
	vi.stubEnv('COPILOT_HOME', empty);
	vi.stubEnv('CLAUDE_CONFIG_DIR', empty);
	vi.stubEnv('CODEX_HOME', empty);
}