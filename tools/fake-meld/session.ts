// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Builders for the session snapshot Meld Studio publishes over the WebChannel.
//
// The shapes here mirror Meld/StreamDeckMapper.cpp exactly — `sceneToMap`,
// `layerToMap`, `effectsToMap` and `audioTrackToMap` — so a scenario built with
// these helpers is indistinguishable from a real `mapper.filteredMap`. Note in
// particular that a track carries NO `gain` field: gain reaches the plugin only
// through the `gainUpdated` signal.

/** The wire snapshot: `{ items: { <id>: item } }`, as `map["items"]` produces. */
export type FakeSession = { items: Record<string, FakeItem> };

/** Any item that can appear in the snapshot. */
export type FakeItem = FakeScene | FakeLayer | FakeEffect | FakeTrack;

/** Mirrors `sceneToMap`. */
export type FakeScene = {
	type: "scene";
	name: string;
	current: boolean;
	staged: boolean;
	vertical: boolean;
	index: number;
};

/** Mirrors `layerToMap`. Optional fields appear only when the source object has them. */
export type FakeLayer = {
	type: "layer";
	name: string;
	parent: string;
	index: number;
	visible: boolean;
	isEffectivelyVisible: boolean;
	x: number;
	y: number;
	width: number;
	height: number;
	rotation: number;
	isPlaying?: boolean;
	mediaSource?: string;
	source?: string;
	url?: string;
	text?: string;
};

/** Mirrors `effectsToMap`. */
export type FakeEffect = {
	type: "effect";
	name: string;
	parent: string;
	enabled: boolean;
};

/** Mirrors `audioTrackToMap`; `parent` is present only for scene-owned tracks. */
export type FakeTrack = {
	type: "track";
	name: string;
	muted: boolean;
	monitoring: boolean;
	parent?: string;
};

/** Gain lives outside the snapshot, exactly as it does in Meld. */
export type TrackGain = { gain: number };

/**
 * A complete scenario: the snapshot plus the out-of-band state Meld keeps
 * separately (per-track gain, and the streaming/recording flags).
 */
export type Scenario = {
	name: string;
	description: string;
	session: FakeSession;
	gains: Record<string, number>;
	isStreaming: boolean;
	isRecording: boolean;
	/**
	 * Each layer's effects in Meld's own model order — the order the user sees,
	 * and the one a legacy `<layerId>-<index>` id indexes into. It is deliberately
	 * separate from the snapshot, which Qt serializes sorted by id, so the two
	 * orders can disagree here exactly as they do in production.
	 */
	effectOrder: Record<string, string[]>;
};

/**
 * Generates a deterministic 32-char uppercase hex id, the format Meld uses.
 * Deterministic so scenarios are reproducible between runs — but distinct per
 * `seed`, so "a different Meld instance" really does mean all-new ids.
 * @param seed Any string; the same seed always yields the same id.
 */
export function itemId(seed: string): string {
	// FNV-1a, expanded to 128 bits by hashing four salted variants.
	const block = (salt: string): string => {
		let hash = 0x811c9dc5;
		for (const char of `${salt}:${seed}`) {
			hash ^= char.codePointAt(0) as number;
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16).padStart(8, "0");
	};
	return `${block("a")}${block("b")}${block("c")}${block("d")}`.toUpperCase();
}

/**
 * The id form the pre-migration inspector stored for an effect. Upgraded
 * profiles still carry it, and Meld still accepts it as a `toggleEffect`
 * argument, but it never appears as a key in the session snapshot.
 * @param layerId Owning layer id.
 * @param index The effect's position within that layer.
 */
export function legacyEffectId(layerId: string, index: number): string {
	return `${layerId}-${index}`;
}

/** Fluent builder that assembles a scenario's snapshot in Meld's own shape. */
export class SessionBuilder {
	readonly #items: Record<string, FakeItem> = {};
	readonly #gains: Record<string, number> = {};
	readonly #effectOrder: Record<string, string[]> = {};
	readonly #namespace: string;
	// Meld walks the horizontal and vertical scene models in separate loops, each
	// numbering from 0, so a vertical twin can share an index with a horizontal
	// scene. Two counters reproduce that rather than inventing unique indices.
	#sceneIndex = 0;
	#verticalSceneIndex = 0;

	/**
	 * @param namespace Salts every generated id. Two builders with different
	 * namespaces never produce the same id even for identically-named items,
	 * which is what makes one scenario a genuinely different Meld instance from
	 * another rather than the same project reopened.
	 */
	constructor(namespace: string) {
		this.#namespace = namespace;
	}

	/** Namespaced id for an item, so scenarios cannot collide. */
	#id(seed: string): string {
		return itemId(`${this.#namespace}/${seed}`);
	}

	/**
	 * Adds a scene.
	 * @param name Display name; vertical scenes get Meld's " [Vertical]" suffix.
	 * @param options `current`/`staged` flags and whether it is a vertical scene.
	 */
	scene(name: string, options: { current?: boolean; staged?: boolean; vertical?: boolean } = {}): string {
		const id = this.#id(`scene:${name}:${options.vertical ? "v" : "h"}`);
		this.#items[id] = {
			type: "scene",
			name: options.vertical ? `${name} [Vertical]` : name,
			current: options.current ?? false,
			staged: options.staged ?? false,
			vertical: options.vertical ?? false,
			index: options.vertical ? this.#verticalSceneIndex++ : this.#sceneIndex++,
		};
		return id;
	}

	/**
	 * Adds a layer to a scene.
	 * @param parent Owning scene id.
	 * @param name Layer name (Meld prefixes ancestors with "/" for nested layers).
	 * @param options Visibility, ordering, and any media/source extras.
	 */
	layer(
		parent: string,
		name: string,
		options: {
			visible?: boolean;
			index?: number;
			mediaSource?: string;
			isPlaying?: boolean;
			source?: string;
			url?: string;
			text?: string;
		} = {},
	): string {
		const id = this.#id(`layer:${parent}:${name}`);
		const visible = options.visible ?? true;
		const layer: FakeLayer = {
			type: "layer",
			name,
			parent,
			index: options.index ?? Object.values(this.#items).filter((i) => i.type === "layer").length,
			visible,
			isEffectivelyVisible: visible,
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
			rotation: 0,
		};
		// Meld only emits these keys when the underlying object exposes them.
		if (options.mediaSource !== undefined) {
			layer.mediaSource = options.mediaSource;
			layer.isPlaying = options.isPlaying ?? false;
		}
		if (options.source !== undefined) {
			layer.source = options.source;
		}
		if (options.url !== undefined) {
			layer.url = options.url;
		}
		if (options.text !== undefined) {
			layer.text = options.text;
		}
		this.#items[id] = layer;
		return id;
	}

	/**
	 * Adds an effect to a layer.
	 *
	 * Effects are always keyed by a real id, because that is all Meld publishes:
	 * `effectsToMap` uses `effect->idString()`. The historical
	 * `<layerId>-<index>` form exists only in old Stream Deck settings, which is
	 * why Meld accepts it as a `toggleEffect` argument — see {@link legacyEffectId}.
	 * @param parent Owning layer id.
	 * @param name Effect display name.
	 * @param options `enabled` state.
	 */
	effect(parent: string, name: string, options: { enabled?: boolean } = {}): string {
		const id = this.#id(`effect:${parent}:${name}`);
		this.#items[id] = { type: "effect", name, parent, enabled: options.enabled ?? true };
		// Creation order is the model order Meld indexes legacy ids against.
		(this.#effectOrder[parent] ??= []).push(id);
		return id;
	}

	/**
	 * Adds an audio track.
	 * @param name Track name (the replay clip's track is named "Replay Clip").
	 * @param options Mute/monitor state, owning layer, and starting gain.
	 */
	track(name: string, options: { muted?: boolean; monitoring?: boolean; parent?: string; gain?: number } = {}): string {
		const id = this.#id(`track:${name}`);
		const track: FakeTrack = {
			type: "track",
			name,
			muted: options.muted ?? false,
			monitoring: options.monitoring ?? false,
		};
		if (options.parent !== undefined) {
			track.parent = options.parent;
		}
		this.#items[id] = track;
		// Gain is deliberately kept out of the snapshot, matching Meld.
		this.#gains[id] = options.gain ?? 1;
		return id;
	}

	/** Produces the finished scenario. */
	build(name: string, description: string, flags: { streaming?: boolean; recording?: boolean } = {}): Scenario {
		// Meld builds `items` as a QVariantMap, which Qt serializes with the keys in
		// lexicographic order of the item id — so the wire order is unrelated to
		// creation order, and types are interleaved. Anything that walks
		// `Object.keys(items)` sees that order in production, so the fake must serve
		// it too; insertion order would flatter code that depends on grouping.
		const sorted: Record<string, FakeItem> = {};
		for (const id of Object.keys(this.#items).sort()) {
			sorted[id] = this.#items[id];
		}
		return {
			name,
			description,
			session: { items: structuredClone(sorted) },
			gains: { ...this.#gains },
			isStreaming: flags.streaming ?? false,
			isRecording: flags.recording ?? false,
			effectOrder: structuredClone(this.#effectOrder),
		};
	}
}
