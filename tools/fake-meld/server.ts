// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// A stand-in for Meld Studio's WebChannel server.
//
// It speaks the QWebChannel protocol and registers a `meld` object whose
// properties, methods and signals mirror Meld/Utils/StreamDeckController.qml —
// including the behaviour behind them (showScene switches the current scene,
// toggleMute flips the track and notifies registered observers, setStagedScene
// refuses the current scene, showStagedScene swaps current and staged, and
// registerTrackObserver emits an immediate gainUpdated, as StreamDeckMapper
// does). That fidelity is the point: the plugin cannot tell it apart from Meld,
// so scenarios exercise real code paths.

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import type { FakeLayer, FakeScene, FakeSession, FakeTrack, Scenario } from "./session.ts";

/** QWebChannel message types, mirroring the vendored client. */
const Msg = {
	signal: 1,
	propertyUpdate: 2,
	init: 3,
	idle: 4,
	debug: 5,
	invokeMethod: 6,
	connectToSignal: 7,
	disconnectFromSignal: 8,
	setProperty: 9,
	response: 10,
} as const;

// Qt numbers properties and signals in separate spaces, and a property's notify
// signal has its own index distinct from the property's. Keeping them distinct
// here matters: a client that conflated the two would still work against a mock
// that used one number for both.
const PROP_VERSION = 0;
const PROP_SESSION = 1;
const PROP_STREAMING = 2;
const PROP_RECORDING = 3;

/** Notify-signal indices for the properties above. */
const SIG_VERSION_CHANGED = 10;
const SIG_SESSION_CHANGED = 11;
const SIG_STREAMING_CHANGED = 12;
const SIG_RECORDING_CHANGED = 13;

/** Index of the one pure (non-property-notify) signal, `gainUpdated`. */
const SIG_GAIN_UPDATED = 20;

/** The API version `StreamDeckController.qml` advertises. */
const API_VERSION = 2;

/**
 * Meld's autosave delay (`kSavePrefsDelay`). A session change only reaches the
 * plugin once the snapshot is republished on `sessionSaved`, and that timer is
 * reset by every further edit — so this is the floor on how long a key can wait
 * for confirmation, not an average.
 */
export const MELD_SESSION_DEBOUNCE_MS = 600;

/** Methods exposed on the `meld` object, in StreamDeckController.qml order. */
const METHODS = [
	"setClientName",
	"showScene",
	"toggleMute",
	"setMuted",
	"toggleMonitor",
	"toggleLayer",
	"setProperty",
	"callFunction",
	"callFunctionWithArgs",
	"toggleEffect",
	"toggleRecord",
	"toggleStream",
	"registerTrackObserver",
	"unregisterTrackObserver",
	"setGain",
	"sendCommand",
	"sendEvent",
	"setStagedScene",
	"showStagedScene",
	"sendStreamEvent",
] as const;

/** A method call the server received. */
export type Invocation = { method: string; args: unknown[] };

/** Ways to make the fake misbehave, for testing the plugin's recovery paths. */
export type FakeMeldOptions = {
	/** Serve an init payload with no `meld` object (wrong peer on the port). */
	omitMeldObject?: boolean;
	/** Accept sockets but never answer the init request (wedged app). */
	stallHandshake?: boolean;
	/** Drop the track-observer API, as a build predating it would. */
	omitObserverApi?: boolean;
	/**
	 * Delay every `gainUpdated` by this many milliseconds. Real Meld's echo of a
	 * `setGain` is not instant, and a slow echo is what lets an update for an
	 * older write arrive after a newer one — the timing behind the dial-desync
	 * bug class. Zero (the default) echoes synchronously.
	 */
	echoDelayMs?: number;
	/**
	 * Republish the session snapshot behind a retriggerable debounce of this many
	 * milliseconds. Defaults to {@link MELD_SESSION_DEBOUNCE_MS}, which is what
	 * Meld does: `filteredMap` is only rebuilt on `sessionSaved`, riding an
	 * autosave timer that any further edit resets. Publishing instantly would let
	 * a key that cannot repaint until the snapshot arrives look responsive, and
	 * would hide a press that reasons from the pre-press state. Set 0 only where
	 * the confirmation timing genuinely does not matter to the test.
	 */
	sessionDebounceMs?: number;
	/** Called for every method invocation, for logging. */
	onInvoke?: (invocation: Invocation) => void;
};

/** A fake Meld Studio instance serving one scenario. */
export class FakeMeld {
	readonly invocations: Invocation[] = [];

	#wss?: WebSocketServer;
	readonly #sockets = new Set<ServerSocket>();
	readonly #options: FakeMeldOptions;

	#session: FakeSession;
	#gains: Record<string, number>;
	#effectOrder: Record<string, string[]>;
	#streaming: boolean;
	#recording: boolean;
	/** trackId → the contexts observing it, mirroring StreamDeckMapper. */
	readonly #observers = new Map<string, Set<string>>();

	/** Cumulative accepted sockets, including ones since closed. */
	#accepted = 0;

	/** In-flight delayed `gainUpdated` timers, cancelled on close. */
	readonly #pendingEchoes = new Set<ReturnType<typeof setTimeout>>();

	/** The pending debounced session republish, if any. */
	#sessionTimer?: ReturnType<typeof setTimeout>;

	/** Test-set override of the republish delay. */
	#debounceOverride?: number;

	/** Signal indices each client subscribed to via `connectToSignal`. */
	readonly #subscriptions = new WeakMap<ServerSocket, Set<number>>();

	/** Clients that have acknowledged the last property update. */
	readonly #idle = new WeakSet<ServerSocket>();

	/** Property updates withheld until a client goes idle again. */
	readonly #withheld = new WeakMap<ServerSocket, unknown[]>();

	constructor(scenario: Scenario, options: FakeMeldOptions = {}) {
		this.#session = structuredClone(scenario.session);
		this.#gains = { ...scenario.gains };
		this.#effectOrder = structuredClone(scenario.effectOrder);
		this.#streaming = scenario.isStreaming;
		this.#recording = scenario.isRecording;
		this.#options = options;
	}

	/** The live session snapshot. */
	get session(): FakeSession {
		return this.#session;
	}

	/** Number of currently connected clients. */
	get clientCount(): number {
		return this.#sockets.size;
	}

	/**
	 * Total sockets accepted since construction. A peer that never answers the
	 * handshake only proves the client gave up and retried if this climbs past
	 * one, so tests assert on it rather than on the absence of readiness.
	 */
	get acceptedConnections(): number {
		return this.#accepted;
	}

	/**
	 * Starts listening.
	 * @param port Port to bind; 0 picks an ephemeral one.
	 * @returns The bound port.
	 */
	listen(port: number): Promise<number> {
		return new Promise((resolve, reject) => {
			const wss = new WebSocketServer({ host: "127.0.0.1", port });
			this.#wss = wss;
			wss.on("error", reject);
			wss.on("listening", () => {
				const address = wss.address();
				resolve(typeof address === "object" && address ? address.port : port);
			});
			wss.on("connection", (socket) => {
				this.#accepted++;
				this.#sockets.add(socket);
				this.#subscriptions.set(socket, new Set());
				socket.on("close", () => this.#sockets.delete(socket));
				socket.on("message", (raw) => this.#onMessage(socket, String(raw)));
			});
		});
	}

	/** Drops every client and stops listening, as an abrupt Meld exit would. */
	async close(): Promise<void> {
		for (const timer of this.#pendingEchoes) {
			clearTimeout(timer);
		}
		this.#pendingEchoes.clear();
		if (this.#sessionTimer) {
			clearTimeout(this.#sessionTimer);
			this.#sessionTimer = undefined;
		}
		for (const socket of this.#sockets) {
			socket.terminate();
		}
		this.#sockets.clear();
		this.#observers.clear();
		const wss = this.#wss;
		this.#wss = undefined;
		if (wss) {
			await new Promise<void>((resolve) => wss.close(() => resolve()));
		}
	}

	/** Swaps in a different scenario and notifies clients, as a project switch does. */
	loadScenario(scenario: Scenario): void {
		this.#session = structuredClone(scenario.session);
		this.#gains = { ...scenario.gains };
		this.#effectOrder = structuredClone(scenario.effectOrder);
		this.#streaming = scenario.isStreaming;
		this.#recording = scenario.isRecording;
		this.#observers.clear();
		this.#publishSession();
		this.#publish(PROP_STREAMING, SIG_STREAMING_CHANGED, this.#streaming);
		this.#publish(PROP_RECORDING, SIG_RECORDING_CHANGED, this.#recording);
	}

	/**
	 * Overrides the session republish delay for the rest of the run.
	 * @param delayMs Milliseconds, or `undefined` to restore the configured value.
	 */
	setSessionDebounce(delayMs: number | undefined): void {
		this.#debounceOverride = delayMs;
	}

	/** Every invocation of a given method, in order. */
	callsTo(method: string): Invocation[] {
		return this.invocations.filter((call) => call.method === method);
	}

	/** The current gain for a track, as the mapper would report it. */
	gainOf(trackId: string): number | undefined {
		return this.#gains[trackId];
	}

	/** Sets `isStreaming` and notifies clients. */
	setStreaming(streaming: boolean): void {
		this.#streaming = streaming;
		this.#publish(PROP_STREAMING, SIG_STREAMING_CHANGED, streaming);
	}

	/** Sets `isRecording` and notifies clients. */
	setRecording(recording: boolean): void {
		this.#recording = recording;
		this.#publish(PROP_RECORDING, SIG_RECORDING_CHANGED, recording);
	}

	/** Applies a gain change from Meld's side (a user moving the fader in-app). */
	setGain(trackId: string, gain: number): void {
		const track = this.#trackOrNull(trackId);
		if (!track) {
			return;
		}
		this.#gains[trackId] = Math.min(1, Math.max(0, gain));
		this.#emitGain(trackId);
	}

	/**
	 * Emits `gainUpdated` without touching the session snapshot.
	 *
	 * This models the real timing rather than a shortcut: Meld's mapper emits
	 * `gainUpdated` the moment a track's gain or mute changes, while the session
	 * snapshot is republished behind a debounced save. So the fast path genuinely
	 * does arrive ahead of a snapshot that still reports the old value, and the
	 * plugin has to prefer it.
	 * @param trackId Track the update concerns.
	 * @param gain Gain to report.
	 * @param muted Mute state to report.
	 */
	emitGainOnly(trackId: string, gain: number, muted: boolean): void {
		this.#gains[trackId] = gain;
		this.#broadcast({
			type: Msg.signal,
			object: "meld",
			signal: SIG_GAIN_UPDATED,
			args: [trackId, gain, muted],
		}, SIG_GAIN_UPDATED);
	}

	/** Mutes or unmutes a track from Meld's side. */
	setMuted(trackId: string, muted: boolean): void {
		const track = this.#trackOrNull(trackId);
		if (!track) {
			return;
		}
		track.muted = muted;
		this.#emitGain(trackId);
		this.#publishSession();
	}

	/** Makes a scene current, mirroring `showScene`. */
	showScene(sceneId: string): void {
		const target = this.#sceneOrNull(sceneId);
		if (!target) {
			return;
		}
		for (const item of Object.values(this.#session.items)) {
			if (item.type === "scene") {
				item.current = false;
			}
		}
		target.current = true;
		this.#publishSession();
	}

	#onMessage(socket: ServerSocket, raw: string): void {
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(raw);
		} catch {
			return;
		}

		switch (message.type) {
			case Msg.init:
				if (this.#options.stallHandshake) {
					return;
				}
				this.#send(socket, { type: Msg.response, id: message.id, data: this.#initPayload() });
				return;
			case Msg.invokeMethod: {
				const invocation: Invocation = {
					method: String(message.method),
					args: (message.args as unknown[]) ?? [],
				};
				this.invocations.push(invocation);
				this.#options.onInvoke?.(invocation);
				const result = this.#invoke(invocation.method, invocation.args);
				// Qt always answers an invocation; void methods carry a null result.
				this.#send(socket, { type: Msg.response, id: message.id, data: result ?? null });
				return;
			}
			case Msg.setProperty:
				// The plugin never writes properties directly, but honour it anyway.
				return;
			case Msg.connectToSignal:
				// Qt only forwards a pure signal to clients that asked for it, so a
				// client that never subscribes must receive nothing.
				this.#subscriptions.get(socket)?.add(Number(message.signal));
				return;
			case Msg.disconnectFromSignal:
				this.#subscriptions.get(socket)?.delete(Number(message.signal));
				return;
			case Msg.idle:
				// Qt withholds property updates until the client says it is idle, and
				// each batch un-arms the flag again. Modelling it means a client that
				// stopped acknowledging would visibly stop receiving updates.
				this.#idle.add(socket);
				this.#flush(socket);
				return;
			case Msg.debug:
				return;
			default:
				return;
		}
	}

	/** Executes a method with the same semantics as StreamDeckController.qml. */
	#invoke(method: string, args: unknown[]): unknown {
		const [first, second, third] = args as [string, string | boolean | number, string];
		switch (method) {
			case "showScene":
				this.showScene(first);
				return null;
			case "setStagedScene": {
				// The QML resolves this one through Session.scenes only — unlike
				// showScene, which also searches verticalScenesModel — so staging a
				// vertical scene silently does nothing. It also refuses to stage the
				// scene that is already current.
				const scene = this.#sceneOrNull(first);
				if (!scene || scene.vertical || scene.current) {
					return null;
				}
				for (const item of Object.values(this.#session.items)) {
					if (item.type === "scene") {
						item.staged = false;
					}
				}
				scene.staged = true;
				this.#publishSession();
				return null;
			}
			case "showStagedScene": {
				// The QML swaps unconditionally: currentScene = stagedScene and
				// stagedScene = the old current. With nothing staged that means the
				// session is left with no current scene, which is exactly the state a
				// dial that staged something Meld refused can reach — so the fake must
				// reproduce it rather than quietly declining.
				const scenes = Object.values(this.#session.items).filter((i): i is FakeScene => i.type === "scene");
				const current = scenes.find((s) => s.current);
				const staged = scenes.find((s) => s.staged);
				if (current) {
					current.current = false;
					current.staged = true;
				}
				if (staged) {
					staged.staged = false;
					staged.current = true;
				}
				this.#publishSession();
				return null;
			}
			case "toggleMute": {
				const track = this.#trackOrNull(first);
				if (track) {
					this.setMuted(first, !track.muted);
				}
				return null;
			}
			case "setMuted":
				this.setMuted(first, Boolean(second));
				return null;
			case "toggleMonitor": {
				const track = this.#trackOrNull(first);
				if (track) {
					track.monitoring = !track.monitoring;
					this.#publishSession();
				}
				return null;
			}
			case "setGain":
				this.setGain(first, Number(second));
				return null;
			case "setProperty": {
				const item = this.#session.items[first];
				if (item) {
					// Mirrors the QML's special case routing `muted` through the matrix model.
					(item as unknown as Record<string, unknown>)[String(second)] = third;
					if (item.type === "track" && second === "muted") {
						this.#emitGain(first);
					}
					this.#publishSession();
				}
				return null;
			}
			case "toggleLayer": {
				// The QML resolves the layer *within the scene it was given*
				// (`scene.layers.findById`), so a mismatched pair is a no-op. Honouring
				// the layer id alone would let a caller that sends a stale scene look
				// correct here and fail against Meld.
				const layer = this.#layerIn(first, second as string);
				if (layer) {
					layer.visible = !layer.visible;
					layer.isEffectivelyVisible = layer.visible;
					this.#publishSession();
				}
				return null;
			}
			case "toggleEffect": {
				// Same chain rule as toggleLayer, one level deeper: the effect must be
				// found within the layer named by the arguments.
				const layer = this.#layerIn(first, second as string);
				if (!layer) {
					return null;
				}
				const direct = this.#session.items[third];
				let effect = direct?.type === "effect" && direct.parent === (second as string) ? direct : undefined;
				if (!effect) {
					// Meld's fallback for ids saved before effects were addressable:
					// exactly two dash-separated parts, the second used as an index into
					// `layer.effects` — the model order the user sees, NOT the order the
					// snapshot happens to serialize in. The prefix is ignored entirely.
					const parts = String(third).split("-");
					if (parts.length !== 2) {
						return null;
					}
					const index = Number.parseInt(parts[1], 10);
					const order = this.#effectOrder[second as string] ?? [];
					if (!Number.isInteger(index) || index < 0 || index >= order.length) {
						return null;
					}
					const resolved = this.#session.items[order[index]];
					effect = resolved?.type === "effect" ? resolved : undefined;
				}
				if (effect?.type === "effect") {
					effect.enabled = !effect.enabled;
					this.#publishSession();
				}
				return null;
			}
			case "toggleRecord":
				this.setRecording(!this.#recording);
				return null;
			case "toggleStream":
				this.setStreaming(!this.#streaming);
				return null;
			case "registerTrackObserver": {
				// StreamDeckMapper::registerTrack ignores unknown ids, and always
				// emits an immediate gainUpdated for a known one.
				if (!this.#trackOrNull(second as string)) {
					return null;
				}
				const contexts = this.#observers.get(second as string) ?? new Set<string>();
				contexts.add(first);
				this.#observers.set(second as string, contexts);
				this.#emitGain(second as string);
				return null;
			}
			case "unregisterTrackObserver": {
				const contexts = this.#observers.get(second as string);
				contexts?.delete(first);
				if (contexts && contexts.size === 0) {
					this.#observers.delete(second as string);
				}
				return null;
			}
			case "callFunction":
			case "callFunctionWithArgs": {
				// The QML resolves the object and invokes the named member. For a media
				// layer, play/pause move `isPlaying`, which is published in the layer
				// map and arms the autosave — so a media press really does come back
				// through the snapshot, and the fake has to echo it too.
				const layer = this.#session.items[first];
				if (layer?.type !== "layer" || layer.mediaSource === undefined) {
					return null;
				}
				const member = String(second);
				if (member === "play") {
					layer.isPlaying = true;
				} else if (member === "pause") {
					layer.isPlaying = false;
				} else if (member !== "seekTo" && member !== "skipBack") {
					return null;
				}
				this.#publishSession();
				return null;
			}
			default:
				// setClientName, sendCommand, sendEvent, sendStreamEvent: recorded, no
				// observable session effect.
				return null;
		}
	}

	/**
	 * Resolves a layer only when it really belongs to the given scene, mirroring
	 * the QML's `getSceneById(sceneId)` then `scene.layers.findById(layerId)`.
	 * Note the scene lookup accepts vertical scenes: `getSceneById` searches both
	 * models, unlike `setStagedScene`.
	 * @param sceneId Scene the caller claims the layer is in.
	 * @param layerId Layer to resolve.
	 */
	#layerIn(sceneId: string, layerId: string): FakeLayer | undefined {
		if (!this.#sceneOrNull(sceneId)) {
			return undefined;
		}
		const layer = this.#session.items[layerId];
		return layer?.type === "layer" && layer.parent === sceneId ? layer : undefined;
	}

	#trackOrNull(id: string): FakeTrack | undefined {
		const item = this.#session.items[id];
		return item?.type === "track" ? item : undefined;
	}

	#sceneOrNull(id: string): FakeScene | undefined {
		const item = this.#session.items[id];
		return item?.type === "scene" ? item : undefined;
	}

	/** Emits `gainUpdated`, but only for tracks with a registered observer. */
	#emitGain(trackId: string): void {
		if (!this.#observers.has(trackId)) {
			return;
		}
		const track = this.#trackOrNull(trackId);
		// Capture the values now: with a delay, later writes must not rewrite the
		// payload of an update that was already on its way.
		const frame = {
			type: Msg.signal,
			object: "meld",
			signal: SIG_GAIN_UPDATED,
			args: [trackId, this.#gains[trackId] ?? 0, track?.muted ?? false],
		};
		const delay = this.#options.echoDelayMs ?? 0;
		if (delay <= 0) {
			this.#broadcast(frame, SIG_GAIN_UPDATED);
			return;
		}
		const timer = setTimeout(() => {
			this.#pendingEchoes.delete(timer);
			this.#broadcast(frame, SIG_GAIN_UPDATED);
		}, delay);
		this.#pendingEchoes.add(timer);
	}

	/**
	 * Republishes the session, honouring the configured debounce. The timer is
	 * retriggerable, exactly as Meld's autosave is: a burst of edits produces one
	 * snapshot, delayed until the burst stops.
	 */
	#publishSession(): void {
		const delay = this.#debounceOverride ?? this.#options.sessionDebounceMs ?? MELD_SESSION_DEBOUNCE_MS;
		if (delay <= 0) {
			this.#publish(PROP_SESSION, SIG_SESSION_CHANGED, this.#session);
			return;
		}
		if (this.#sessionTimer) {
			clearTimeout(this.#sessionTimer);
		}
		this.#sessionTimer = setTimeout(() => {
			this.#sessionTimer = undefined;
			this.#publish(PROP_SESSION, SIG_SESSION_CHANGED, this.#session);
		}, delay);
	}

	/**
	 * Sends a property update the way Qt does: the new value keyed by property
	 * index, and the notify signal keyed by its own separate signal index.
	 * @param property Property index.
	 * @param notifySignal Index of that property's notify signal.
	 * @param value New value.
	 */
	#publish(property: number, notifySignal: number, value: unknown): void {
		this.#broadcast({
			type: Msg.propertyUpdate,
			data: [{ object: "meld", signals: { [notifySignal]: [] }, properties: { [property]: value } }],
		});
	}

	#initPayload(): Record<string, unknown> {
		const classInfo = this.#meldClassInfo();
		return this.#options.omitMeldObject ? { other: classInfo } : { meld: classInfo };
	}

	#meldClassInfo(): Record<string, unknown> {
		const methods = METHODS.filter(
			(name) =>
				!this.#options.omitObserverApi ||
				(name !== "registerTrackObserver" && name !== "unregisterTrackObserver"),
		).map((name, index) => [name, index]);

		return {
			methods,
			// `gainUpdated` is a pure signal; the property notify signals are declared
			// inline with their properties below.
			signals: this.#options.omitObserverApi ? [] : [["gainUpdated", SIG_GAIN_UPDATED]],
			// [index, name, notifySignalData, initialValue]; a leading 1 tells the
			// client to reconstruct the signal name as `<property>Changed`.
			properties: [
				[PROP_VERSION, "version", [1, SIG_VERSION_CHANGED], API_VERSION],
				[PROP_SESSION, "session", [1, SIG_SESSION_CHANGED], this.#session],
				[PROP_STREAMING, "isStreaming", [1, SIG_STREAMING_CHANGED], this.#streaming],
				[PROP_RECORDING, "isRecording", [1, SIG_RECORDING_CHANGED], this.#recording],
			],
			enums: {},
		};
	}

	#send(socket: ServerSocket, message: unknown): void {
		if (socket.readyState === socket.OPEN) {
			socket.send(JSON.stringify(message));
		}
	}

	/**
	 * Sends a property update, or withholds it until the client is idle again.
	 * @param socket The client.
	 * @param message The property-update frame.
	 */
	#sendPropertyUpdate(socket: ServerSocket, message: unknown): void {
		if (!this.#idle.has(socket)) {
			const queue = this.#withheld.get(socket) ?? [];
			queue.push(message);
			this.#withheld.set(socket, queue);
			return;
		}
		this.#idle.delete(socket);
		this.#send(socket, message);
	}

	/**
	 * Delivers whatever was withheld while a client was busy.
	 *
	 * Qt merges rather than drops: `sendPendingPropertyUpdates` folds every
	 * pending change for an object into one frame carrying all changed properties
	 * and all their notify signals. Sending only the newest would lose state the
	 * client never sees again — a streaming flag stuck false, say — and would
	 * never produce the multi-property frame the client has to decode.
	 * @param socket The client to flush to.
	 */
	#flush(socket: ServerSocket): void {
		const queue = this.#withheld.get(socket);
		if (!queue?.length) {
			return;
		}
		const properties: Record<number, unknown> = {};
		const signals: Record<number, unknown[]> = {};
		for (const frame of queue) {
			for (const entry of (frame as { data: { properties: Record<number, unknown>; signals: Record<number, unknown[]> }[] })
				.data) {
				Object.assign(properties, entry.properties);
				Object.assign(signals, entry.signals);
			}
		}
		queue.length = 0;
		this.#idle.delete(socket);
		this.#send(socket, { type: Msg.propertyUpdate, data: [{ object: "meld", signals, properties }] });
	}

	/**
	 * Broadcasts a frame, honouring Qt's delivery rules: property updates wait for
	 * an idle client, and a pure signal only reaches clients that subscribed.
	 * @param message The frame to send.
	 * @param signal When set, the signal index the client must have subscribed to.
	 */
	#broadcast(message: unknown, signal?: number): void {
		const isPropertyUpdate = (message as { type?: number }).type === Msg.propertyUpdate;
		for (const socket of this.#sockets) {
			if (signal !== undefined && !this.#subscriptions.get(socket)?.has(signal)) {
				continue;
			}
			if (isPropertyUpdate) {
				this.#sendPropertyUpdate(socket, message);
			} else {
				this.#send(socket, message);
			}
		}
	}
}
