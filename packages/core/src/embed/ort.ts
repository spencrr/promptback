import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as Ort from 'onnxruntime-node';

/** Platforms onnxruntime-node ships CPU binaries for (`bin/napi-v6/<platform>/<arch>` inside the package). */
export const ONNX_RUNTIME_TARGETS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64', 'darwin-arm64'] as const;

/** `<platform>-<arch>` of a process, in the form the VSIX file names and {@link ONNX_RUNTIME_TARGETS} use. */
export function onnxRuntimeTarget(platform: string = process.platform, arch: string = process.arch): string {
	return `${platform}-${arch}`;
}

export function isOnnxRuntimeSupported(platform: string = process.platform, arch: string = process.arch): boolean {
	return (ONNX_RUNTIME_TARGETS as readonly string[]).includes(onnxRuntimeTarget(platform, arch));
}

/** The native runtime could not be loaded; `message` says why and what to do, `detail` has the paths for the log. */
export class NativeRuntimeError extends Error {
	readonly detail: string;

	constructor(message: string, options: { readonly detail: string; readonly cause: unknown }) {
		super(message, { cause: options.cause });
		this.name = 'NativeRuntimeError';
		this.detail = options.detail;
	}
}

/** What {@link describeOnnxRuntimeError} needs to know about the process; tests substitute their own. */
export interface RuntimeEnvironment {
	readonly platform: string;
	readonly arch: string;
	readonly nodeVersion: string;
	/** Lists `bin/napi-v6/<platform>/<arch>` targets present under an onnxruntime-node package root. */
	readonly installedTargets: (packageRoot: string) => readonly string[];
}

export const processEnvironment: RuntimeEnvironment = {
	platform: process.platform,
	arch: process.arch,
	nodeVersion: process.version,
	installedTargets: packageRoot => {
		const bin = path.join(packageRoot, 'bin', 'napi-v6');
		const targets: string[] = [];
		for (const platform of fs.readdirSync(bin, { withFileTypes: true }).filter(d => d.isDirectory())) {
			for (const arch of fs.readdirSync(path.join(bin, platform.name), { withFileTypes: true })) {
				if (
					arch.isDirectory() &&
					fs.existsSync(path.join(bin, platform.name, arch.name, 'onnxruntime_binding.node'))
				) {
					targets.push(`${platform.name}-${arch.name}`);
				}
			}
		}
		return targets.sort((a, b) => a.localeCompare(b));
	},
};

const BINDING = 'onnxruntime_binding.node';
const VC_REDIST = 'https://aka.ms/vs/17/release/vc_redist';

/**
 * Loads onnxruntime-node lazily, so keyword-only use never touches native code. Failures become a
 * {@link NativeRuntimeError} whose message says what is wrong with this installation and what to do about it.
 */
export async function loadOnnxRuntime(env: RuntimeEnvironment = processEnvironment): Promise<typeof Ort> {
	try {
		const mod = (await import('onnxruntime-node')) as typeof Ort & { default?: typeof Ort };
		return mod.default ?? mod;
	} catch (e) {
		const { message, detail } = describeOnnxRuntimeError(e, env);
		throw new NativeRuntimeError(message, { detail, cause: e });
	}
}

/**
 * Turns the loader's raw error into a diagnosis. The cases, most common first: the package in this installation
 * was pruned to another platform (a VSIX built for a different target), the shared library cannot be loaded (on
 * Windows almost always the missing Visual C++ runtime), the platform has no onnxruntime-node build at all, the
 * package is missing or broken.
 */
export function describeOnnxRuntimeError(
	e: unknown,
	env: RuntimeEnvironment,
): { readonly message: string; readonly detail: string } {
	const target = onnxRuntimeTarget(env.platform, env.arch);
	const err = (typeof e === 'object' && e !== null ? e : {}) as {
		code?: unknown;
		message?: unknown;
		requireStack?: unknown;
	};
	const raw = typeof err.message === 'string' ? err.message : String(e);
	const firstLine = raw.split(/\r?\n/, 1)[0] ?? raw;
	const detail = `${target}, Node ${env.nodeVersion}: ${raw.replace(/\s+/g, ' ').trim()}`;
	const process_ = `this process is ${target} (Node ${env.nodeVersion})`;

	if (!isOnnxRuntimeSupported(env.platform, env.arch)) {
		return {
			message:
				`ONNX Runtime has no build for ${target}; semantic search needs the "hashed" embedding provider (no model, ` +
				'works everywhere) or an OpenAI-compatible endpoint.',
			detail,
		};
	}
	if (err.code === 'MODULE_NOT_FOUND' && raw.includes(BINDING)) {
		const stack = Array.isArray(err.requireStack) ? (err.requireStack as unknown[]) : [];
		const binding = stack.find((f): f is string => typeof f === 'string' && f.endsWith('binding.js'));
		let installed: readonly string[] | undefined;
		if (binding) {
			try {
				installed = env.installedTargets(path.dirname(path.dirname(binding)));
			} catch {
				installed = undefined;
			}
		}
		let has = 'This installation of ONNX Runtime has no binaries for';
		if (installed && installed.length > 0) {
			has = `This installation of ONNX Runtime only contains binaries for ${installed.join(', ')}, not`;
		} else if (installed) {
			has = 'This installation of ONNX Runtime contains no native binaries at all, so none for';
		}
		return {
			message:
				`${has} ${target}, and ${process_}. Install the build made for ${target}: a VSIX whose name ends in ` +
				`"-${target}", or reinstall the CLI on this machine.`,
			detail,
		};
	}
	if (err.code === 'MODULE_NOT_FOUND') {
		return { message: `ONNX Runtime is not installed (${firstLine}). Reinstall Promptback.`, detail };
	}
	if (
		err.code === 'ERR_DLOPEN_FAILED' ||
		/dlopen|could not be found|cannot open shared object|not a valid/i.test(raw)
	) {
		if (env.platform === 'win32') {
			if (/not a valid/i.test(raw)) {
				return {
					message: `The ONNX Runtime binary is built for another CPU architecture (${firstLine}); ${process_}. Install the build made for ${target}.`,
					detail,
				};
			}
			return {
				message:
					`The ONNX Runtime library could not be loaded (${firstLine}). On Windows this almost always means the ` +
					`Microsoft Visual C++ Redistributable is missing: install ${VC_REDIST}.${env.arch}.exe and restart.`,
				detail,
			};
		}
		if (env.platform === 'linux') {
			return {
				message:
					`The ONNX Runtime library could not be loaded (${firstLine}). A system library it needs is missing or too ` +
					'old; `ldd` on the .node file lists which.',
				detail,
			};
		}
		return { message: `The ONNX Runtime library could not be loaded (${firstLine}).`, detail };
	}
	return { message: `ONNX Runtime failed to load: ${firstLine}`, detail };
}
