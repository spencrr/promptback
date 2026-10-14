import * as fs from 'node:fs';
import * as path from 'node:path';

const rootCache = new Map<string, string | null>();
const nameCache = new Map<string, string>();

/** Nearest ancestor (inclusive) containing `.git` (directory, or a worktree's `.git` file). */
export function findGitRoot(dir: string): string | undefined {
	const visited: string[] = [];
	let d = path.resolve(dir);
	for (;;) {
		const cached = rootCache.get(d);
		if (cached !== undefined) {
			for (const v of visited) {
				rootCache.set(v, cached);
			}
			return cached ?? undefined;
		}
		visited.push(d);
		if (fs.existsSync(path.join(d, '.git'))) {
			for (const v of visited) {
				rootCache.set(v, d);
			}
			return d;
		}
		const parent = path.dirname(d);
		if (parent === d) {
			for (const v of visited) {
				rootCache.set(v, null);
			}
			return undefined;
		}
		d = parent;
	}
}

/** `owner/name` from the `origin` remote of a git root, else the folder name. */
export function repoName(root: string): string {
	let name = nameCache.get(root);
	if (name === undefined) {
		name = parseRemote(readOriginUrl(root)) ?? path.basename(root);
		nameCache.set(root, name);
	}
	return name;
}

function readOriginUrl(root: string): string | undefined {
	try {
		let gitDir = path.join(root, '.git');
		if (fs.statSync(gitDir).isFile()) {
			// Worktree: ".git" contains "gitdir: <path>"; the shared config lives in the common dir.
			const target = /gitdir:\s*(.+)/.exec(fs.readFileSync(gitDir, 'utf8'))?.[1]?.trim();
			if (!target) {
				return undefined;
			}
			gitDir = path.resolve(root, target);
			const common = path.join(gitDir, 'commondir');
			if (fs.existsSync(common)) {
				gitDir = path.resolve(gitDir, fs.readFileSync(common, 'utf8').trim());
			}
		}
		const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
		const section = /\[remote "origin"\]([^[]*)/.exec(config)?.[1];
		return section ? /^\s*url\s*=\s*(.+)$/m.exec(section)?.[1]?.trim() : undefined;
	} catch {
		return undefined;
	}
}

/** `https://github.com/o/r(.git)`, `git@github.com:o/r.git`, `https://dev.azure.com/org/proj/_git/r` → `o/r` / `proj/r`. */
export function parseRemote(url: string | undefined): string | undefined {
	if (!url) {
		return undefined;
	}
	const ado = /\/([^/]+)\/_git\/([^/?#]+)/.exec(url);
	if (ado) {
		return `${decodeURIComponent(ado[1]!)}/${decodeURIComponent(ado[2]!)}`;
	}
	const m = /[/:]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
	return m ? `${m[1]}/${m[2]}` : undefined;
}

const PATH_RE = /(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%|[a-zA-Z]:)[\\/][^\s"'`;|<>*?]+/gi;

/** Git roots referenced by absolute (or home-relative) paths in a tool-call argument string. */
export function gitRootsInText(text: string, home: string, ignore: (p: string) => boolean): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(PATH_RE)) {
		let p = m[0].replace(/[.,)\]}:]+$/, '');
		p = p.replace(/^(?:~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)/i, home);
		p = path.normalize(p);
		if (ignore(p)) {
			continue;
		}
		let dir = p;
		try {
			if (!fs.statSync(p).isDirectory()) {
				dir = path.dirname(p);
			}
		} catch {
			dir = path.dirname(p);
			if (!fs.existsSync(dir)) {
				continue;
			}
		}
		const root = findGitRoot(dir);
		if (root) {
			out.push(root);
		}
	}
	return out;
}
