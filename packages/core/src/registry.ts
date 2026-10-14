import type * as z from 'zod/v4';

/** Anything a {@link Registry} can hold: identified by a stable, unique id. */
export interface Plugin {
	readonly id: string;
}

/**
 * A plugin with validated options. `options` is a zod schema; it supplies defaults and produces readable errors, so
 * every pluggable concept (embedding providers, prompt sources, models) is configured the same way.
 */
export interface ConfigurablePlugin<O> extends Plugin {
	readonly options: z.ZodType<O>;
}

/** Thrown when an id is unknown or registered twice. */
export class RegistryError extends Error {
	override readonly name = 'RegistryError';
}

/** Thrown when a plugin's options fail validation. The message names the plugin and the offending paths. */
export class PluginOptionsError extends Error {
	override readonly name = 'PluginOptionsError';

	constructor(
		readonly kind: string,
		readonly pluginId: string,
		readonly issues: readonly z.core.$ZodIssue[],
	) {
		super(
			`Invalid options for ${kind} '${pluginId}': ${issues
				.map(i => `${i.path.length ? i.path.map(String).join('.') : '<root>'}: ${i.message}`)
				.join('; ')}`,
		);
	}
}

/**
 * Keyed collection of plugins. Lookups by id replace `switch (kind)` chains: a new implementation registers itself and
 * nothing else changes. Built-ins are registered by the module that defines the registry; callers may register more
 * before opening an engine.
 */
export class Registry<P extends Plugin> {
	private readonly plugins = new Map<string, P>();

	constructor(
		/** Human-readable noun for error messages, e.g. `embedding provider`. */
		readonly kind: string,
		plugins: Iterable<P> = [],
	) {
		for (const p of plugins) {
			this.register(p);
		}
	}

	register(plugin: P): this {
		if (this.plugins.has(plugin.id)) {
			throw new RegistryError(`A ${this.kind} with id '${plugin.id}' is already registered`);
		}
		this.plugins.set(plugin.id, plugin);
		return this;
	}

	has(id: string): boolean {
		return this.plugins.has(id);
	}

	get(id: string): P | undefined {
		return this.plugins.get(id);
	}

	/** Like {@link get} but throws a {@link RegistryError} naming the known ids. */
	require(id: string): P {
		const p = this.plugins.get(id);
		if (!p) {
			throw new RegistryError(`Unknown ${this.kind} '${id}'. Known: ${this.ids().join(', ')}`);
		}
		return p;
	}

	ids(): string[] {
		return [...this.plugins.keys()];
	}

	list(): P[] {
		return [...this.plugins.values()];
	}
}

/** Validates `raw` against the plugin's schema; throws {@link PluginOptionsError} with every issue. */
export function parseOptions<O>(kind: string, plugin: ConfigurablePlugin<O>, raw: unknown): O {
	const r = plugin.options.safeParse(raw ?? {});
	if (!r.success) {
		throw new PluginOptionsError(kind, plugin.id, r.error.issues);
	}
	return r.data;
}
