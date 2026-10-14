import * as fs from 'node:fs';
import * as path from 'node:path';
import * as z from 'zod/v4';
import { Registry } from '../registry.js';

/** A file of a local model. `sha256` is required for downloadable (built-in) models and optional for user manifests. */
export const modelFileSchema = z.object({
	path: z
		.string()
		.min(1)
		.regex(/^[^\\]+$/, 'use forward slashes'),
	size: z.number().int().positive(),
	sha256: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional(),
});

/**
 * A local ONNX embedding model. Built-ins are pinned to a Hugging Face revision and hash-verified; a user can describe
 * their own model in `<modelDir>/model.json` with the same shape (see {@link loadModelManifest}).
 */
export const localModelSpecSchema = z.object({
	id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, . _ -'),
	displayName: z.string().min(1),
	/** Hugging Face repository (`owner/name`); empty for models that are never downloaded. */
	repo: z.string().default(''),
	/** Pinned Hugging Face commit; empty for models that are never downloaded. */
	revision: z.string().default(''),
	license: z.string().default('unknown'),
	dims: z.number().int().positive(),
	/** Max sequence length including special tokens. */
	maxTokens: z.number().int().positive(),
	pooling: z.enum(['cls', 'mean']),
	queryPrefix: z.string().default(''),
	documentPrefix: z.string().default(''),
	/** Relative path of the ONNX graph inside the model directory. */
	modelFile: z.string().default('onnx/model_quantized.onnx'),
	files: z.array(modelFileSchema).min(1),
});

export type ModelFile = z.infer<typeof modelFileSchema>;
export type LocalModelSpec = z.infer<typeof localModelSpecSchema>;

const BERT_TOKENIZER_CONFIG: ModelFile = {
	path: 'tokenizer_config.json',
	size: 366,
	sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
};

export const LOCAL_MODELS: readonly LocalModelSpec[] = [
	{
		id: 'bge-small-en-v1.5',
		displayName: 'BGE small en v1.5 (q8)',
		repo: 'Xenova/bge-small-en-v1.5',
		revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
		license: 'MIT',
		dims: 384,
		maxTokens: 512,
		pooling: 'cls',
		queryPrefix: 'Represent this sentence for searching relevant passages: ',
		documentPrefix: '',
		modelFile: 'onnx/model_quantized.onnx',
		files: [
			{
				path: 'onnx/model_quantized.onnx',
				size: 34_014_426,
				sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
			},
			{
				path: 'tokenizer.json',
				size: 711_396,
				sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
			},
			BERT_TOKENIZER_CONFIG,
			{
				path: 'config.json',
				size: 683,
				sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350',
			},
		],
	},
	{
		id: 'all-MiniLM-L6-v2',
		displayName: 'all-MiniLM-L6-v2 (q8, fast)',
		repo: 'Xenova/all-MiniLM-L6-v2',
		revision: '751bff37182d3f1213fa05d7196b954e230abad9',
		license: 'Apache-2.0',
		dims: 384,
		maxTokens: 256,
		pooling: 'mean',
		queryPrefix: '',
		documentPrefix: '',
		modelFile: 'onnx/model_quantized.onnx',
		files: [
			{
				path: 'onnx/model_quantized.onnx',
				size: 22_972_370,
				sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1',
			},
			{
				path: 'tokenizer.json',
				size: 711_661,
				sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
			},
			BERT_TOKENIZER_CONFIG,
			{
				path: 'config.json',
				size: 650,
				sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
			},
		],
	},
];

export const DEFAULT_LOCAL_MODEL = 'bge-small-en-v1.5';

/** Registry of local models. Register a validated spec to make a new model selectable by id. */
export const localModels = new Registry<LocalModelSpec>(
	'local embedding model',
	LOCAL_MODELS.map(m => localModelSpecSchema.parse(m)),
);

export function getModelSpec(id: string): LocalModelSpec {
	return localModels.require(id);
}

export const MODEL_MANIFEST = 'model.json';

/**
 * Reads and validates `<dir>/model.json`, a user-supplied model description with the {@link localModelSpecSchema}
 * shape. Returns `undefined` when the directory has no manifest. The spec is registered (or re-used if an identical
 * id is already known) so the rest of the pipeline treats it like a built-in.
 */
export function loadModelManifest(dir: string): LocalModelSpec | undefined {
	const file = path.join(dir, MODEL_MANIFEST);
	if (!fs.existsSync(file)) {
		return undefined;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
	}
	const r = localModelSpecSchema.safeParse(raw);
	if (!r.success) {
		throw new Error(
			`${file} is not a valid model manifest: ${r.error.issues.map(i => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`).join('; ')}`,
		);
	}
	const spec = r.data;
	const known = localModels.get(spec.id);
	if (known && JSON.stringify(known) !== JSON.stringify(spec)) {
		throw new Error(`${file} redefines model '${spec.id}' differently from the registered one`);
	}
	if (!known) {
		localModels.register(spec);
	}
	return spec;
}

export function modelFileUrl(spec: LocalModelSpec, file: ModelFile, mirror = 'https://huggingface.co'): string {
	if (!spec.repo || !spec.revision) {
		throw new Error(`Model '${spec.id}' has no download location`);
	}
	return `${mirror.replace(/\/$/, '')}/${spec.repo}/resolve/${spec.revision}/${file.path}`;
}
