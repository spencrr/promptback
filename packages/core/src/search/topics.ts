/**
 * Topic clusters for a result set, shown by the Explorer's graph.
 *
 * Clustering: spherical k-means on prompt vectors (cosine similarity on L2-normalized embeddings). Seeding is
 * deterministic farthest-first, starting from the best-ranked prompt, so the same query always gives the same
 * topics. k is chosen by the best mean silhouette in 3..8 (2..4 for small sets). Clusters smaller than 3 become
 * "Other".
 *
 * Labels: a class-based TF-IDF variant (cf. c-TF-IDF in BERTopic, Grootendorst 2022, arXiv:2203.05794). A word scores
 *   (share of the topic's prompts that use it) × log(N / df across your whole history) × (share of its uses inside this topic)
 * so words that are frequent in the topic, rare in general, and specific to this topic win.
 */
import type { Topic } from '../types.js';
import { contentTokens } from './query.js';

export interface TopicResult {
	readonly topics: readonly Topic[];
	/** Topic id per input index; -1 = Other (small clusters). */
	readonly assignment: readonly number[];
}

/** Document frequency of every word across the whole corpus, for label weighting. */
export interface GlobalVocabulary {
	readonly docs: number;
	readonly df: ReadonlyMap<string, number>;
}

const MIN_CLUSTER = 3;
const ITERATIONS = 25;

export function clusterTopics(
	vectors: readonly Float32Array[],
	texts: readonly string[],
	options: { exclude?: readonly string[]; vocabulary?: GlobalVocabulary } = {},
): TopicResult {
	const n = vectors.length;
	if (n < 2 * MIN_CLUSTER) {
		return { topics: [], assignment: new Array(n).fill(-1) };
	}
	const sim = similarityMatrix(vectors);
	const [kMin, kMax] = n >= 24 ? [3, 8] : [2, 4];
	let best: { labels: number[]; score: number } | undefined;
	for (let k = kMin; k <= Math.min(kMax, Math.floor(n / MIN_CLUSTER)); k++) {
		const labels = kmeans(vectors, k);
		const score = silhouette(sim, labels, k);
		if (!best || score > best.score + 1e-9) {
			best = { labels, score };
		}
	}
	if (!best) {
		return { topics: [], assignment: new Array(n).fill(-1) };
	}

	// Relabel by size (largest first); fold tiny clusters into Other (-1).
	const sizes = new Map<number, number>();
	for (const l of best.labels) {
		sizes.set(l, (sizes.get(l) ?? 0) + 1);
	}
	const order = [...sizes]
		.filter(([, s]) => s >= MIN_CLUSTER)
		.sort((a, b) => b[1] - a[1] || a[0] - b[0])
		.map(([l]) => l);
	const remap = new Map(order.map((l, i) => [l, i]));
	const labels = best.labels.map(l => remap.get(l) ?? -1);

	const terms = labelTerms(texts, labels, order.length, {
		exclude: new Set((options.exclude ?? []).map(t => t.toLowerCase())),
		vocab: options.vocabulary,
	});
	const topics: Topic[] = order.map((_, id) => {
		const members = labels.flatMap((l, i) => (l === id ? [i] : []));
		const medoid = members.reduce(
			(central, i) => (meanSim(sim, i, members, n) > meanSim(sim, central, members, n) ? i : central),
			members[0]!,
		);
		return {
			id,
			terms: terms[id]!,
			label: headline(texts[medoid] ?? '') || terms[id]!.slice(0, 3).join(' · ') || `Topic ${id + 1}`,
			representative: medoid,
			size: members.length,
		};
	});
	return { topics, assignment: labels };
}

function meanSim(sim: Float32Array, i: number, members: readonly number[], n: number): number {
	let s = 0;
	for (const j of members) {
		s += sim[i * n + j]!;
	}
	return s / members.length;
}

/** The first meaningful line of a prompt, shortened: the topic's most central prompt names it best. */
function headline(text: string): string {
	const line =
		text
			.split(/\r?\n/u)
			.map(l => l.replace(/^[#>*\-\s`]+/u, '').trim())
			.find(l => l.length >= 8) ?? '';
	return line.length > 48 ? `${line.slice(0, 47).replace(/\s+\S*$/u, '')}…` : line;
}

function dot(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let d = 0; d < a.length; d++) {
		s += a[d]! * b[d]!;
	}
	return s;
}

function similarityMatrix(v: readonly Float32Array[]): Float32Array {
	const n = v.length;
	const m = new Float32Array(n * n);
	for (let i = 0; i < n; i++) {
		m[i * n + i] = 1;
		for (let j = i + 1; j < n; j++) {
			const s = dot(v[i]!, v[j]!);
			m[i * n + j] = s;
			m[j * n + i] = s;
		}
	}
	return m;
}

/** Spherical k-means with deterministic farthest-first seeding (index 0 = best-ranked item). */
function kmeans(v: readonly Float32Array[], k: number): number[] {
	const dims = v[0]!.length;
	const centres: Float32Array[] = [Float32Array.from(v[0]!)];
	const nearest = v.map(x => dot(x, centres[0]!));
	while (centres.length < k) {
		let far = 0;
		for (let i = 1; i < v.length; i++) {
			if (nearest[i]! < nearest[far]!) {
				far = i;
			}
		}
		centres.push(Float32Array.from(v[far]!));
		const centre = centres.at(-1)!;
		for (const [i, x] of v.entries()) {
			nearest[i] = Math.max(nearest[i]!, dot(x, centre));
		}
	}
	let labels = new Array<number>(v.length).fill(0);
	for (let iter = 0; iter < ITERATIONS; iter++) {
		const next = v.map(x => {
			let bestC = 0;
			let bestS = Number.NEGATIVE_INFINITY;
			centres.forEach((c, ci) => {
				const s = dot(x, c);
				if (s > bestS) {
					bestS = s;
					bestC = ci;
				}
			});
			return bestC;
		});
		const changed = next.some((l, i) => l !== labels[i]);
		labels = next;
		for (let c = 0; c < k; c++) {
			const sum = new Float32Array(dims);
			let count = 0;
			v.forEach((x, i) => {
				if (labels[i] === c) {
					count++;
					for (let d = 0; d < dims; d++) {
						sum[d] = sum[d]! + x[d]!;
					}
				}
			});
			if (count) {
				const norm = Math.sqrt(dot(sum, sum)) || 1;
				centres[c] = sum.map(x => x / norm);
			}
		}
		if (!changed && iter > 0) {
			break;
		}
	}
	return labels;
}

/** Mean silhouette with cosine distance (1 − similarity). */
function silhouette(sim: Float32Array, labels: readonly number[], k: number): number {
	const n = labels.length;
	let total = 0;
	for (let i = 0; i < n; i++) {
		const sums = new Array<number>(k).fill(0);
		const counts = new Array<number>(k).fill(0);
		for (let j = 0; j < n; j++) {
			if (i !== j) {
				sums[labels[j]!] = sums[labels[j]!]! + 1 - sim[i * n + j]!;
				counts[labels[j]!] = counts[labels[j]!]! + 1;
			}
		}
		const own = labels[i]!;
		if (!counts[own]) {
			continue;
		}
		const a = sums[own]! / counts[own]!;
		let b = Number.POSITIVE_INFINITY;
		for (let c = 0; c < k; c++) {
			if (c !== own && counts[c]) {
				b = Math.min(b, sums[c]! / counts[c]!);
			}
		}
		total += b === Number.POSITIVE_INFINITY ? 0 : (b - a) / Math.max(a, b);
	}
	return total / n;
}

function labelTerms(
	texts: readonly string[],
	labels: readonly number[],
	k: number,
	{ exclude, vocab }: { readonly exclude: ReadonlySet<string>; readonly vocab?: GlobalVocabulary },
): string[][] {
	const df = Array.from({ length: k }, () => new Map<string, number>());
	const dfAll = new Map<string, number>();
	const sizes = new Array<number>(k).fill(0);
	texts.forEach((text, i) => {
		const c = labels[i]!;
		const words = new Set(topicTokens(text).filter(t => !exclude.has(t)));
		for (const t of words) {
			dfAll.set(t, (dfAll.get(t) ?? 0) + 1);
			if (c >= 0) {
				df[c]!.set(t, (df[c]!.get(t) ?? 0) + 1);
			}
		}
		if (c >= 0) {
			sizes[c]!++;
		}
	});
	const docs = vocab?.docs ?? texts.length;
	return df.map((m, c) =>
		[...m]
			// A label word must be used by several of the topic's prompts and mostly within this topic.
			.filter(([t, f]) => f >= Math.min(2, sizes[c]!) && (k === 1 || f / dfAll.get(t)! >= 0.5))
			.map(([t, f]) => {
				const idf = Math.log((docs + 1) / ((vocab?.df.get(t) ?? dfAll.get(t)!) + 1));
				return [t, (f / sizes[c]!) * idf * (f / dfAll.get(t)!)] as const;
			})
			.filter(([, s]) => s > 0)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([t]) => t),
	);
}

const NOISE =
	/^(?:https?|www|com|src|users?|true|false|null|undefined|here|there|below|above|following|particular|necessary|great|simplest|clean|original|actually|really|currently|already|instead|maybe|probably|something|anything|everything|thing|things|way|ways|lot|bit|kind|sure|okay|thanks|thank|good|better|best|nice|new|old|first|last|next|done|still|well|much|many|more|most|less|least|each|every|both|either|neither|etc|via|per|one|two|three)$/u;

/** Words considered for topic labels: lowercase alphabetic identifiers, no stopwords, hex ids or noise. */
export function topicTokens(text: string): string[] {
	return contentTokens(text.slice(0, 4000)).filter(
		t => t.length >= 4 && t.length <= 20 && /^[a-z][a-z_]*[a-z]$/u.test(t) && !NOISE.test(t),
	);
}

/** Builds the corpus-wide vocabulary used to down-weight words that are common in all of your prompts. */
export function buildVocabulary(texts: Iterable<string>): GlobalVocabulary {
	const df = new Map<string, number>();
	let docs = 0;
	for (const text of texts) {
		docs++;
		for (const t of new Set(topicTokens(text))) {
			df.set(t, (df.get(t) ?? 0) + 1);
		}
	}
	return { docs, df };
}
