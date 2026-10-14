import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ExploreResult } from '@promptback/core/types';
import { ConstellationGraph } from '../graph.js';
import { type ColorBy, type ViewModel, buildGraph } from '../model.js';
import { Icon } from './common.js';

const NODE_LIMIT = 60;

const EXPLAIN: Record<ColorBy, string> = {
	topic: 'Slices are topics: clusters of prompts with similar meaning, named after their most central prompt.',
	repo: 'Slices are repositories (or folders).',
	source: 'Slices are where the prompt was sent (Agents window, CLI, autopilot, Chat panel).',
	session: 'Slices are sessions.',
};

/** Canvas graph of the top results, linked to the table selection and hover. */
export function GraphView({ vm, result, colorBy, selectedId, hoveredId, select, hover, reducedMotion, onActivate }: {
	vm: ViewModel;
	result: ExploreResult;
	colorBy: ColorBy;
	selectedId?: string;
	hoveredId?: string;
	select: (id: string) => void;
	hover: (id: string | undefined) => void;
	reducedMotion: boolean;
	onActivate: (id: string) => void;
}) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const graphRef = useRef<ConstellationGraph>();
	const [focusGroup, setFocusGroup] = useState<string>();
	const handlers = useRef({ select, onActivate, hover });
	handlers.current = { select, onActivate, hover };
	const model = useMemo(() => buildGraph(vm, result, NODE_LIMIT, colorBy), [vm, result, colorBy]);

	useEffect(() => {
		const g = new ConstellationGraph(canvasRef.current!, {
			reducedMotion,
			onSelect: id => handlers.current.select(id),
			onActivate: id => handlers.current.onActivate(id),
			onHover: id => handlers.current.hover(id),
		});
		graphRef.current = g;
		return () => g.dispose();
	}, [reducedMotion]);

	useEffect(() => {
		graphRef.current?.setData(result.freeText || result.query, model.nodes, model.edges, model.groups);
	}, [model, reducedMotion]);
	useEffect(() => graphRef.current?.setSelected(selectedId), [selectedId, model]);
	useEffect(() => graphRef.current?.setHovered(hoveredId), [hoveredId]);
	useEffect(() => {
		setFocusGroup(undefined);
	}, [colorBy, result.query]);
	useEffect(() => graphRef.current?.setFocusGroup(focusGroup), [focusGroup]);

	const shown = Math.min(NODE_LIMIT, vm.rows.length);
	return (
		<div class="graph">
			<canvas ref={canvasRef} role="img" aria-label="Constellation of matching prompts: closer to the centre means more relevant" />
			<div class="graph-help">
				<div>
					<Icon name="info" />
					{result.freeText ? 'Closer to the centre = more relevant.' : 'Closer to the centre = more recent.'} {EXPLAIN[colorBy]} Inside a slice, older → newer runs clockwise.
				</div>
				<div class="muted">Lines join prompts of one session; dashed = forked from. Showing the top {shown} of {vm.rows.length}.</div>
			</div>
			<div class="legend" role="list" aria-label="Groups (click to highlight)">
				{model.groups.map(g => (
					<button key={g.key} role="listitem" class={`legend-item ${focusGroup === g.key ? 'on' : ''} ${focusGroup && focusGroup !== g.key ? 'dim' : ''}`}
						title={`${g.label} — click to highlight`} onClick={() => setFocusGroup(f => (f === g.key ? undefined : g.key))}>
						<i style={{ background: g.color }} />
						<span class="text">{g.label}</span>
						<span class="muted">{g.count}</span>
					</button>
				))}
			</div>
		</div>
	);
}
