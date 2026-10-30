// biome-ignore-all lint/suspicious/noConsole: build scripts report progress on stdout.
// Produces a platform-specific VSIX:
//   1. production bundles (dist/extension.js, dist/host.js, dist/mcp.js, dist/webview.js)
//   2. onnxruntime-node (+ onnxruntime-common) copied next to the bundle, pruned to one platform
//   3. optionally the default embedding model (pinned revision, sha256-verified) for offline installs
//   4. vsce package --target <platform>
// Usage: node scripts/package.mjs [--target <platform>-<arch>] [--bundle-model] [--pre-release]
// Targets are the platforms onnxruntime-node ships binaries for: win32-x64, win32-arm64, linux-x64, linux-arm64,
// darwin-arm64. By default the model is downloaded on first use (33 MB, hash-verified) instead of shipping in
// every update; pass --bundle-model for an offline-capable VSIX. --pre-release marks the VSIX for the Marketplace's
// pre-release channel (release.yml passes it for odd minor versions); `vsce publish --pre-release` refuses a VSIX
// packaged without it.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, 'package.json'));
const args = process.argv.slice(2);
const argValue = name => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
export const TARGETS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-arm64'];
const target = argValue('--target') ?? `${process.platform}-${process.arch}`;
if (!TARGETS.includes(target)) {
	throw new Error(`Unsupported target '${target}'. onnxruntime-node ships binaries for: ${TARGETS.join(', ')}`);
}
const [platform, arch] = target.split('-');
const bundleModel = args.includes('--bundle-model');
const preRelease = args.includes('--pre-release');

// Scripts run with this Node binary and resolved entry points: no shell, no PATH lookup.
const run = (script, scriptArgs) =>
	execFileSync(process.execPath, [script, ...scriptArgs], { cwd: root, stdio: 'inherit' });
console.log(`\n== Building (${target})`);
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
run(path.join(root, 'scripts', 'build.mjs'), ['--production']);

console.log('\n== Staging onnxruntime-node');
const nm = path.join(root, 'dist', 'node_modules');
const ortDir = path.dirname(require.resolve('onnxruntime-node/package.json'));
const findPkgRoot = file => {
	let d = path.dirname(file);
	while (
		!fs.existsSync(path.join(d, 'package.json')) ||
		!JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name
	) {
		d = path.dirname(d);
	}
	return d;
};
const commonDir = findPkgRoot(createRequire(path.join(ortDir, 'package.json')).resolve('onnxruntime-common'));
const copy = (src, dst, filter = () => true) =>
	fs.cpSync(src, dst, { recursive: true, filter: s => filter(path.relative(src, s)) });
copy(ortDir, path.join(nm, 'onnxruntime-node'), rel => {
	const p = rel.split(path.sep).join('/');
	if (p === '' || p === 'package.json' || p === 'LICENSE' || p === 'README.md') {
		return true;
	}
	if (p === 'dist' || (p.startsWith('dist/') && p.endsWith('.js'))) {
		return true;
	}
	if (p === 'bin' || p === 'bin/napi-v6' || p === `bin/napi-v6/${platform}`) {
		return true;
	}
	if (p.startsWith(`bin/napi-v6/${platform}/${arch}`)) {
		// DirectML / DXC are only needed for the GPU execution provider; we run on CPU.
		return !/(DirectML|dxcompiler|dxil)\.dll$/iu.test(p);
	}
	return false;
});
copy(commonDir, path.join(nm, 'onnxruntime-common'), rel => {
	const p = rel.split(path.sep).join('/');
	return (
		p === '' ||
		p === 'package.json' ||
		p === 'LICENSE' ||
		p === 'dist' ||
		p.startsWith('dist/cjs') ||
		(p.startsWith('dist/esm') && !p.endsWith('.map'))
	);
});
// The binding plus the shared library it links against; a VSIX missing either fails on every machine of its target.
const staged = path.join(nm, 'onnxruntime-node', 'bin', 'napi-v6', platform, arch);
const shared = { win32: 'onnxruntime.dll', linux: 'libonnxruntime.so.1', darwin: 'libonnxruntime.1.dylib' }[platform];
for (const file of ['onnxruntime_binding.node', shared]) {
	if (!fs.existsSync(path.join(staged, file))) {
		throw new Error(`onnxruntime-node has no ${file} for ${target} (looked in ${staged})`);
	}
}

try {
	await bundleAndPackage();
} finally {
	// The single-platform staging copy must not outlive this run, successful or not: a development build would
	// resolve it instead of the repo's onnxruntime-node and fail to load the binding on any other platform.
	fs.rmSync(nm, { recursive: true, force: true });
}

async function bundleAndPackage() {
	if (bundleModel) {
		console.log('\n== Bundling default embedding model');
		const helper = path.join(root, 'dist', '.fetch-model.mjs');
		await esbuild.build({
			stdin: {
				contents: `import { getModelSpec, DEFAULT_LOCAL_MODEL } from '../core/src/embed/models.ts';
				import { resolveModelDir } from '../core/src/embed/modelStore.ts';
				export async function fetch(dir) { const spec = getModelSpec(DEFAULT_LOCAL_MODEL); const d = await resolveModelDir(spec, { searchDirs: [dir], cacheDir: dir, allowDownload: true, onProgress: console.log }); return { id: spec.id, dir: d }; }`,
				resolveDir: root,
				loader: 'ts',
			},
			bundle: true,
			platform: 'node',
			format: 'esm',
			outfile: helper,
			logLevel: 'warning',
		});
		const { fetch: fetchModel } = await import(pathToFileURL(helper).href);
		const r = await fetchModel(path.join(root, 'models'));
		fs.rmSync(helper);
		fs.rmSync(path.join(r.dir, '.verified'), { force: true });
		console.log(`Model ${r.id} ready at ${path.relative(root, r.dir)}`);
	} else {
		fs.rmSync(path.join(root, 'models'), { recursive: true, force: true });
	}

	console.log('\n== Packaging VSIX');
	const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
	const out = path.join(root, `${pkg.name}-${pkg.version}-${target}.vsix`);
	run(require.resolve('@vscode/vsce/vsce'), [
		'package',
		'--no-dependencies',
		'--target',
		target,
		'--out',
		out,
		...(preRelease ? ['--pre-release'] : []),
	]);
	console.log(`\nCreated ${out} (${(fs.statSync(out).size / 1_048_576).toFixed(1)} MB)`);
}
