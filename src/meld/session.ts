// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import type {
	EffectItem,
	IdentifiedItem,
	ItemType,
	LayerItem,
	SceneItem,
	Session,
	SessionItem,
	TrackItem,
} from "./types.js";

/**
 * An immutable, read-only view over a Meld session snapshot with typed selectors.
 *
 * This is the single place that understands the shape of `session.items`, so
 * actions and the property-inspector bridge no longer each re-implement lookups
 * against `$MS.meld?.session?.items` (a source of the drift this refactor fixes).
 * Construct a fresh instance per snapshot; it holds no mutable state.
 */
export class MeldSession {
	readonly #session: Session | undefined;

	constructor(session: Session | undefined) {
		this.#session = session;
	}

	/** Whether a session snapshot is present at all. */
	get isPresent(): boolean {
		return this.#session?.items !== undefined;
	}

	/** The raw items map (empty when no snapshot is present). */
	get items(): Record<string, SessionItem> {
		return this.#session?.items ?? {};
	}

	/** Returns `true` when an item with the given id exists in the snapshot. */
	has(id: string | undefined): boolean {
		return !!id && id in this.items;
	}

	/** Returns the item with the given id, paired with its id, or `undefined`. */
	get(id: string | undefined): IdentifiedItem | undefined {
		if (!id) {
			return undefined;
		}
		const item = this.items[id];
		return item ? ({ ...item, id } as IdentifiedItem) : undefined;
	}

	/** Returns the scene with the given id, or `undefined` when absent / wrong type. */
	getScene(id: string | undefined): IdentifiedItem<SceneItem> | undefined {
		return this.#typed(id, "scene");
	}

	/** Returns the track with the given id, or `undefined` when absent / wrong type. */
	getTrack(id: string | undefined): IdentifiedItem<TrackItem> | undefined {
		return this.#typed(id, "track");
	}

	/** Returns the layer with the given id, or `undefined` when absent / wrong type. */
	getLayer(id: string | undefined): IdentifiedItem<LayerItem> | undefined {
		return this.#typed(id, "layer");
	}

	/** Returns the effect with the given id, or `undefined` when absent / wrong type. */
	getEffect(id: string | undefined): IdentifiedItem<EffectItem> | undefined {
		return this.#typed(id, "effect");
	}

	/** All scenes in the snapshot. */
	scenes(): IdentifiedItem<SceneItem>[] {
		return this.byType("scene");
	}

	/** All tracks; optionally restricted to those whose `parent` matches. */
	tracks(parent?: string): IdentifiedItem<TrackItem>[] {
		return this.byType("track", parent);
	}

	/** All layers; optionally restricted to a parent scene. */
	layers(parent?: string): IdentifiedItem<LayerItem>[] {
		return this.byType("layer", parent);
	}

	/** All effects; optionally restricted to a parent layer. */
	effects(parent?: string): IdentifiedItem<EffectItem>[] {
		return this.byType("effect", parent);
	}

	/**
	 * Returns every item of a given type, optionally filtered to a parent id.
	 * Mirrors the property inspector's original `getItemsByType` traversal.
	 * @param type Item kind to collect.
	 * @param parent When provided, only items whose `parent` equals this id.
	 */
	byType<T extends ItemType>(type: T, parent?: string): IdentifiedItem<Extract<SessionItem, { type: T }>>[] {
		const result: IdentifiedItem<Extract<SessionItem, { type: T }>>[] = [];
		for (const [id, item] of Object.entries(this.items)) {
			if (item.type !== type) {
				continue;
			}
			if (parent !== undefined && (item as { parent?: string }).parent !== parent) {
				continue;
			}
			result.push({ ...(item as Extract<SessionItem, { type: T }>), id });
		}
		return result;
	}

	/** Finds the first item matching a predicate, paired with its id. */
	find(predicate: (item: SessionItem, id: string) => boolean): IdentifiedItem | undefined {
		for (const [id, item] of Object.entries(this.items)) {
			if (predicate(item, id)) {
				return { ...item, id } as IdentifiedItem;
			}
		}
		return undefined;
	}

	#typed<T extends ItemType>(
		id: string | undefined,
		type: T,
	): IdentifiedItem<Extract<SessionItem, { type: T }>> | undefined {
		if (!id) {
			return undefined;
		}
		const item = this.items[id];
		if (!item || item.type !== type) {
			return undefined;
		}
		return { ...(item as Extract<SessionItem, { type: T }>), id };
	}
}
