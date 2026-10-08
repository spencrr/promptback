import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { type LocalModelSpec, modelFileUrl } from './models.js';

export interface ResolveModelOptions {
	/** Explicit directory with the model files (offline / air-gapped). */
	readonly modelDir?: string;
	/** Additional read-only directories to look in (e.g. bundled with the VS Code extension). Each holds `<modelId>/...`. */
	readonly searchDirs?: readonly string[];
	/** Writable cache root; models are stored as `<cacheDir>/<modelId>/...`. */
	readonly cacheDir: string;
	readonly allowDownload: boolean;
	/** Hugging Face compatible mirror base URL. */
	readonly mirror?: string;
	readonly onProgress?: (message: string) => void;
}

function fileOk(dir: string, f: LocalModelSpec['files'][number], verifyHash: boolean): boolean {
	const p = path.join(dir, ...f.path.split('/'));
	try {
		if (fs.statSync(p).size !== f.size) {
			return false;
		}
		return !verifyHash || sha256File(p) === f.sha256;
	} catch {
		return false;
	}
}

function sha256File(p: string): string {
	return createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function dirHasModel(dir: string, spec: LocalModelSpec, verifyHash: boolean): boolean {
	return spec.files.every(f => fileOk(dir, f, verifyHash));
}

/**
 * Finds a verified copy of the model, downloading the pinned revision into the cache if allowed.
 * A `.verified` marker avoids re-hashing ~35 MB on every start.
 */
export async function resolveModelDir(spec: LocalModelSpec, opts: ResolveModelOptions): Promise<string> {
	if (opts.modelDir) {
		if (!dirHasModel(opts.modelDir, spec, false)) {
			throw new Error(`Model directory ${opts.modelDir} does not contain the expected files for ${spec.id}`);
		}
		return opts.modelDir;
	}
	for (const root of opts.searchDirs ?? []) {
		const dir = path.join(root, spec.id);
		if (dirHasModel(dir, spec, false)) {
			return dir;
		}
	}
	const dir = path.join(opts.cacheDir, spec.id);
	const marker = path.join(dir, '.verified');
	if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === spec.revision && dirHasModel(dir, spec, false)) {
		return dir;
	}
	if (dirHasModel(dir, spec, true)) {
		fs.writeFileSync(marker, spec.revision);
		return dir;
	}
	if (!opts.allowDownload) {
		throw new Error(`Embedding model ${spec.id} is not installed and downloads are disabled.`);
	}
	await downloadModel(spec, dir, opts);
	fs.writeFileSync(marker, spec.revision);
	return dir;
}

export async function downloadModel(spec: LocalModelSpec, dir: string, opts: Pick<ResolveModelOptions, 'mirror' | 'onProgress'>): Promise<void> {
	const staging = `${dir}.partial-${process.pid}`;
	fs.rmSync(staging, { recursive: true, force: true });
	try {
		for (const f of spec.files) {
			const url = modelFileUrl(spec, f, opts.mirror);
			opts.onProgress?.(`Downloading ${spec.repo}/${f.path} (${(f.size / 1048576).toFixed(1)} MB)`);
			const res = await fetch(url, { redirect: 'follow' });
			if (!res.ok) {
				throw new Error(`GET ${url} failed: ${res.status} ${res.statusText}`);
			}
			const buf = Buffer.from(await res.arrayBuffer());
			const hash = createHash('sha256').update(buf).digest('hex');
			if (buf.length !== f.size || hash !== f.sha256) {
				throw new Error(`Integrity check failed for ${f.path}: got ${buf.length} bytes sha256 ${hash}`);
			}
			const target = path.join(staging, ...f.path.split('/'));
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, buf);
		}
		fs.rmSync(dir, { recursive: true, force: true });
		fs.mkdirSync(path.dirname(dir), { recursive: true });
		fs.renameSync(staging, dir);
	} catch (e) {
		fs.rmSync(staging, { recursive: true, force: true });
		throw e;
	}
}
