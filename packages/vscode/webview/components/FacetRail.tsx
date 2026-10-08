import { useMemo, useState } from 'preact/hooks';
import {
	CLIENT_LABELS, type FacetKey, ORIGIN_LABELS, type ViewModel, type ViewState, histogram,
} from '../model.js';
import { Icon } from './common.js';

type SetView = (f: (v: ViewState) => ViewState) => void;

/** Filters with counts; every count assumes all *other* filters, so options never disappear. */
export function FacetRail({ vm, view, setView }: { vm: ViewModel; view: ViewState; setView: SetView }) {
	const sections: { key: FacetKey; title: string; icon: string; label: (v: string) => string; limit: number }[] = [
		{ key: 'origin', title: 'Author', icon: 'person', label: v => ORIGIN_LABELS[v as keyof typeof ORIGIN_LABELS] ?? v, limit: 10 },
		{ key: 'client', title: 'Source', icon: 'device-desktop', label: v => CLIENT_LABELS[v] ?? v, limit: 10 },
		{ key: 'repo', title: 'Repository', icon: 'repo', label: v => v, limit: 12 },
	];
	const [expanded, setExpanded] = useState<Record<string, boolean>>({});
	const toggle = (key: FacetKey, value: string) => setView(v => {
		const cur = v.facets[key];
		return { ...v, facets: { ...v.facets, [key]: cur.includes(value) ? cur.filter(x => x !== value) : [...cur, value] } };
	});
	const any = view.facets.origin.length || view.facets.client.length || view.facets.repo.length || view.dateRange || !view.hideAcks;
	return (
		<aside class="rail" aria-label="Filters">
			<div class="rail-head">
				<span>Filters</span>
				{any ? <button class="link" onClick={() => setView(v => ({ ...v, facets: { origin: [], client: [], repo: [] }, dateRange: undefined, hideAcks: true }))}>Clear all</button> : null}
			</div>
			<section>
				<h3><Icon name="calendar" />When</h3>
				<Histogram timestamps={vm.timeline} range={view.dateRange} setRange={r => setView(v => ({ ...v, dateRange: r }))} />
			</section>
			{sections.map(s => {
				const values = vm.facets[s.key];
				const max = Math.max(1, ...values.map(v => v.count));
				const shown = expanded[s.key] ? values : values.slice(0, s.limit);
				return (
					<section key={s.key}>
						<h3><Icon name={s.icon} />{s.title}</h3>
						<ul>
							{shown.map(v => (
								<li key={v.value}>
									<label class={`facet ${v.count === 0 ? 'zero' : ''}`} title={v.value}>
										<input type="checkbox" checked={view.facets[s.key].includes(v.value)} onChange={() => toggle(s.key, v.value)} />
										<span class="name">{s.label(v.value)}</span>
										<span class="bar" style={{ width: `${(v.count / max) * 100}%` }} />
										<span class="count">{v.count}</span>
									</label>
								</li>
							))}
						</ul>
						{values.length > s.limit && (
							<button class="link" onClick={() => setExpanded(e => ({ ...e, [s.key]: !e[s.key] }))}>
								{expanded[s.key] ? 'Show fewer' : `Show all ${values.length}`}
							</button>
						)}
					</section>
				);
			})}
			<section>
				<label class="check"><input type="checkbox" checked={!view.hideAcks} onChange={() => setView(v => ({ ...v, hideAcks: !v.hideAcks }))} />Include short replies ("continue", "yes")</label>
			</section>
		</aside>
	);
}

/** Clickable/brushable date histogram. Drag to select a range; "Any time" clears it. */
function Histogram({ timestamps, range, setRange }: { timestamps: readonly number[]; range?: readonly [number, number]; setRange: (r?: [number, number]) => void }) {
	const buckets = useMemo(() => histogram(timestamps), [timestamps]);
	const [drag, setDrag] = useState<[number, number]>();
	if (!buckets.length) {
		return <div class="muted small">No dates</div>;
	}
	const max = Math.max(...buckets.map(b => b.count));
	const W = 200, H = 48, bw = W / buckets.length;
	const idx = (e: MouseEvent) => {
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		return Math.max(0, Math.min(buckets.length - 1, Math.floor(((e.clientX - rect.left) / rect.width) * buckets.length)));
	};
	const sel = drag ? [Math.min(...drag), Math.max(...drag)] : undefined;
	const inRange = (i: number) => sel ? i >= sel[0]! && i <= sel[1]! : range ? buckets[i]!.start >= range[0] && buckets[i]!.end <= range[1] : true;
	const fmt = (t: number) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
	return (
		<div class="histogram">
			<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Prompts over time; drag to filter"
				onMouseDown={e => setDrag([idx(e), idx(e)])}
				onMouseMove={e => drag && setDrag([drag[0], idx(e)])}
				onMouseUp={() => {
					if (sel) {
						setRange([buckets[sel[0]!]!.start, buckets[sel[1]!]!.end]);
					}
					setDrag(undefined);
				}}
				onMouseLeave={() => setDrag(undefined)}>
				{buckets.map((b, i) => {
					const h = b.count ? Math.max(2, (b.count / max) * (H - 2)) : 0;
					return <rect key={b.start} x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1)} height={h} class={inRange(i) ? 'in' : 'out'}><title>{`${fmt(b.start)}: ${b.count}`}</title></rect>;
				})}
			</svg>
			<div class="axis">
				<span>{fmt(range?.[0] ?? buckets[0]!.start)}</span>
				{range ? <button class="link" onClick={() => setRange(undefined)}>Any time</button> : null}
				<span>{fmt(range ? range[1] - 1 : buckets[buckets.length - 1]!.end - 1)}</span>
			</div>
		</div>
	);
}
