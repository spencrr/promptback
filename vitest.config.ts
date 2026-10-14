import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

// Default source locations resolve to this empty folder during tests (see test/setup.ts).
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-empty-home-'));

export default defineConfig({
	test: {
		include: ['packages/*/test/**/*.test.ts'],
		setupFiles: ['./test/setup.ts'],
		env: { PROMPTBACK_TEST_EMPTY_HOME: emptyHome },
		testTimeout: 30_000,
		// The CLI end-to-end test builds and spawns the real binary.
		hookTimeout: 60_000,
	},
});
