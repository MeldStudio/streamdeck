// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import streamDeck from "@elgato/streamdeck";

import { type MeldEventMap, TypedEmitter } from "./events.js";
import { QWebChannel as QWebChannelImpl } from "./qwebchannel.js";
import type { MeldObject, Session } from "./types.js";

/** Constructable view of the vendored (untyped) QWebChannel client. */
type QWebChannelConstructor = new (
	transport: WebSocket,
	initCallback: (channel: { objects: Record<string, MeldObject> }) => void,
	converters?: unknown,
) => unknown;

const QWebChannel = QWebChannelImpl as unknown as QWebChannelConstructor;

/** Callbacks produced by one WebChannel connection attempt. */
export type WebChannelCallbacks = {
	ready(meld: MeldObject | undefined): void;
	closed(): void;
	error(): void;
};

/** A live WebChannel attempt. Closing it must not call {@link WebChannelCallbacks.closed}. */
export type WebChannelHandle = {
	close(): void;
};

/**
 * Opens a WebChannel and reports its public `meld` object once initialized.
 *
 * Keeping this seam at the initialized-object boundary lets functional tests
 * supply exactly the API documented by WebChannelAPI.md without reproducing
 * Qt's private wire protocol.
 */
export type OpenWebChannel = (url: string, callbacks: WebChannelCallbacks) => WebChannelHandle;

/** Builds the small adapter from a WebSocket transport to the result-level seam. */
export function createWebChannelOpener(
	createSocket: (url: string) => WebSocket,
	initialize: (socket: WebSocket, ready: (meld: MeldObject | undefined) => void) => void,
): OpenWebChannel {
	return (url, callbacks) => {
		const socket = createSocket(url);
		socket.onopen = (): void => initialize(socket, callbacks.ready);
		socket.onclose = callbacks.closed;
		socket.onerror = callbacks.error;
		return {
			close(): void {
				// A caller-initiated close is teardown, not a second remote-close event.
				socket.onopen = null;
				socket.onclose = null;
				socket.onerror = null;
				socket.onmessage = null;
				try {
					socket.close();
				} catch {
					// ignore
				}
			},
		};
	};
}

/** Production adapter from WebSocket/QWebChannel to the result-level seam. */
const openWebChannel = createWebChannelOpener(
	(url) => new WebSocket(url),
	(socket, ready) => {
		// eslint-disable-next-line no-new -- QWebChannel wires itself onto the transport.
		new QWebChannel(socket, (channel) => ready(channel.objects.meld));
	},
);

/** Where Meld Studio's WebChannel server listens. */
const MELD_ADDRESS = "127.0.0.1";
const MELD_PORT = 13376;

/** Overrides for {@link MeldConnection}; only tests pass anything but the defaults. */
export type MeldConnectionOptions = {
	address?: string;
	port?: number;
	/** Shortened by tests so the handshake watchdog can be exercised quickly. */
	handshakeTimeoutMs?: number;
	/** Shortened by tests so reconnect cycles do not dominate the run time. */
	reconnectMinMs?: number;
	/** Result-level WebChannel adapter; functional tests inject a mock here. */
	openWebChannel?: OpenWebChannel;
};

/** Reconnect backoff bounds (milliseconds). */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 10_000;

/**
 * How long a connection attempt may run without becoming ready before it is
 * abandoned and retried. Without this bound, a peer that accepts the socket but
 * never answers the init request (a wedged Meld, or a different app squatting
 * on the port) would leave the plugin permanently not-ready with no reconnect —
 * `onclose` never fires on a socket nobody closes.
 */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Owns the single WebSocket + QWebChannel connection to Meld Studio.
 *
 * This is the one place that talks to Meld. It centralizes the behaviour that
 * used to be scattered across every action and every property inspector:
 *
 *  - a single socket, reconnected automatically with backoff;
 *  - all Qt signals wired once per connection and surfaced as typed events;
 *  - a registry of active track observers that is transparently re-registered
 *    after a reconnect, so actions never have to re-wire themselves.
 */
export class MeldConnection {
	readonly #emitter = new TypedEmitter<MeldEventMap>((event, err) =>
		streamDeck.logger.error(`Listener for "${event}" threw`, err),
	);

	/** Active track observers, keyed by the owning context id → trackId. */
	readonly #observers = new Map<string, string>();

	/**
	 * Contexts whose registration Meld is currently known to hold.
	 *
	 * Meld drops every track observer whenever it tears down its audio tracks —
	 * restoring or reopening a session does that without closing the socket, and
	 * track ids are persisted, so the same ids come back. Nothing in the snapshot
	 * distinguishes that from an ordinary edit, so this is cleared on every
	 * session change and the next register call is allowed through.
	 */
	readonly #registered = new Set<string>();

	/** The Meld WebChannel endpoint this connection targets. */
	readonly #url: string;

	/** How long a connection attempt may run before it is abandoned and retried. */
	readonly #handshakeTimeoutMs: number;

	/** Starting reconnect delay, grown on each consecutive failure. */
	readonly #reconnectMinMs: number;

	/** Opens the production WebChannel, or a result-level test double. */
	readonly #openWebChannel: OpenWebChannel;

	constructor({
		address = MELD_ADDRESS,
		port = MELD_PORT,
		handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
		reconnectMinMs = RECONNECT_MIN_MS,
		openWebChannel: openChannel = openWebChannel,
	}: MeldConnectionOptions = {}) {
		this.#url = `ws://${address}:${port}`;
		this.#handshakeTimeoutMs = handshakeTimeoutMs;
		this.#reconnectMinMs = reconnectMinMs;
		this.#openWebChannel = openChannel;
		this.#reconnectDelay = reconnectMinMs;
	}

	#channel?: WebChannelHandle;
	#meld?: MeldObject;
	#ready = false;
	#reconnectDelay = RECONNECT_MIN_MS;
	#reconnectTimer?: ReturnType<typeof setTimeout>;
	#handshakeTimer?: ReturnType<typeof setTimeout>;
	#generation = 0;
	#disposed = false;
	#disposeDepth = 0;

	/** The live `meld` object, or `undefined` when disconnected. */
	get meld(): MeldObject | undefined {
		return this.#meld;
	}

	/** Whether the QWebChannel handshake has completed and `meld` is usable. */
	get ready(): boolean {
		return this.#ready;
	}

	/** The latest authoritative session snapshot, or `undefined` when disconnected. */
	get session(): Session | undefined {
		return this.#meld?.session;
	}

	/** Subscribe to a typed Meld event. Returns an unsubscribe function. */
	on = this.#emitter.on.bind(this.#emitter);
	/** Remove a previously-registered listener. */
	off = this.#emitter.off.bind(this.#emitter);

	/** Opens the connection and keeps it alive until {@link dispose} is called. */
	connect(): void {
		// `connect` is deliberately idempotent. In a long-lived plugin more than one
		// startup path may ask for the singleton connection; a second call must not
		// replace a healthy Meld instance or leave a timer that does so later.
		if (
			this.#disposeDepth > 0 ||
			(!this.#disposed && (this.#channel || this.#reconnectTimer || this.#handshakeTimer || this.#ready))
		) {
			return;
		}
		this.#disposed = false;
		// An explicit start begins a fresh lifecycle. Do not carry a long failure
		// backoff across dispose/connect cycles (for example, a plugin restart hook).
		this.#reconnectDelay = this.#reconnectMinMs;
		this.#open();
	}

	/** Stops the connection and cancels any pending reconnect. A later connect may restart it. */
	dispose(): void {
		this.#disposeDepth++;
		try {
			this.#disposed = true;
			if (this.#reconnectTimer) {
				clearTimeout(this.#reconnectTimer);
				this.#reconnectTimer = undefined;
			}
			this.#teardownSocket();
			this.#observers.clear();
		} finally {
			this.#disposeDepth--;
		}
	}

	/**
	 * Registers a track observer for fast `gainUpdated` callbacks and remembers it
	 * so it can be re-registered automatically after a reconnect.
	 * @param context Owning action context id.
	 * @param trackId Track to observe.
	 */
	registerTrackObserver(context: string, trackId: string): void {
		const existing = this.#observers.get(context);
		if (existing === trackId && this.#registered.has(context)) {
			return;
		}
		// Switching tracks on the same context: drop the previous registration.
		// Optional-chain the methods too — a Meld build without observer support
		// must degrade to snapshot-only gain, not throw.
		if (existing !== undefined && existing !== trackId && this.#ready) {
			this.#meld?.unregisterTrackObserver?.(context, existing);
		}
		this.#observers.set(context, trackId);
		if (this.#ready) {
			const register = this.#meld?.registerTrackObserver;
			register?.(context, trackId);
			if (register) {
				this.#registered.add(context);
			}
		}
	}

	/**
	 * Removes a track observer previously added with {@link registerTrackObserver}.
	 * @param context Owning action context id.
	 */
	unregisterTrackObserver(context: string): void {
		const trackId = this.#observers.get(context);
		if (trackId === undefined) {
			return;
		}
		this.#observers.delete(context);
		this.#registered.delete(context);
		if (this.#ready) {
			this.#meld?.unregisterTrackObserver?.(context, trackId);
		}
	}

	#open(): void {
		if (this.#disposed) {
			return;
		}
		this.#teardownSocket();

		const generation = ++this.#generation;
		this.#handshakeTimer = setTimeout(() => {
			this.#handshakeTimer = undefined;
			if (generation !== this.#generation) {
				return;
			}
			streamDeck.logger.warn("Meld handshake timed out; retrying");
			this.#teardownSocket();
			this.#scheduleReconnect();
		}, this.#handshakeTimeoutMs);

		try {
			const channel = this.#openWebChannel(this.#url, {
				ready: (meld): void => {
					if (!this.#disposed && generation === this.#generation) {
						try {
							this.#onChannelReady(meld, generation);
						} catch (err) {
							// Readiness is normally asynchronous, outside the opener's try/catch.
							// A malformed API result or failed observer registration must tear down
							// this generation and retry rather than strand a half-ready connection.
							if (!this.#disposed && generation === this.#generation) {
								streamDeck.logger.warn("Failed to initialize Meld channel; retrying", err);
								this.#teardownSocket();
								this.#scheduleReconnect();
							}
						}
					}
				},
				closed: (): void => {
					if (generation !== this.#generation) {
						return;
					}
					this.#teardownSocket();
					this.#scheduleReconnect();
				},
				error: (): void => {
					if (generation === this.#generation) {
						streamDeck.logger.debug("Meld socket error");
					}
				},
			});
			// Adapters normally settle asynchronously, but keeping assignment outside
			// the call also makes a synchronous close/wrong-peer result safe: that
			// result invalidates the generation, so its returned handle is closed rather
			// than installed as the current attempt.
			if (this.#disposed || generation !== this.#generation) {
				channel.close();
			} else {
				this.#channel = channel;
			}
		} catch (err) {
			// A synchronous callback may already have settled and invalidated this
			// attempt before the adapter throws. Its path owns the retry in that case.
			if (generation !== this.#generation) {
				return;
			}
			this.#teardownSocket();
			streamDeck.logger.warn("Failed to open Meld socket", err);
			this.#scheduleReconnect();
		}
	}

	#onChannelReady(meld: MeldObject | undefined, generation: number): void {
		// A well-behaved adapter resolves once, but treating duplicate callbacks as
		// no-ops keeps readiness, signal wiring, and observer registration exact-once.
		if (this.#disposed || generation !== this.#generation || this.#ready || this.#meld) {
			return;
		}
		if (!meld) {
			// Wrong peer (a QWebChannel server without a `meld` object): retry with
			// backoff rather than sitting on an open socket to it forever.
			streamDeck.logger.warn("Meld channel ready but `meld` object is missing; retrying");
			this.#teardownSocket();
			this.#scheduleReconnect();
			return;
		}

		if (this.#handshakeTimer) {
			clearTimeout(this.#handshakeTimer);
			this.#handshakeTimer = undefined;
		}
		this.#meld = meld;

		// Wire the signals before declaring the connection ready: if any of these
		// throws (e.g. a Meld build missing a signal), the dispatch guard closes the
		// socket and the reconnect path must not find a half-initialized "ready"
		// connection.
		meld.sessionChanged.connect(() => {
			if (generation !== this.#generation || meld !== this.#meld) {
				return;
			}
			// A session republish may be the tail of a restore that destroyed and
			// rebuilt Meld's audio tracks, taking every observer registration with it
			// while the socket stayed up. Forget what Meld is holding so the
			// re-render's register call is sent rather than deduped away.
			this.#registered.clear();
			this.#emitter.emit("sessionChanged", meld.session);
		});
		meld.isStreamingChanged.connect(() => {
			if (generation === this.#generation && meld === this.#meld) {
				this.#emitter.emit("streamingChanged", !!meld.isStreaming);
			}
		});
		meld.isRecordingChanged.connect(() => {
			if (generation === this.#generation && meld === this.#meld) {
				this.#emitter.emit("recordingChanged", !!meld.isRecording);
			}
		});
		// Optional: part of the track-observer feature — a build without it must
		// degrade to snapshot-only gain, not throw during the handshake.
		meld.gainUpdated?.connect((trackId, gain, muted) => {
			if (generation === this.#generation && meld === this.#meld) {
				this.#emitter.emit("gainChanged", { trackId, gain, muted });
			}
		});

		// Re-register every active observer against the fresh `meld` object.
		for (const [context, trackId] of this.#observers) {
			meld.registerTrackObserver?.(context, trackId);
			if (meld.registerTrackObserver) {
				this.#registered.add(context);
			}
		}

		// Only a fully completed handshake resets the backoff; a recurring throw
		// above must keep growing the delay instead of hammering Meld every second.
		this.#reconnectDelay = this.#reconnectMinMs;
		this.#ready = true;

		// Announce readiness, then push the initial authoritative state so listeners
		// hydrate deterministically without racing the first signal.
		this.#emitter.emit("ready");
		if (!this.#isCurrentReady(meld, generation)) return;
		this.#emitter.emit("sessionChanged", meld.session);
		if (!this.#isCurrentReady(meld, generation)) return;
		this.#emitter.emit("streamingChanged", !!meld.isStreaming);
		if (!this.#isCurrentReady(meld, generation)) return;
		this.#emitter.emit("recordingChanged", !!meld.isRecording);
	}

	/** Whether an initialization callback still owns the live, ready generation. */
	#isCurrentReady(meld: MeldObject, generation: number): boolean {
		return !this.#disposed && this.#ready && generation === this.#generation && meld === this.#meld;
	}

	#onDisconnected(): void {
		if (!this.#ready && !this.#meld) {
			return;
		}
		const wasReady = this.#ready;
		this.#ready = false;
		this.#meld = undefined;
		this.#registered.clear();
		// A failure while validating the API result never announced `ready`, so it
		// must not manufacture an unmatched `closed` lifecycle event.
		if (wasReady) {
			this.#emitter.emit("closed");
		}
	}

	#scheduleReconnect(): void {
		// A `closed` listener is allowed to call connect() synchronously. If it did,
		// do not leave the old close path's timer armed to replace the fresh attempt.
		if (this.#disposed || this.#reconnectTimer || this.#channel || this.#handshakeTimer || this.#ready) {
			return;
		}
		const delay = this.#reconnectDelay;
		this.#reconnectDelay = Math.min(this.#reconnectDelay * 1.5, RECONNECT_MAX_MS);
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			this.#open();
		}, delay);
	}

	#teardownSocket(): void {
		// Invalidate first so a close implementation that synchronously releases a
		// queued callback cannot resurrect the attempt being torn down.
		this.#generation++;
		if (this.#handshakeTimer) {
			clearTimeout(this.#handshakeTimer);
			this.#handshakeTimer = undefined;
		}
		const channel = this.#channel;
		this.#channel = undefined;
		if (channel) {
			try {
				channel.close();
			} catch {
				// ignore
			}
		}
		// Detaching the handlers means `onclose` will never run for this socket, so
		// the disconnect has to be recorded here or `ready`/`meld` would keep
		// describing a transport that is gone. Idempotent: a teardown that follows
		// a real close is a no-op.
		this.#onDisconnected();
	}
}
