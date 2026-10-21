#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noConsole: a release script reports what it does.
/**
 * Bumps every version field in lockstep, moves the CHANGELOG's "Unreleased" section under the new version, commits
 * and tags. Pushing the tag starts .github/workflows/release.yml.
 *
 *   node scripts/release.mjs 0.8.0            # exact version
 *   node scripts/release.mjs patch|minor|major
 *   node scripts/release.mjs 0.8.0 --dry-run  # show the changes, write nothing
 *   node scripts/release.mjs 0.8.0 --push     # also push the commit and the tag
 *
 * Pre-releases follow the Marketplace convention: an odd minor (0.7.x, 0.9.x) is a pre-release, an even minor a
 * release. release.yml reads the parity of the tag and publishes to the matching channel, so there is no flag.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const push = args.includes('--push');
const spec = args.find(a => !a.startsWith('--'));
if (!spec) {
	console.error('Usage: node scripts/release.mjs <version | patch | minor | major> [--dry-run] [--push]');
	process.exit(2);
}

const MANIFESTS = [
	'package.json',
	'packages/core/package.json',
	'packages/cli/package.json',
	'packages/vscode/package.json',
];
const SERVER_JSON = 'packages/cli/server.json';
const CHANGELOG = 'CHANGELOG.md';

const read = rel => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const current = read('package.json').version;
const next = bump(current, spec);
if (!/^\d+\.\d+\.\d+$/.test(next)) {
	console.error(`Not a release version: ${next}`);
	process.exit(2);
}
const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain') !== '') {
	console.error('The working tree must be clean.');
	process.exit(1);
}
if (git('tag', '--list', `v${next}`) !== '') {
	console.error(`Tag v${next} already exists.`);
	process.exit(1);
}

const preRelease = isPreRelease(next);
console.log(`${current} → ${next} (${preRelease ? 'pre-release: odd minor' : 'release'}${dryRun ? ', dry run' : ''})`);
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') {
	console.error('Release from main (release.yml publishes only tags that point at main).');
	process.exit(1);
}

// Version fields: textual replaces keep each file's formatting untouched. server.json carries the version twice
// (the server and its npm package), both equal to the current version.
const edits = new Map();
for (const rel of [...MANIFESTS, SERVER_JSON]) {
	const text = fs.readFileSync(path.join(root, rel), 'utf8');
	const needle = `"version": "${current}"`;
	if (!text.includes(needle)) {
		throw new Error(`${rel} does not carry version ${current}`);
	}
	edits.set(rel, text.replaceAll(needle, `"version": "${next}"`));
}

// CHANGELOG: "## Unreleased" becomes "## <next> - <date>", with a fresh empty Unreleased section above it.
const changelog = fs.readFileSync(path.join(root, CHANGELOG), 'utf8');
const marker = '## Unreleased';
if (!changelog.includes(marker)) {
	throw new Error(`${CHANGELOG} has no "${marker}" section`);
}
const date = new Date().toISOString().slice(0, 10);
const repoUrl = 'https://github.com/spencrr/promptback';
let updatedChangelog = changelog.replace(marker, `${marker}\n\n## [${next}] - ${date}`);
updatedChangelog = updatedChangelog.replace(/\n\[unreleased\]: .*$/im, '');
updatedChangelog = `${updatedChangelog.trimEnd()}\n\n[unreleased]: ${repoUrl}/compare/v${next}...HEAD\n[${next}]: ${repoUrl}/compare/v${current}...v${next}\n`;
edits.set(CHANGELOG, updatedChangelog);

for (const [rel, text] of edits) {
	console.log(`  ${rel}`);
	if (!dryRun) {
		fs.writeFileSync(path.join(root, rel), text);
	}
}
if (dryRun) {
	process.exit(0);
}

// The lockfile records workspace versions too. npm is run through this Node binary (no shell, no PATH lookup).
const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
execFileSync(
	process.execPath,
	[npmCli, 'install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
	{ cwd: root, stdio: 'inherit' },
);
execFileSync(
	process.execPath,
	[path.join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', 'packages/core/test/versions.test.ts'],
	{ cwd: root, stdio: 'inherit' },
);
git('add', '--', ...edits.keys(), 'package-lock.json');
git('commit', '-m', `Release ${next}`);
git('tag', '-a', `v${next}`, '-m', `Promptback ${next}`);
if (push) {
	execFileSync('git', ['push', 'origin', 'main', `v${next}`], { cwd: root, stdio: 'inherit' });
	console.log(
		`\nPushed v${next}; release.yml is running: https://github.com/spencrr/promptback/actions/workflows/release.yml`,
	);
} else {
	console.log(`\nCommitted and tagged v${next}. Push with:\n  git push origin main v${next}`);
}

/** Marketplace convention: odd minor = pre-release channel, even minor = release channel. */
function isPreRelease(version) {
	return Number(version.split('.')[1]) % 2 === 1;
}

function bump(version, how) {
	const [major, minor, patch] = version.split('.').map(Number);
	switch (how) {
		case 'major':
			return `${major + 1}.0.0`;
		case 'minor':
			return `${major}.${minor + 1}.0`;
		case 'patch':
			return `${major}.${minor}.${patch + 1}`;
		default:
			return how.replace(/^v/, '');
	}
}
