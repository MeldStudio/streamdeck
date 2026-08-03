// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Typed model of the Meld Studio WebChannel session, derived from WebChannelAPI.md.
// The wire format keys every item by a 32-char hex id inside `session.items`.

/** Discriminator for the four session item kinds. */
export type ItemType = "scene" | "track" | "layer" | "effect";

/** A scene the user can switch to / stage. */
export type SceneItem = {
	type: "scene";
	index: number;
	name: string;
	current: boolean;
	staged: boolean;
};

/** An audio track. `parent` (when present) references the owning layer/scene. */
export type TrackItem = {
	type: "track";
	name: string;
	parent?: string;
	monitoring: boolean;
	muted: boolean;
	/** Present on some builds via gain updates; not guaranteed in the session snapshot. */
	gain?: number;
};

/** A layer within a scene. Media layers additionally expose `mediaSource`/`isPlaying`. */
export type LayerItem = {
	type: "layer";
	parent: string;
	index: number;
	name: string;
	visible: boolean;
	height?: number;
	width?: number;
	x?: number;
	y?: number;
	rotation?: number;
	source?: string;
	url?: string;
	mediaSource?: string;
	isPlaying?: boolean;
};

/** An effect applied to a layer. */
export type EffectItem = {
	type: "effect";
	parent: string;
	name: string;
	enabled: boolean;
};

/** Union of every item kind stored in `session.items`. */
export type SessionItem = SceneItem | TrackItem | LayerItem | EffectItem;

/** The raw `session` object delivered by the WebChannel. */
export type Session = {
	items: Record<string, SessionItem>;
};

/** An item paired with its id, as returned by the {@link MeldSession} selectors. */
export type IdentifiedItem<T extends SessionItem = SessionItem> = T & { id: string };

/**
 * The raw `meld` QWebChannel object. Only the members the plugin uses are typed;
 * see WebChannelAPI.md for the authoritative contract.
 */
export type MeldObject = {
	version?: number;
	session?: Session;
	isStreaming?: boolean;
	isRecording?: boolean;

	// Signals (Qt slots exposed as `{ connect, disconnect }`).
	sessionChanged: MeldSignal<[]>;
	isStreamingChanged: MeldSignal<[]>;
	isRecordingChanged: MeldSignal<[]>;
	/** Part of the optional track-observer feature; absent on builds without it. */
	gainUpdated?: MeldSignal<[trackId: string, gain: number, muted: boolean]>;

	// Methods.
	showScene(sceneId: string): void;
	setStagedScene(sceneId: string): void;
	showStagedScene(): void;
	toggleMute(trackId: string): void;
	toggleMonitor(trackId: string): void;
	toggleLayer(sceneId: string, layerId: string): void;
	toggleEffect(sceneId: string, layerId: string, effectId: string): void;
	toggleRecord(): void;
	toggleStream(): void;
	setGain(trackId: string, gain: number): void;
	setMuted?(trackId: string, muted: boolean): void;
	setProperty?(objectId: string, propertyName: string, value: unknown): void;
	registerTrackObserver?(context: string, trackId: string): void;
	unregisterTrackObserver?(context: string, trackId: string): void;
	callFunction?(layerId: string, command: string): void;
	callFunctionWithArgs?(layerId: string, command: string, args: unknown[]): void;
	sendCommand?(command: string): void;
	sendStreamEvent?(type: string, data?: unknown): void;
	sendEvent?(event: string): void;
};

/** A Qt signal surfaced by QWebChannel. */
export type MeldSignal<Args extends unknown[]> = {
	connect(callback: (...args: Args) => void): void;
	disconnect(callback: (...args: Args) => void): void;
};
