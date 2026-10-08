/**
 * Retrieval + latency benchmark against your real (local) index. Labeled queries live in bench/data/*.local.json
 * (gitignored — they reference private prompts): [{ "query": "...", "set": "normal|hard", "targets": ["<promptId>"] }]
 *
 *   npm run bench -w packages/core -- [--model-dir <dir>] [--z 2.5]
 *
 * Reports quick-search MRR@10 / Recall@10, explore match-set recall and size, and cold/warm latencies.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { PromptSearchEngine } from '../src/engine.js';

const { values } = parseArgs({ options: { 'model-dir': { type: 'string' }, 'index-dir': { type: 'string' }, z: { type: 'string' } } });
const dataDir = path.resolve(process.cwd(), 'bench', 'data');
const labeled = fs.readdirSync(dataDir)
	.filter(f => f.endsWith('.local.json'))
	.flatMap(f => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) as { query: string; set: string; targets: string[] }[]);

const engine = PromptSearchEngine.open({
	indexDir: values['index-dir'],
	embedding: { kind: 'local', model: 'bge-small-en-v1.5', modelDir: values['model-dir'] },
	allowModelDownload: !values['model-dir'],
	ranking: values.z ? { semanticMatchZ: Number(values.z) } : undefined,
});

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? 0;
const time = async <T>(fn: () => Promise<T>) => {
	const t = performance.now();
	const r = await fn();
	return [r, performance.now() - t] as const;
};

const [, coldBrowse] = await time(() => engine.explore(''));
const [, coldSearch] = await time(() => engine.search('design doc for the tree view'));
console.log(`cold: explore('') ${coldBrowse.toFixed(0)} ms, first semantic search (model load) ${coldSearch.toFixed(0)} ms`);

const stats = new Map<string, { n: number; rr: number; r10: number; exploreRecall: number; exploreSize: number[] }>();
const searchMs: number[] = [], exploreMs: number[] = [];
for (const { query, set, targets } of labeled) {
	const [res, ms] = await time(() => engine.search({ text: query, limit: 10 }));
	searchMs.push(ms);
	const ids = res.hits.flatMap(h => [h.prompt.id, ...h.duplicates.map(d => d.promptId)]);
	const rank = res.hits.findIndex(h => [h.prompt.id, ...h.duplicates.map(d => d.promptId)].some(id => targets.includes(id)));
	const [ex, ems] = await time(() => engine.explore(query));
	exploreMs.push(ems);
	const exIds = new Set(ex.rows.map(r => r.id));
	const s = stats.get(set) ?? { n: 0, rr: 0, r10: 0, exploreRecall: 0, exploreSize: [] };
	s.n++;
	s.rr += rank >= 0 ? 1 / (rank + 1) : 0;
	s.r10 += targets.some(t => ids.includes(t)) ? 1 : 0;
	s.exploreRecall += targets.filter(t => exIds.has(t)).length / targets.length;
	s.exploreSize.push(ex.rows.filter(r => r.origin === 'human').length);
	stats.set(set, s);
}
for (const [set, s] of stats) {
	console.log(`${set.padEnd(14)} n=${s.n}  MRR@10 ${(s.rr / s.n).toFixed(3)}  R@10 ${(s.r10 / s.n).toFixed(3)}  explore recall ${(s.exploreRecall / s.n).toFixed(3)}  explore size (human) p50 ${pct(s.exploreSize, 0.5)} p90 ${pct(s.exploreSize, 0.9)}`);
}
console.log(`warm search  p50 ${pct(searchMs, 0.5).toFixed(0)} ms  p95 ${pct(searchMs, 0.95).toFixed(0)} ms`);
console.log(`warm explore p50 ${pct(exploreMs, 0.5).toFixed(0)} ms  p95 ${pct(exploreMs, 0.95).toFixed(0)} ms`);
await engine.close();
