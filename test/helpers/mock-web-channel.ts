// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { mock, type Mock } from "node:test";

import type {
	OpenWebChannel,
	WebChannelCallbacks,
	WebChannelHandle,
} from "../../src/meld/connection.ts";
import type { MeldObject, MeldSignal } from "../../src/meld/types.ts";
import type { FakeLayer, FakeScene, FakeSession, FakeTrack, Scenario } from "./session-builder.ts";

/** Meld's retriggerable session-save delay. */
export const MELD_SESSION_DEBOUNCE_MS = 600;

export type MockWebChannelOptions = {
	omitMeldObject?: boolean;
	stallHandshake?: boolean;
	omitObserverApi?: boolean;
	echoDelayMs?: number;
	sessionDebounceMs?: number;
};

type RequiredMethod<K extends keyof MeldObject> = NonNullable<MeldObject[K]> extends (...args: infer A) => infer R
	? (...args: A) => R
	: never;

/** Direct mocks for every Meld method used by the plugin. */
export type MockMeldMethods = {
	[K in
		| "setClientName"
		| "showScene"
		| "setStagedScene"
		| "showStagedScene"
		| "toggleMute"
		| "toggleMonitor"
		| "toggleLayer"
		| "toggleEffect"
		| "toggleRecord"
		| "toggleStream"
		| "setGain"
		| "setMuted"
		| "setProperty"
		| "registerTrackObserver"
		| "unregisterTrackObserver"
		| "callFunction"
		| "callFunctionWithArgs"
		| "sendCommand"
		| "sendStreamEvent"
		| "sendEvent"]: Mock<RequiredMethod<K>>;
};

class MockSignal<Args extends unknown[]> implements MeldSignal<Args> {
	readonly #listeners = new Set<(...args: Args) => void>();

	connect(callback: (...args: Args) => void): void {
		this.#listeners.add(callback);
	}

	disconnect(callback: (...args: Args) => void): void {
		this.#listeners.delete(callback);
	}

	emit(...args: Args): void {
		for (const callback of [...this.#listeners]) callback(...args);
	}
}

type Endpoint = { server?: MockWebChannel };
const endpoints = new Map<number, Endpoint>();
let nextPort = 45_000;

class MockAttempt implements WebChannelHandle {
	readonly #callbacks: WebChannelCallbacks;
	server?: MockWebChannel;
	#closed = false;
	#notifyClosed = false;

	constructor(callbacks: WebChannelCallbacks, server?: MockWebChannel) {
		this.#callbacks = callbacks;
		if (server) {
			this.server = server;
			server.accept(this);
		} else {
			// A refused WebSocket cannot become connected merely because Meld starts
			// later. It errors, closes, and a later reconnect creates a new attempt.
			queueMicrotask(() => {
				if (this.#closed) return;
				this.#callbacks.error();
				this.drop();
			});
		}
	}

	ready(meld: MeldObject | undefined): void {
		queueMicrotask(() => {
			if (!this.#closed && this.server) this.#callbacks.ready(meld);
		});
	}

	drop(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#notifyClosed = true;
		this.server?.detach(this);
		this.server = undefined;
		queueMicrotask(() => {
			if (!this.#notifyClosed) return;
			this.#notifyClosed = false;
			this.#callbacks.closed();
		});
	}

	/** Caller teardown is intentionally silent, matching the production adapter. */
	close(): void {
		// Match the browser adapter: caller teardown detaches a remote close that is
		// already queued but has not yet been delivered.
		this.#notifyClosed = false;
		if (this.#closed) return;
		this.#closed = true;
		this.server?.detach(this);
		this.server = undefined;
	}
}

/** Result-level opener injected into MeldConnection; no Qt frame is modelled. */
export const openMockWebChannel: OpenWebChannel = (url, callbacks) => {
	const endpoint = endpoints.get(Number(new URL(url).port));
	return new MockAttempt(callbacks, endpoint?.server);
};

/**
 * A controllable Meld result object plus a WebSocket-like lifecycle.
 *
 * Public methods are `node:test` mocks. Private state is deliberately separate
 * from `meld.session`: callers see a new snapshot only when sessionChanged is
 * published, just as they do across the real serialized WebChannel boundary.
 */
export class MockWebChannel {
	readonly methods: MockMeldMethods;
	readonly #options: MockWebChannelOptions;
	readonly #attempts = new Set<MockAttempt>();
	readonly #observers = new Map<string, Set<string>>();
	readonly #pendingEchoes = new Set<ReturnType<typeof setTimeout>>();
	readonly #sessionChanged = new MockSignal<[]>();
	readonly #streamingChanged = new MockSignal<[]>();
	readonly #recordingChanged = new MockSignal<[]>();
	readonly #gainUpdated = new MockSignal<[string, number, boolean]>();

	#state: FakeSession;
	#gains: Record<string, number>;
	#streaming: boolean;
	#recording: boolean;
	#accepted = 0;
	#port?: number;
	#sessionTimer?: ReturnType<typeof setTimeout>;
	#debounceOverride?: number;
	readonly #meld: MeldObject;

	constructor(scenario: Scenario, options: MockWebChannelOptions = {}) {
		this.#state = structuredClone(scenario.session);
		this.#gains = { ...scenario.gains };
		this.#streaming = scenario.isStreaming;
		this.#recording = scenario.isRecording;
		this.#options = options;

		this.methods = {
			setClientName: mock.fn((_name: string) => {}),
			showScene: mock.fn((sceneId: string) => this.showScene(sceneId)),
			setStagedScene: mock.fn((sceneId: string) => this.#setStagedScene(sceneId)),
			showStagedScene: mock.fn(() => this.#showStagedScene()),
			toggleMute: mock.fn((trackId: string) => this.#toggleMute(trackId)),
			toggleMonitor: mock.fn((trackId: string) => this.#toggleMonitor(trackId)),
			toggleLayer: mock.fn((sceneId: string, layerId: string) => this.#toggleLayer(sceneId, layerId)),
			toggleEffect: mock.fn((sceneId: string, layerId: string, effectId: string) =>
				this.#toggleEffect(sceneId, layerId, effectId)),
			toggleRecord: mock.fn(() => this.setRecording(!this.#recording)),
			toggleStream: mock.fn(() => this.setStreaming(!this.#streaming)),
			setGain: mock.fn((trackId: string, gain: number) => this.setGain(trackId, gain)),
			setMuted: mock.fn((trackId: string, muted: boolean) => this.setMuted(trackId, muted)),
			setProperty: mock.fn((objectId: string, propertyName: string, value: unknown) =>
				this.#setProperty(objectId, propertyName, value)),
			registerTrackObserver: mock.fn((context: string, trackId: string) =>
				this.#registerTrackObserver(context, trackId)),
			unregisterTrackObserver: mock.fn((context: string, trackId: string) =>
				this.#unregisterTrackObserver(context, trackId)),
			callFunction: mock.fn((layerId: string, command: string) => this.#callFunction(layerId, command)),
			callFunctionWithArgs: mock.fn((layerId: string, command: string, _args: unknown[]) =>
				this.#callFunction(layerId, command)),
			sendCommand: mock.fn((_command: string) => {}),
			sendStreamEvent: mock.fn((_type: string, _data?: unknown) => {}),
			sendEvent: mock.fn((_event: string) => {}),
		};

		this.#meld = {
			version: 3,
			session: structuredClone(this.#state),
			isStreaming: this.#streaming,
			isRecording: this.#recording,
			sessionChanged: this.#sessionChanged,
			isStreamingChanged: this.#streamingChanged,
			isRecordingChanged: this.#recordingChanged,
			gainUpdated: options.omitObserverApi ? undefined : this.#gainUpdated,
			...this.methods,
		};
		if (options.omitObserverApi) {
			this.#meld.registerTrackObserver = undefined;
			this.#meld.unregisterTrackObserver = undefined;
		}
	}

	get meld(): MeldObject {
		return this.#meld;
	}

	/** Internal Meld state, useful for asserting the eventual command result. */
	get session(): FakeSession {
		return structuredClone(this.#state);
	}

	get clientCount(): number {
		return this.#attempts.size;
	}

	get acceptedConnections(): number {
		return this.#accepted;
	}

	get callCount(): number {
		return Object.values(this.methods).reduce((sum, method) => sum + method.mock.callCount(), 0);
	}

	resetCalls(): void {
		for (const method of Object.values(this.methods)) method.mock.resetCalls();
	}

	async listen(port: number): Promise<number> {
		const selected = port === 0 ? nextPort++ : port;
		const endpoint = endpoints.get(selected);
		if (endpoint?.server && endpoint.server !== this) {
			throw new Error(`mock WebChannel port ${selected} is already in use`);
		}
		if (this.#port !== undefined && this.#port !== selected) {
			throw new Error("a mock WebChannel instance cannot move between ports");
		}
		this.#port = selected;
		endpoints.set(selected, { server: this });
		return selected;
	}

	async close(): Promise<void> {
		for (const timer of this.#pendingEchoes) clearTimeout(timer);
		this.#pendingEchoes.clear();
		if (this.#sessionTimer) clearTimeout(this.#sessionTimer);
		this.#sessionTimer = undefined;
		this.#observers.clear();
		if (this.#port !== undefined && endpoints.get(this.#port)?.server === this) endpoints.delete(this.#port);
		for (const attempt of [...this.#attempts]) attempt.drop();
		this.#port = undefined;
	}

	accept(attempt: MockAttempt): void {
		this.#accepted++;
		this.#attempts.add(attempt);
		if (!this.#options.stallHandshake) attempt.ready(this.#options.omitMeldObject ? undefined : this.#meld);
	}

	detach(attempt: MockAttempt): void {
		this.#attempts.delete(attempt);
	}

	loadScenario(scenario: Scenario): void {
		this.#state = structuredClone(scenario.session);
		this.#gains = { ...scenario.gains };
		this.#streaming = scenario.isStreaming;
		this.#recording = scenario.isRecording;
		this.#observers.clear();
		this.#publishSession();
		this.#meld.isStreaming = this.#streaming;
		this.#meld.isRecording = this.#recording;
		this.#streamingChanged.emit();
		this.#recordingChanged.emit();
	}

	setSessionDebounce(delayMs: number | undefined): void {
		this.#debounceOverride = delayMs;
	}

	gainOf(trackId: string): number | undefined {
		return this.#gains[trackId];
	}

	setStreaming(streaming: boolean): void {
		this.#streaming = streaming;
		this.#meld.isStreaming = streaming;
		this.#streamingChanged.emit();
	}

	setRecording(recording: boolean): void {
		this.#recording = recording;
		this.#meld.isRecording = recording;
		this.#recordingChanged.emit();
	}

	setGain(trackId: string, gain: number): void {
		if (!this.#track(trackId)) return;
		this.#gains[trackId] = Math.min(1, Math.max(0, gain));
		this.#emitGain(trackId);
	}

	emitGainOnly(trackId: string, gain: number, muted: boolean): void {
		this.#gains[trackId] = gain;
		this.#gainUpdated.emit(trackId, gain, muted);
	}

	setMuted(trackId: string, muted: boolean): void {
		const track = this.#track(trackId);
		if (!track) return;
		track.muted = muted;
		this.#emitGain(trackId);
		this.#publishSession();
	}

	showScene(sceneId: string): void {
		const target = this.#scene(sceneId);
		if (!target) return;
		for (const item of Object.values(this.#state.items)) if (item.type === "scene") item.current = false;
		target.current = true;
		this.#publishSession();
	}

	#setStagedScene(sceneId: string): void {
		const scene = this.#scene(sceneId);
		if (!scene || scene.vertical || scene.current) return;
		for (const item of Object.values(this.#state.items)) if (item.type === "scene") item.staged = false;
		scene.staged = true;
		this.#publishSessionNow();
	}

	#showStagedScene(): void {
		const scenes = Object.values(this.#state.items).filter((item): item is FakeScene => item.type === "scene");
		const current = scenes.find((scene) => scene.current);
		const staged = scenes.find((scene) => scene.staged);
		if (current) { current.current = false; current.staged = true; }
		if (staged) { staged.staged = false; staged.current = true; }
		this.#publishSessionNow();
	}

	#toggleMute(trackId: string): void {
		const track = this.#track(trackId);
		if (track) this.setMuted(trackId, !track.muted);
	}

	#toggleMonitor(trackId: string): void {
		const track = this.#track(trackId);
		if (!track) return;
		track.monitoring = !track.monitoring;
		this.#publishSession();
	}

	#toggleLayer(sceneId: string, layerId: string): void {
		const layer = this.#layerIn(sceneId, layerId);
		if (!layer) return;
		layer.visible = !layer.visible;
		layer.isEffectivelyVisible = layer.visible;
		this.#publishSession();
	}

	#toggleEffect(sceneId: string, layerId: string, effectId: string): void {
		if (!this.#layerIn(sceneId, layerId)) return;
		const direct = this.#state.items[effectId];
		const effect = direct?.type === "effect" && direct.parent === layerId ? direct : undefined;
		if (!effect) return;
		effect.enabled = !effect.enabled;
		this.#publishSession();
	}

	#setProperty(objectId: string, propertyName: string, value: unknown): void {
		const item = this.#state.items[objectId];
		if (!item) return;
		(item as unknown as Record<string, unknown>)[propertyName] = value;
		if (item.type === "track" && propertyName === "muted") this.#emitGain(objectId);
		this.#publishSession();
	}

	#registerTrackObserver(context: string, trackId: string): void {
		if (!this.#track(trackId)) return;
		const contexts = this.#observers.get(trackId) ?? new Set<string>();
		contexts.add(context);
		this.#observers.set(trackId, contexts);
		this.#emitGain(trackId);
	}

	#unregisterTrackObserver(context: string, trackId: string): void {
		const contexts = this.#observers.get(trackId);
		contexts?.delete(context);
		if (contexts?.size === 0) this.#observers.delete(trackId);
	}

	#callFunction(layerId: string, command: string): void {
		const layer = this.#state.items[layerId];
		if (layer?.type !== "layer" || layer.mediaSource === undefined) return;
		if (command === "play") layer.isPlaying = true;
		else if (command === "pause") layer.isPlaying = false;
		else if (command !== "seekTo" && command !== "skipBack") return;
		this.#publishSession();
	}

	#layerIn(sceneId: string, layerId: string): FakeLayer | undefined {
		const layer = this.#state.items[layerId];
		return this.#scene(sceneId) && layer?.type === "layer" && layer.parent === sceneId ? layer : undefined;
	}

	#track(id: string): FakeTrack | undefined {
		const item = this.#state.items[id];
		return item?.type === "track" ? item : undefined;
	}

	#scene(id: string): FakeScene | undefined {
		const item = this.#state.items[id];
		return item?.type === "scene" ? item : undefined;
	}

	#emitGain(trackId: string): void {
		if (!this.#observers.has(trackId)) return;
		const gain = this.#gains[trackId] ?? 0;
		const muted = this.#track(trackId)?.muted ?? false;
		const delay = this.#options.echoDelayMs ?? 0;
		if (delay <= 0) return this.#gainUpdated.emit(trackId, gain, muted);
		const timer = setTimeout(() => {
			this.#pendingEchoes.delete(timer);
			this.#gainUpdated.emit(trackId, gain, muted);
		}, delay);
		this.#pendingEchoes.add(timer);
	}

	#publishSessionNow(): void {
		if (this.#sessionTimer) clearTimeout(this.#sessionTimer);
		this.#sessionTimer = undefined;
		this.#meld.session = structuredClone(this.#state);
		this.#sessionChanged.emit();
	}

	#publishSession(): void {
		const delay = this.#debounceOverride ?? this.#options.sessionDebounceMs ?? MELD_SESSION_DEBOUNCE_MS;
		if (delay <= 0) return this.#publishSessionNow();
		if (this.#sessionTimer) clearTimeout(this.#sessionTimer);
		this.#sessionTimer = setTimeout(() => {
			this.#sessionTimer = undefined;
			this.#meld.session = structuredClone(this.#state);
			this.#sessionChanged.emit();
		}, delay);
	}
}
