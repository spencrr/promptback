import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	describeOnnxRuntimeError,
	isOnnxRuntimeSupported,
	loadOnnxRuntime,
	NativeRuntimeError,
	ONNX_RUNTIME_TARGETS,
	onnxRuntimeTarget,
	type RuntimeEnvironment,
} from '../src/embed/ort.js';

const env = (over: Partial<RuntimeEnvironment> = {}): RuntimeEnvironment => ({
	platform: 'win32',
	arch: 'arm64',
	nodeVersion: 'v24.0.0',
	installedTargets: () => ['win32-x64'],
	...over,
});

/** What Node throws when onnxruntime-node's `binding.js` requires a `.node` file that is not there. */
function missingBinding(root: string): Error & { code: string; requireStack: string[] } {
	const e = new Error(
		`Cannot find module '../bin/napi-v6/win32/arm64/onnxruntime_binding.node'\nRequire stack:\n- ${root}/dist/binding.js`,
	) as Error & { code: string; requireStack: string[] };
	e.code = 'MODULE_NOT_FOUND';
	e.requireStack = [`${root}/dist/binding.js`, `${root}/dist/backend.js`, `${root}/dist/index.js`];
	return e;
}

describe('describeOnnxRuntimeError', () => {
	it('names the targets a pruned installation has when the binding for this one is missing', () => {
		const roots: string[] = [];
		const r = describeOnnxRuntimeError(
			missingBinding('C:/ext/dist/node_modules/onnxruntime-node'),
			env({
				installedTargets: root => {
					roots.push(root);
					return ['win32-x64'];
				},
			}),
		);
		expect(roots).toEqual(['C:/ext/dist/node_modules/onnxruntime-node']);
		expect(r.message).toBe(
			'This installation of ONNX Runtime only contains binaries for win32-x64, not win32-arm64, and this process is ' +
				'win32-arm64 (Node v24.0.0). Install the build made for win32-arm64: a VSIX whose name ends in "-win32-arm64", ' +
				'or reinstall the CLI on this machine.',
		);
		expect(r.detail).toMatch(/^win32-arm64, Node v24\.0\.0: Cannot find module/);
	});

	it('says so when no native binaries are present at all, or when the package root cannot be inspected', () => {
		const none = describeOnnxRuntimeError(missingBinding('/x'), env({ installedTargets: () => [] }));
		expect(none.message).toMatch(/contains no native binaries at all, so none for win32-arm64/);
		const unreadable = describeOnnxRuntimeError(
			missingBinding('/x'),
			env({
				installedTargets: () => {
					throw new Error('EACCES');
				},
			}),
		);
		expect(unreadable.message).toMatch(/^This installation of ONNX Runtime has no binaries for win32-arm64/);
	});

	it('points at the Visual C++ runtime for a Windows load failure, with the installer for this architecture', () => {
		const e = Object.assign(
			new Error('The specified module could not be found.\r\n\\\\?\\C:\\ext\\onnxruntime_binding.node'),
			{ code: 'ERR_DLOPEN_FAILED' },
		);
		const r = describeOnnxRuntimeError(e, env());
		expect(r.message).toMatch(/Visual C\+\+ Redistributable is missing/);
		expect(r.message).toContain('https://aka.ms/vs/17/release/vc_redist.arm64.exe');
		expect(describeOnnxRuntimeError(e, env({ arch: 'x64' })).message).toContain('vc_redist.x64.exe');
	});

	it('recognises a binary built for another architecture on Windows', () => {
		const e = Object.assign(new Error('%1 is not a valid Win32 application.\r\n\\\\?\\C:\\x.node'), {
			code: 'ERR_DLOPEN_FAILED',
		});
		expect(describeOnnxRuntimeError(e, env()).message).toMatch(/built for another CPU architecture/);
	});

	it('explains unsupported platforms in terms of the alternatives', () => {
		const r = describeOnnxRuntimeError(missingBinding('/x'), env({ platform: 'darwin', arch: 'x64' }));
		expect(r.message).toMatch(/no build for darwin-x64; semantic search needs the "hashed" embedding provider/);
	});

	it('keeps the first line of anything else', () => {
		const r = describeOnnxRuntimeError(new Error('boom\nmore'), env());
		expect(r.message).toBe('ONNX Runtime failed to load: boom');
		expect(describeOnnxRuntimeError('text', env()).message).toBe('ONNX Runtime failed to load: text');
	});

	it('knows the targets onnxruntime-node ships', () => {
		expect(ONNX_RUNTIME_TARGETS).toContain('win32-arm64');
		expect(onnxRuntimeTarget('linux', 'arm64')).toBe('linux-arm64');
		expect(isOnnxRuntimeSupported('darwin', 'x64')).toBe(false);
		expect(isOnnxRuntimeSupported('linux', 'arm64')).toBe(true);
	});
});

// A minimal valid ONNX model, written by hand (protobuf wire format): y = Identity(x), x: float[2].
// Enough to prove the native binding loads and runs a graph on this platform, without a model download.
function identityModel(): Uint8Array {
	// biome-ignore-start lint/suspicious/noBitwiseOperators: protobuf varints and field tags are bit layouts.
	const varint = (n: number): number[] => {
		const out: number[] = [];
		let v = n;
		while (v > 0x7f) {
			out.push((v & 0x7f) | 0x80);
			v >>>= 7;
		}
		out.push(v);
		return out;
	};
	const field = (num: number, bytes: number[]): number[] => [(num << 3) | 2, ...varint(bytes.length), ...bytes];
	const int = (num: number, value: number): number[] => [num << 3, ...varint(value)];
	// biome-ignore-end lint/suspicious/noBitwiseOperators: end of the wire-format helpers.
	const str = (num: number, s: string): number[] => field(num, [...Buffer.from(s, 'utf8')]);
	const tensorType = field(1, [...int(1, 1), ...field(2, field(1, int(1, 2)))]); // float, shape [2]
	const valueInfo = (name: string) => field(name === 'x' ? 11 : 12, [...str(1, name), ...field(2, tensorType)]);
	const node = field(1, [...str(1, 'x'), ...str(2, 'y'), ...str(4, 'Identity')]);
	const graph = field(7, [...node, ...str(2, 'g'), ...valueInfo('x'), ...valueInfo('y')]);
	const opset = field(8, [...str(1, ''), ...int(2, 13)]);
	return Uint8Array.from([...int(1, 7), ...opset, ...graph]);
}

describe.skipIf(!isOnnxRuntimeSupported())('onnxruntime-node on this platform', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptback-ort-'));
	afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('loads the native binding and runs a graph', async () => {
		const ort = await loadOnnxRuntime();
		const file = path.join(dir, 'identity.onnx');
		fs.writeFileSync(file, identityModel());
		const session = await ort.InferenceSession.create(file, { executionProviders: ['cpu'] });
		const out = await session.run({ x: new ort.Tensor('float32', Float32Array.from([1.5, -2]), [2]) });
		expect(Array.from(out.y!.data as Float32Array)).toEqual([1.5, -2]);
		await session.release();
	});
});

describe.skipIf(isOnnxRuntimeSupported())('onnxruntime-node on an unsupported platform', () => {
	it('fails with the alternatives spelled out', async () => {
		await expect(loadOnnxRuntime()).rejects.toBeInstanceOf(NativeRuntimeError);
		await expect(loadOnnxRuntime()).rejects.toThrow(/"hashed" embedding provider/);
	});
});
