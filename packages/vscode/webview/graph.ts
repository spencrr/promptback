/**
 * "Constellation" view of a query's results, drawn on a canvas (layout rules: see `buildGraph` in model.ts).
 * - The query sits at the centre; distance from it = 1 − relevance. Rings mark thirds.
 * - Each group (topic by default) owns a slice of the circle, sized by its node count; its name sits on the rim.
 * - Inside a slice, angle = time (older → newer, clockwise).
 * - Changing the query animates: kept nodes glide, new ones ripple out in rank order, old ones fade.
 * Honors reduced motion by jumping straight to the final frame.
 */

export interface GraphNode {
	readonly id: string;
	readonly label: string;
	readonly group: string;
	readonly color: string;
	readonly sessionKey: string;
	readonly seq: number;
	/** 0..1, 1 = most relevant. */
	readonly relevance: number;
	/** 0..1 position inside the group's slice (time). */
	readonly order: number;
	readonly rank: number;
}

export interface GraphEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: 'session' | 'fork';
}

export interface GraphGroup {
	readonly key: string;
	readonly label: string;
	readonly color: string;
	readonly count: number;
}

interface NodeState {
	node: GraphNode;
	x: number;
	y: number;
	fromX: number;
	fromY: number;
	toX: number;
	toY: number;
	startAt: number;
	alpha: number;
	targetAlpha: number;
	radius: number;
}

interface Slice {
	readonly group: GraphGroup;
	readonly start: number;
	readonly end: number;
}

const MOVE_MS = 520;
const STAGGER_MS = 22;

export interface GraphCallbacks {
	readonly reducedMotion: boolean;
	onSelect: (id: string) => void;
	onActivate: (id: string) => void;
	onHover: (id: string | undefined) => void;
}

export class ConstellationGraph {
	private readonly ctx: CanvasRenderingContext2D;
	private nodes = new Map<string, NodeState>();
	private edges: GraphEdge[] = [];
	private groups: GraphGroup[] = [];
	private slices: Slice[] = [];
	private queryLabel = '';
	private queryStart = 0;
	private hovered: string | undefined;
	private selected: string | undefined;
	private focusGroup: string | undefined;
	private raf = 0;
	private width = 0;
	private height = 0;
	private readonly observer: ResizeObserver;
	private readonly cleanup: (() => void)[] = [];

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly cb: GraphCallbacks,
	) {
		this.ctx = canvas.getContext('2d')!;
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(canvas.parentElement ?? canvas);
		const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
			canvas.addEventListener(type, fn);
			this.cleanup.push(() => canvas.removeEventListener(type, fn));
		};
		on('mousemove', e => this.hoverNode(this.hit(e)?.node.id, true));
		on('mouseleave', () => this.hoverNode(undefined, true));
		on('click', e => {
			const n = this.hit(e);
			if (n) {
				this.cb.onSelect(n.node.id);
			}
		});
		on('dblclick', e => {
			const n = this.hit(e);
			if (n) {
				this.cb.onActivate(n.node.id);
			}
		});
		this.resize();
	}

	setData(
		queryLabel: string,
		nodes: readonly GraphNode[],
		edges: readonly GraphEdge[],
		groups: readonly GraphGroup[],
	): void {
		const now = performance.now();
		if (queryLabel !== this.queryLabel) {
			this.queryLabel = queryLabel;
			this.queryStart = now;
		}
		this.edges = [...edges];
		this.groups = [...groups];
		const targets = this.layout(nodes);
		const next = new Map<string, NodeState>();
		const cx = this.width / 2;
		const cy = this.height / 2;
		for (const n of nodes) {
			const t = targets.get(n.id)!;
			const prev = this.nodes.get(n.id);
			next.set(n.id, {
				node: n,
				x: prev?.x ?? cx,
				y: prev?.y ?? cy,
				fromX: prev?.x ?? cx,
				fromY: prev?.y ?? cy,
				toX: t.x,
				toY: t.y,
				startAt: now + (prev ? 0 : 140 + Math.min(n.rank, 60) * STAGGER_MS),
				alpha: prev?.alpha ?? 0,
				targetAlpha: 1,
				radius: 3.5 + 6.5 * n.relevance,
			});
		}
		for (const [id, s] of this.nodes) {
			if (!next.has(id)) {
				next.set(id, { ...s, fromX: s.x, fromY: s.y, toX: s.x, toY: s.y, startAt: now, targetAlpha: 0 });
			}
		}
		this.nodes = next;
		if (this.cb.reducedMotion) {
			for (const s of this.nodes.values()) {
				s.x = s.toX;
				s.y = s.toY;
				s.alpha = s.targetAlpha;
				s.startAt = 0;
			}
		}
		this.kick();
	}

	setSelected(id: string | undefined): void {
		this.selected = id;
		this.kick();
	}

	/** Highlight from outside (e.g. hovering a table row). */
	setHovered(id: string | undefined): void {
		this.hoverNode(id, false);
	}

	/** Emphasize one group (legend click); undefined clears. */
	setFocusGroup(key: string | undefined): void {
		this.focusGroup = key;
		this.kick();
	}

	dispose(): void {
		cancelAnimationFrame(this.raf);
		this.observer.disconnect();
		for (const f of this.cleanup) {
			f();
		}
	}

	private get geometry() {
		const cx = this.width / 2;
		const cy = this.height / 2;
		const R = Math.max(60, Math.min(this.width, this.height) / 2 - 44);
		return { cx, cy, R, r0: Math.min(70, R * 0.22) };
	}

	/** Slices in group order (sized by count^0.85 so small groups stay visible), then a short overlap relaxation. */
	private layout(nodes: readonly GraphNode[]): Map<string, { x: number; y: number }> {
		const { cx, cy, R, r0 } = this.geometry;
		const counts = new Map<string, number>();
		for (const n of nodes) {
			counts.set(n.group, (counts.get(n.group) ?? 0) + 1);
		}
		const present = this.groups.filter(g => counts.has(g.key));
		const weights = present.map(g => counts.get(g.key)! ** 0.85 + 0.6);
		const total = weights.reduce((a, b) => a + b, 0) || 1;
		this.slices = [];
		let angle = -Math.PI / 2;
		present.forEach((g, i) => {
			const span = (2 * Math.PI * weights[i]!) / total;
			this.slices.push({ group: g, start: angle, end: angle + span });
			angle += span;
		});
		const sliceOf = new Map(this.slices.map(s => [s.group.key, s]));
		const pos = new Map<string, { x: number; y: number; r: number; size: number }>();
		for (const n of nodes) {
			const s = sliceOf.get(n.group);
			const pad = s ? Math.min(0.12, (s.end - s.start) * 0.15) : 0;
			const a = s ? s.start + pad + (s.end - s.start - 2 * pad) * n.order : 0;
			const r = r0 + (1 - n.relevance) * (R - r0);
			pos.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), r, size: 3.5 + 6.5 * n.relevance });
		}
		const pts = [...pos.values()];
		for (let iter = 0; iter < 60; iter++) {
			for (let i = 0; i < pts.length; i++) {
				for (let j = i + 1; j < pts.length; j++) {
					const a = pts[i]!;
					const b = pts[j]!;
					const dx = b.x - a.x;
					const dy = b.y - a.y;
					const d = Math.hypot(dx, dy) || 0.01;
					const min = a.size + b.size + 4;
					if (d < min) {
						const push = (min - d) / 2;
						a.x -= (dx / d) * push;
						a.y -= (dy / d) * push;
						b.x += (dx / d) * push;
						b.y += (dy / d) * push;
					}
				}
			}
			// Pull back towards the relevance ring so distance keeps its meaning.
			for (const p of pts) {
				const d = Math.hypot(p.x - cx, p.y - cy) || 0.01;
				const k = 1 + ((p.r - d) / d) * 0.2;
				p.x = cx + (p.x - cx) * k;
				p.y = cy + (p.y - cy) * k;
			}
		}
		return pos;
	}

	private resize(): void {
		const parent = this.canvas.parentElement;
		const w = parent?.clientWidth ?? this.canvas.clientWidth;
		const h = parent?.clientHeight ?? this.canvas.clientHeight;
		if (!w || !h || (w === this.width && h === this.height)) {
			return;
		}
		const dpr = window.devicePixelRatio || 1;
		this.width = w;
		this.height = h;
		this.canvas.width = Math.round(w * dpr);
		this.canvas.height = Math.round(h * dpr);
		this.canvas.style.width = `${w}px`;
		this.canvas.style.height = `${h}px`;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		const visible = [...this.nodes.values()].filter(s => s.targetAlpha > 0).map(s => s.node);
		const targets = this.layout(visible);
		for (const s of this.nodes.values()) {
			const t = targets.get(s.node.id);
			if (t) {
				s.x = t.x;
				s.fromX = t.x;
				s.toX = t.x;
				s.y = t.y;
				s.fromY = t.y;
				s.toY = t.y;
			}
		}
		this.kick();
	}

	private hoverNode(id: string | undefined, fromCanvas: boolean): void {
		if (id !== this.hovered) {
			this.hovered = id;
			this.canvas.style.cursor = id ? 'pointer' : 'default';
			if (fromCanvas) {
				this.cb.onHover(id);
			}
			this.kick();
		}
	}

	private hit(e: MouseEvent): NodeState | undefined {
		const rect = this.canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;
		let best: NodeState | undefined;
		let bestD = Number.POSITIVE_INFINITY;
		for (const s of this.nodes.values()) {
			if (s.targetAlpha === 0) {
				continue;
			}
			const d = Math.hypot(s.x - x, s.y - y);
			if (d < s.radius + 6 && d < bestD) {
				best = s;
				bestD = d;
			}
		}
		return best;
	}

	private kick(): void {
		if (!this.raf) {
			this.raf = requestAnimationFrame(t => this.frame(t));
		}
	}

	private frame(now: number): void {
		this.raf = 0;
		let animating = false;
		for (const [id, s] of this.nodes) {
			const p = s.startAt ? Math.min(1, Math.max(0, (now - s.startAt) / MOVE_MS)) : 1;
			const e = easeOutBack(p);
			s.x = s.fromX + (s.toX - s.fromX) * e;
			s.y = s.fromY + (s.toY - s.fromY) * e;
			s.alpha = s.targetAlpha === 0 ? Math.max(0, 1 - p) : Math.min(1, p * 1.6);
			if (p < 1) {
				animating = true;
			} else if (s.targetAlpha === 0) {
				this.nodes.delete(id);
			}
		}
		const pulse = this.cb.reducedMotion ? 1 : Math.min(1, (now - this.queryStart) / 900);
		if (pulse < 1) {
			animating = true;
		}
		this.draw(pulse);
		if (animating) {
			this.kick();
		}
	}

	private draw(pulse: number): void {
		const { ctx } = this;
		const style = getComputedStyle(document.body);
		const fg = style.getPropertyValue('--vscode-foreground').trim() || '#ccc';
		const muted = style.getPropertyValue('--vscode-descriptionForeground').trim() || '#888';
		const focus = style.getPropertyValue('--vscode-focusBorder').trim() || '#007fd4';
		const bg = style.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
		const { cx, cy, R } = this.geometry;
		ctx.clearRect(0, 0, this.width, this.height);
		const dimmed = (n: GraphNode) => Boolean(this.focusGroup) && n.group !== this.focusGroup;

		// Slices: a faint wedge per group, so groups read as regions.
		for (const s of this.slices) {
			ctx.globalAlpha = this.focusGroup && this.focusGroup !== s.group.key ? 0.02 : 0.06;
			ctx.fillStyle = s.group.color;
			ctx.beginPath();
			ctx.moveTo(cx, cy);
			ctx.arc(cx, cy, R + 8, s.start, s.end);
			ctx.closePath();
			ctx.fill();
		}

		// Relevance rings.
		ctx.strokeStyle = muted;
		ctx.globalAlpha = 0.14;
		ctx.lineWidth = 1;
		for (const f of [0.33, 0.66, 1]) {
			ctx.beginPath();
			ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
			ctx.stroke();
		}

		if (pulse < 1) {
			ctx.globalAlpha = 0.35 * (1 - pulse);
			ctx.strokeStyle = focus;
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(cx, cy, 8 + pulse * R, 0, Math.PI * 2);
			ctx.stroke();
		}

		// Edges: lit when they touch the hovered/selected node's session.
		const focusSession = this.nodes.get(this.hovered ?? this.selected ?? '')?.node.sessionKey;
		for (const e of this.edges) {
			const a = this.nodes.get(e.from);
			const b = this.nodes.get(e.to);
			if (!a || !b) {
				continue;
			}
			const lit =
				Boolean(focusSession) && (a.node.sessionKey === focusSession || b.node.sessionKey === focusSession);
			let strength = 0.28;
			if (lit) {
				strength = 0.9;
			} else if (dimmed(a.node) || dimmed(b.node)) {
				strength = 0.08;
			}
			ctx.globalAlpha = Math.min(a.alpha, b.alpha) * strength;
			ctx.strokeStyle = lit ? focus : muted;
			ctx.lineWidth = lit ? 1.8 : 1;
			ctx.setLineDash(e.kind === 'fork' ? [4, 4] : []);
			const mx = (a.x + b.x) / 2 + (cy - (a.y + b.y) / 2) * 0.15;
			const my = (a.y + b.y) / 2 - (cx - (a.x + b.x) / 2) * 0.15;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.quadraticCurveTo(mx, my, b.x, b.y);
			ctx.stroke();
		}
		ctx.setLineDash([]);

		// Nodes (worst first so the best sit on top). Hovered/selected get a ring; dimmed groups fade.
		for (const s of [...this.nodes.values()].sort((a, b) => b.node.rank - a.node.rank)) {
			const isSel = s.node.id === this.selected;
			const isHov = s.node.id === this.hovered;
			ctx.globalAlpha = s.alpha * (dimmed(s.node) ? 0.18 : 1);
			ctx.fillStyle = s.node.color;
			ctx.beginPath();
			ctx.arc(s.x, s.y, s.radius * (isHov ? 1.4 : 1), 0, Math.PI * 2);
			ctx.fill();
			if (isSel || isHov) {
				ctx.globalAlpha = s.alpha;
				ctx.strokeStyle = fg;
				ctx.lineWidth = 2;
				ctx.stroke();
			}
		}

		// Group names on the rim, at the middle of each slice.
		ctx.font = '600 11px var(--vscode-font-family, sans-serif)';
		const taken: Box[] = [];
		for (const s of this.slices) {
			const mid = (s.start + s.end) / 2;
			const r = R + 18;
			const x = cx + r * Math.cos(mid);
			const y = cy + r * Math.sin(mid);
			const text = truncate(
				`${s.group.label} (${s.group.count})`,
				Math.max(12, Math.floor(((s.end - s.start) * R) / 6.5)),
			);
			const w = ctx.measureText(text).width;
			// Labels on the left point leftwards, on the right rightwards, and are centred near the top and bottom.
			let left = x - w / 2;
			if (Math.cos(mid) < -0.2) {
				left = x - w;
			} else if (Math.cos(mid) > 0.2) {
				left = x;
			}
			const box = { x: Math.max(2, Math.min(this.width - w - 2, left)), y: y - 8, w, h: 14 };
			if (taken.some(t => overlaps(t, box))) {
				continue;
			}
			taken.push(box);
			ctx.globalAlpha = this.focusGroup && this.focusGroup !== s.group.key ? 0.35 : 1;
			ctx.fillStyle = s.group.color;
			ctx.textAlign = 'left';
			ctx.fillText(text, box.x, y + 4);
		}

		// Query node with its label on a pill.
		ctx.globalAlpha = 1;
		ctx.fillStyle = focus;
		ctx.beginPath();
		ctx.arc(cx, cy, 7, 0, Math.PI * 2);
		ctx.fill();
		ctx.font = '600 12px var(--vscode-font-family, sans-serif)';
		const qText = truncate(this.queryLabel || 'Recent prompts', 40);
		const qw = ctx.measureText(qText).width;
		const qBox = { x: cx - qw / 2 - 6, y: cy + 11, w: qw + 12, h: 18 };
		taken.push(qBox);
		pill(ctx, qBox, bg, focus);
		ctx.fillStyle = fg;
		ctx.textAlign = 'center';
		ctx.fillText(qText, cx, cy + 24);

		// Node labels: hovered/selected always, then the best results while they don't collide.
		ctx.font = '11px var(--vscode-font-family, sans-serif)';
		const visible = [...this.nodes.values()].filter(s => s.targetAlpha > 0 && !dimmed(s.node));
		const strongIds = new Set([this.hovered, this.selected].filter(Boolean));
		const priority = [
			...visible.filter(s => strongIds.has(s.node.id)),
			...visible
				.filter(s => s.node.rank < 8 && !strongIds.has(s.node.id))
				.sort((a, b) => a.node.rank - b.node.rank),
		];
		for (const s of priority) {
			const strong = strongIds.has(s.node.id);
			const text = truncate(s.node.label, strong ? 70 : 30);
			const w = ctx.measureText(text).width;
			const right = s.x >= cx;
			const x = Math.max(4, Math.min(this.width - w - 4, right ? s.x + s.radius + 5 : s.x - s.radius - 5 - w));
			const box = { x: x - 3, y: s.y - 9, w: w + 6, h: 16 };
			if (!strong && taken.some(t => overlaps(t, box))) {
				continue;
			}
			taken.push(box);
			ctx.globalAlpha = s.alpha;
			if (strong) {
				pill(ctx, box, bg, s.node.color);
			}
			ctx.fillStyle = strong ? fg : muted;
			ctx.textAlign = 'left';
			ctx.fillText(text, x, s.y + 4);
		}
		ctx.globalAlpha = 1;
	}
}

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

function overlaps(a: Box, b: Box): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function pill(ctx: CanvasRenderingContext2D, r: Box, fill: string, stroke: string): void {
	ctx.fillStyle = fill;
	ctx.strokeStyle = stroke;
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(r.x, r.y, r.w, r.h, r.h / 2);
	ctx.fill();
	ctx.stroke();
}

function easeOutBack(t: number): number {
	const c1 = 1.4;
	const c3 = c1 + 1;
	return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
