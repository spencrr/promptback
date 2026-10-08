import type { EmbeddingProvider } from '../embed/provider.js';
import type { PromptMeta, Store, VectorMatrix } from '../store.js';
import type { SessionInfo } from '../types.js';
import { type GlobalVocabulary, buildVocabulary } from './topics.js';

/**
 * Immutable in-memory snapshot of everything ranking needs: prompt metadata, sessions (with derived fork lineage)
 * and the embedding matrix. Rebuilt only when the index revision or the active model changes.
 */
export interface Corpus {
	readonly revision: string;
	/** Cache key: model fingerprint and dimensions. */
	readonly key: string;
	readonly fingerprint: string | undefined;
	readonly meta: ReadonlyMap<number, PromptMeta>;
	readonly sessions: ReadonlyMap<string, SessionInfo>;
	readonly matrix: VectorMatrix | undefined;
	/** Row (in {@link matrix}) of each prompt's first chunk, used as the prompt's vector for topic clustering. */
	readonly heads: ReadonlyMap<number, number>;
	/** Word document frequencies over every prompt, built on first use (topic labels). */
	vocabulary(): GlobalVocabulary;
}

export class CorpusCache {
	private current: Corpus | undefined;

	constructor(private readonly store: Store, private readonly provider: () => EmbeddingProvider | undefined) { }

	get(): Corpus {
		const revision = this.store.getMeta('revision') ?? '0';
		// Before the model has loaded, use the vectors of the last model that embedded this index (browsing and topics
		// work immediately; only new query embeddings need the model).
		const p = this.provider();
		const fingerprint = p?.info.fingerprint ?? this.store.getMeta('modelFingerprint');
		const dims = p?.info.dims || Number(this.store.getMeta('modelDims') ?? 0);
		const key = `${fingerprint}:${dims}`;
		if (this.current && this.current.revision === revision && this.current.key === key) {
			return this.current;
		}
		const meta = new Map(this.store.listPromptMeta().map(m => [m.rowid, m]));
		const sessions = withLineage(this.store.listAllSessions(), meta.values());
		const matrix = fingerprint && dims ? this.store.loadVectorMatrix(fingerprint, dims) : undefined;
		const heads = new Map<number, number>();
		for (let i = 0; i < (matrix?.count ?? 0); i++) {
			if (matrix!.ords[i] === 0) {
				heads.set(matrix!.promptRowids[i]!, i);
			}
		}
		let vocab: GlobalVocabulary | undefined;
		const vocabulary = () => (vocab ??= buildVocabulary(this.store.iterateTexts(4000)));
		this.current = { revision, key, fingerprint, meta, sessions, matrix, heads, vocabulary };
		return this.current;
	}
}

/**
 * Copilot forks copy the parent's events — including their ids — into the new session, so prompt ids
 * (`copilot:<session>:<eventId>`) shared between sessions reveal lineage without parsing fork notices.
 * Parent = the earlier-created session sharing the most events. Ties go to the earliest such session: a sibling
 * forked from the same point shares exactly what the real parent shares, and the parent is always older. A fork of a
 * fork that has new prompts shares strictly more with its direct parent, so it still resolves correctly.
 * Fork point = the child's last shared prompt.
 */
export function withLineage(list: readonly SessionInfo[], prompts: Iterable<PromptMeta>): Map<string, SessionInfo> {
	const sessions = new Map(list.map(s => [s.key, s]));
	const byEvent = new Map<string, { sessionKey: string; seq: number }[]>();
	for (const p of prompts) {
		if (!p.id.startsWith('copilot:')) {
			continue;
		}
		const eventId = p.id.slice(p.sessionKey.length + 1);
		// Offset-based fallback ids ("@123") are only unique within one file, so they can't indicate shared history.
		if (eventId.startsWith('@')) {
			continue;
		}
		let list = byEvent.get(eventId);
		if (!list) {
			list = [];
			byEvent.set(eventId, list);
		}
		list.push({ sessionKey: p.sessionKey, seq: p.seq });
	}

	// child -> parent candidate -> { shared count, child's max shared seq }
	const shared = new Map<string, Map<string, { count: number; lastSeq: number }>>();
	for (const occ of byEvent.values()) {
		if (occ.length < 2) {
			continue;
		}
		for (const a of occ) {
			for (const b of occ) {
				if (a.sessionKey === b.sessionKey) {
					continue;
				}
				let m = shared.get(a.sessionKey);
				if (!m) {
					m = new Map();
					shared.set(a.sessionKey, m);
				}
				const e = m.get(b.sessionKey) ?? { count: 0, lastSeq: -1 };
				e.count++;
				e.lastSeq = Math.max(e.lastSeq, a.seq);
				m.set(b.sessionKey, e);
			}
		}
	}

	const created = (key: string) => sessions.get(key)?.createdAt ?? Number.MAX_SAFE_INTEGER;
	for (const [child, candidates] of shared) {
		const childInfo = sessions.get(child);
		if (!childInfo) {
			continue;
		}
		let best: { key: string; count: number; lastSeq: number } | undefined;
		for (const [key, e] of candidates) {
			if (created(key) >= created(child)) {
				continue;
			}
			if (!best || e.count > best.count || (e.count === best.count && created(key) < created(best.key))) {
				best = { key, ...e };
			}
		}
		if (best) {
			sessions.set(child, { ...childInfo, forkOf: best.key, forkPointSeq: best.lastSeq });
		}
	}
	return sessions;
}
