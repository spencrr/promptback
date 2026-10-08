export interface ModelFile {
	readonly path: string;
	readonly size: number;
	readonly sha256: string;
}

export interface LocalModelSpec {
	readonly id: string;
	readonly displayName: string;
	readonly repo: string;
	/** Pinned Hugging Face commit. */
	readonly revision: string;
	readonly license: string;
	readonly dims: number;
	/** Max sequence length including special tokens. */
	readonly maxTokens: number;
	readonly pooling: 'cls' | 'mean';
	readonly queryPrefix: string;
	readonly documentPrefix: string;
	readonly files: readonly ModelFile[];
}

const BERT_TOKENIZER_CONFIG: ModelFile = { path: 'tokenizer_config.json', size: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' };

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
		files: [
			{ path: 'onnx/model_quantized.onnx', size: 34014426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
			{ path: 'tokenizer.json', size: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
			BERT_TOKENIZER_CONFIG,
			{ path: 'config.json', size: 683, sha256: 'fa73f90bf92c8cace1fbcb709626306f2bdbc9ea3e5b5f94b440df9b6aa56350' },
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
		files: [
			{ path: 'onnx/model_quantized.onnx', size: 22972370, sha256: 'afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1' },
			{ path: 'tokenizer.json', size: 711661, sha256: 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' },
			BERT_TOKENIZER_CONFIG,
			{ path: 'config.json', size: 650, sha256: '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7' },
		],
	},
];

export const DEFAULT_LOCAL_MODEL = 'bge-small-en-v1.5';

export function getModelSpec(id: string): LocalModelSpec {
	const spec = LOCAL_MODELS.find(m => m.id === id);
	if (!spec) {
		throw new Error(`Unknown local embedding model '${id}'. Known: ${LOCAL_MODELS.map(m => m.id).join(', ')}`);
	}
	return spec;
}

export function modelFileUrl(spec: LocalModelSpec, file: ModelFile, mirror = 'https://huggingface.co'): string {
	return `${mirror.replace(/\/$/, '')}/${spec.repo}/resolve/${spec.revision}/${file.path}`;
}
