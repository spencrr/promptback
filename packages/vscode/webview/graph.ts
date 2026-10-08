/**
 * "Constellation" view of a query's results, drawn on a canvas.
 * - The query sits at the centre; each result is a node whose distance from the centre is 1 − relevance.
 * - Results are grouped into angular sectors by repository (colour = repository).
 * - Edges: consecutive prompts of the same session (solid) and fork → parent sessions (dashed).
 * - Changing the query animates: kept nodes glide to new positions, new ones ripple out in rank order, old ones fade.
 * Honors reduced motion by skipping straight to the final frame.
 */

export interface GraphNode {
	readonly id: string;
	readonly label: string;
	readonly group: string;
	readonly sessionKey: string;
	readonly seq: number;
	/** 0..1, 1 = most relevant. */
	readonly relevance: number;
	readonly rank: number;
}

export interface GraphEdge {
	readonly from: string;
	readonly to: string;
	readonly kind: 'session' | 'fork';
}

interface NodeState {
	node: GraphNode;
	x: number; y: number;
	fromX: number; fromY: number;
	toX: number; toY: number;
	startAt: number;
	alpha: number;
	targetAlpha: number;
	radius: number;
	color: string;
}

const MOVE_MS = 520;
const STAGGER_MS = 22;
const PALETTE_VARS = ['--vscode-charts-blue', '--vscode-charts-orange', '--vscode-charts-green', '--vscode-charts-purple', '--vscode-charts-red', '--vscode-charts-yellow'];
const FALLBACK = ['#4fc1ff', '#d18616', '#89d185', '#b180d7', '#f14c4c', '#cca700'];

export class ConstellationGraph {
	private readonly ctx: CanvasRenderingContext2D;
	private nodes = new Map<string, NodeState>();
	private edges: GraphEdge[] = [];
	private queryLabel = '';
	private queryStart = 0;
	private hovered: string | undefined;
	private selected: string | undefined;
	private raf = 0;
	private width = 0;
	private height = 0;
	private colors = new Map<string, string>();
	private readonly observer: ResizeObserver;
	private readonly cleanup: (() => void)[] = [];

	constructor(
		private readonly canvas: HTMLCanvasElement,
		private readonly opts: { reducedMotion: boolean; onSelect: (id: string) => void; onActivate: (id: string) => void },
	) {
		this.ctx = canvas.getContext('2d')!;
		this.observer = new ResizeObserver(() => this.resize());
		this.observer.observe(canvas.parentElement ?? canvas);
		const move = (e: MouseEvent) => this.setHovered(this.hit(e)?.node.id);
		const leave = () => this.setHovered(undefined);
		const click = (e: MouseEvent) => {
			const n = this.hit(e);
			if (n) {
				this.opts.onSelect(n.node.id);
			}
		};
		const dbl = (e: MouseEvent) => {
			const n = this.hit(e);
			if (n) {
				this.opts.onActivate(n.node.id);
			}
		};
		canvas.addEventListener('mousemove', move);
		canvas.addEventListener('mouseleave', leave);
		canvas.addEventListener('click', click);
		canvas.addEventListener('dblclick', dbl);
		this.cleanup.push(() => {
			canvas.removeEventListener('mousemove', move);
			canvas.removeEventListener('mouseleave', leave);
			canvas.removeEventListener('click', click);
			canvas.removeEventListener('dblclick', dbl);
		});
		this.resize();
	}

	/** Colour assigned to a group (stable across queries). */
	colorFor(group: string): string {
		let c = this.colors.get(group);
		if (!c) {
			const i = this.colors.size % PALETTE_VARS.length;
			const css = getComputedStyle(document.body).getPropertyValue(PALETTE_VARS[i]!).trim();
			c = css || FALLBACK[i]!;
			this.colors.set(group, c);
		}
		return c;
	}

	setData(queryLabel: string, nodes: readonly GraphNode[], edges: readonly GraphEdge[]): void {
		const now = performance.now();
		const changedQuery = queryLabel !== this.queryLabel;
		this.queryLabel = queryLabel;
		if (changedQuery) {
			this.queryStart = now;
		}
		this.edges = [...edges];
		const targets = this.layout(nodes);
		const next = new Map<string, NodeState>();
		const cx = this.width / 2, cy = this.height / 2;
		for (const n of nodes) {
			const t = targets.get(n.id)!;
			const prev = this.nodes.get(n.id);
			const delay = prev ? 0 : 140 + Math.min(n.rank, 60) * STAGGER_MS;
			next.set(n.id, {
				node: n,
				x: prev?.x ?? cx, y: prev?.y ?? cy,
				fromX: prev?.x ?? cx, fromY: prev?.y ?? cy,
				toX: t.x, toY: t.y,
				startAt: now + delay,
				alpha: prev?.alpha ?? 0,
				targetAlpha: 1,
				radius: 3.5 + 6.5 * n.relevance,
				color: this.colorFor(n.group),
			});
		}
		// Fade out nodes that left the result set.
		for (const [id, s] of this.nodes) {
			if (!next.has(id)) {
				next.set(id, { ...s, fromX: s.x, fromY: s.y, toX: s.x, toY: s.y, startAt: now, targetAlpha: 0 });
			}
		}
		this.nodes = next;
		if (this.opts.reducedMotion) {
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

	dispose(): void {
		cancelAnimationFrame(this.raf);
		this.observer.disconnect();
		this.cleanup.forEach(f => f());
	}

	/** Sector per group (ordered by best rank), radius by relevance, then a few rounds of overlap relaxation. */
	private layout(nodes: readonly GraphNode[]): Map<string, { x: number; y: number }> {
		const cx = this.width / 2, cy = this.height / 2;
		const R = Math.max(60, Math.min(this.width, this.height) / 2 - 36);
		const r0 = Math.min(70, R * 0.22);
		const groups = new Map<string, GraphNode[]>();
		for (const n of nodes) {
			(groups.get(n.group) ?? groups.set(n.group, []).get(n.group)!).push(n);
		}
		const ordered = [...groups.values()].sort((a, b) => a[0]!.rank - b[0]!.rank);
		const weights = ordered.map(g => Math.pow(g.length, 0.85) + 0.6);
		const total = weights.reduce((a, b) => a + b, 0);
		const pos = new Map<string, { x: number; y: number; r: number; size: number }>();
		let angle = -Math.PI / 2;
		ordered.forEach((g, gi) => {
			const span = (2 * Math.PI * weights[gi]!) / total;
			const pad = Math.min(0.12, span * 0.15);
			g.forEach((n, i) => {
				const a = angle + pad + ((span - 2 * pad) * (i + 0.5)) / g.length;
				const r = r0 + (1 - n.relevance) * (R - r0);
				pos.set(n.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), r, size: 3.5 + 6.5 * n.relevance });
			});
			angle += span;
		});
		// Relax overlaps (size-aware), then pull each node back towards its relevance ring so distance keeps its meaning.
		const pts = [...pos.values()];
		for (let iter = 0; iter < 80; iter++) {
			for (let i = 0; i < pts.length; i++) {
				for (let j = i + 1; j < pts.length; j++) {
					const a = pts[i]!, b = pts[j]!;
					const dx = b.x - a.x, dy = b.y - a.y;
					const d = Math.hypot(dx, dy) || 0.01;
					const min = a.size + b.size + 5;
					if (d < min) {
						const push = (min - d) / 2;
						a.x -= (dx / d) * push;
						a.y -= (dy / d) * push;
						b.x += (dx / d) * push;
						b.y += (dy / d) * push;
					}
				}
			}
			for (const p of pts) {
				const d = Math.hypot(p.x - cx, p.y - cy) || 0.01;
				const k = 1 + ((p.r - d) / d) * 0.15;
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
		// Re-target existing nodes for the new size without replaying the ripple.
		const nodes = [...this.nodes.values()].filter(s => s.targetAlpha > 0).map(s => s.node);
		const targets = this.layout(nodes);
		for (const s of this.nodes.values()) {
			const t = targets.get(s.node.id);
			if (t) {
				s.x = s.fromX = s.toX = t.x;
				s.y = s.fromY = s.toY = t.y;
			}
		}
		this.kick();
	}

	private setHovered(id: string | undefined): void {
		if (id !== this.hovered) {
			this.hovered = id;
			this.canvas.style.cursor = id ? 'pointer' : 'default';
			this.kick();
		}
	}

	private hit(e: MouseEvent): NodeState | undefined {
		const rect = this.canvas.getBoundingClientRect();
		const x = e.clientX - rect.left, y = e.clientY - rect.top;
		let best: NodeState | undefined;
		let bestD = Infinity;
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
		const pulse = this.opts.reducedMotion ? 1 : Math.min(1, (now - this.queryStart) / 900);
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
		const cx = this.width / 2, cy = this.height / 2;
		ctx.clearRect(0, 0, this.width, this.height);

		// Relevance rings.
		const R = Math.max(60, Math.min(this.width, this.height) / 2 - 36);
		ctx.strokeStyle = muted;
		ctx.globalAlpha = 0.12;
		ctx.lineWidth = 1;
		for (const f of [0.33, 0.66, 1]) {
			ctx.beginPath();
			ctx.arc(cx, cy, R * f, 0, Math.PI * 2);
			ctx.stroke();
		}

		// Query pulse.
		if (pulse < 1) {
			ctx.globalAlpha = 0.35 * (1 - pulse);
			ctx.strokeStyle = focus;
			ctx.lineWidth = 2;
			ctx.beginPath();
			ctx.arc(cx, cy, 8 + pulse * R, 0, Math.PI * 2);
			ctx.stroke();
		}

		// Edges.
		const focusSession = this.nodes.get(this.hovered ?? this.selected ?? '')?.node.sessionKey;
		for (const e of this.edges) {
			const a = this.nodes.get(e.from), b = this.nodes.get(e.to);
			if (!a || !b) {
				continue;
			}
			const lit = !!focusSession && (a.node.sessionKey === focusSession || b.node.sessionKey === focusSession);
			ctx.globalAlpha = Math.min(a.alpha, b.alpha) * (lit ? 0.85 : 0.25);
			ctx.strokeStyle = lit ? focus : muted;
			ctx.lineWidth = lit ? 1.6 : 1;
			ctx.setLineDash(e.kind === 'fork' ? [4, 4] : []);
			const mx = (a.x + b.x) / 2 + (cy - (a.y + b.y) / 2) * 0.15;
			const my = (a.y + b.y) / 2 - (cx - (a.x + b.x) / 2) * 0.15;
			ctx.beginPath();
			ctx.moveTo(a.x, a.y);
			ctx.quadraticCurveTo(mx, my, b.x, b.y);
			ctx.stroke();
		}
		ctx.setLineDash([]);

		// Spokes from the query to the top results.
		for (const s of this.nodes.values()) {
			if (s.node.rank < 5 && s.targetAlpha > 0) {
				ctx.globalAlpha = s.alpha * 0.18;
				ctx.strokeStyle = s.color;
				ctx.beginPath();
				ctx.moveTo(cx, cy);
				ctx.lineTo(s.x, s.y);
				ctx.stroke();
			}
		}

		// Nodes.
		for (const s of [...this.nodes.values()].sort((a, b) => b.node.rank - a.node.rank)) {
			const isSel = s.node.id === this.selected, isHov = s.node.id === this.hovered;
			ctx.globalAlpha = s.alpha;
			ctx.fillStyle = s.color;
			ctx.beginPath();
			ctx.arc(s.x, s.y, s.radius * (isHov ? 1.35 : 1), 0, Math.PI * 2);
			ctx.fill();
			if (isSel || isHov) {
				ctx.strokeStyle = fg;
				ctx.lineWidth = 2;
				ctx.stroke();
			}
		}

		// Query node with its label on a pill below it.
		const bg = style.getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e';
		ctx.globalAlpha = 1;
		ctx.fillStyle = focus;
		ctx.beginPath();
		ctx.arc(cx, cy, 7, 0, Math.PI * 2);
		ctx.fill();
		ctx.font = '600 12px var(--vscode-font-family, sans-serif)';
		const qText = truncate(this.queryLabel || 'Recent prompts', 40);
		const qw = ctx.measureText(qText).width;
		const taken: { x: number; y: number; w: number; h: number }[] = [{ x: cx - qw / 2 - 6, y: cy + 11, w: qw + 12, h: 18 }];
		pill(ctx, taken[0]!, bg, focus);
		ctx.fillStyle = fg;
		ctx.textAlign = 'center';
		ctx.fillText(qText, cx, cy + 24);

		// Labels: hovered/selected first (always), then the top results while they don't collide.
		ctx.font = '11px var(--vscode-font-family, sans-serif)';
		const visible = [...this.nodes.values()].filter(s => s.targetAlpha > 0);
		const priority = [
			...visible.filter(s => s.node.id === this.hovered || s.node.id === this.selected),
			...visible.filter(s => s.node.rank < 8 && s.node.id !== this.hovered && s.node.id !== this.selected).sort((a, b) => a.node.rank - b.node.rank),
		];
		for (const s of priority) {
			const strong = s.node.id === this.hovered || s.node.id === this.selected;
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
				pill(ctx, box, bg, s.color);
			}
			ctx.fillStyle = strong ? fg : muted;
			ctx.textAlign = 'left';
			ctx.fillText(text, x, s.y + 4);
		}
		ctx.globalAlpha = 1;
	}
}

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function pill(ctx: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, fill: string, stroke: string): void {
	ctx.fillStyle = fill;
	ctx.strokeStyle = stroke;
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.roundRect(r.x, r.y, r.w, r.h, r.h / 2);
	ctx.fill();
	ctx.stroke();
}

function easeOutBack(t: number): number {
	const c1 = 1.4, c3 = c1 + 1;
	return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
