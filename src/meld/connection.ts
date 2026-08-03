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

	/** The Meld WebChannel endpoint this connection targets. */
	readonly #url: string;

	/** How long a connection attempt may run before it is abandoned and retried. */
	readonly #handshakeTimeoutMs: number;

	/** Starting reconnect delay, grown on each consecutive failure. */
	readonly #reconnectMinMs: number;

	constructor({
		address = MELD_ADDRESS,
		port = MELD_PORT,
		handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS,
		reconnectMinMs = RECONNECT_MIN_MS,
	}: MeldConnectionOptions = {}) {
		this.#url = `ws://${address}:${port}`;
		this.#handshakeTimeoutMs = handshakeTimeoutMs;
		this.#reconnectMinMs = reconnectMinMs;
		this.#reconnectDelay = reconnectMinMs;
	}

	#socket?: WebSocket;
	#meld?: MeldObject;
	#ready = false;
	#reconnectDelay = RECONNECT_MIN_MS;
	#reconnectTimer?: ReturnType<typeof setTimeout>;
	#handshakeTimer?: ReturnType<typeof setTimeout>;
	#generation = 0;
	#disposed = false;

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
		this.#disposed = false;
		this.#open();
	}

	/** Permanently closes the connection and cancels any pending reconnect. */
	dispose(): void {
		this.#disposed = true;
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = undefined;
		}
		this.#teardownSocket();
		this.#observers.clear();
	}

	/**
	 * Registers a track observer for fast `gainUpdated` callbacks and remembers it
	 * so it can be re-registered automatically after a reconnect.
	 * @param context Owning action context id.
	 * @param trackId Track to observe.
	 */
	registerTrackObserver(context: string, trackId: string): void {
		const existing = this.#observers.get(context);
		if (existing === trackId) {
			return;
		}
		// Switching tracks on the same context: drop the previous registration.
		// Optional-chain the methods too — a Meld build without observer support
		// must degrade to snapshot-only gain, not throw.
		if (existing !== undefined && this.#ready) {
			this.#meld?.unregisterTrackObserver?.(context, existing);
		}
		this.#observers.set(context, trackId);
		if (this.#ready) {
			this.#meld?.registerTrackObserver?.(context, trackId);
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
		let socket: WebSocket;
		try {
			socket = new WebSocket(this.#url);
		} catch (err) {
			streamDeck.logger.warn("Failed to open Meld socket", err);
			this.#scheduleReconnect();
			return;
		}
		this.#socket = socket;

		// Bound the whole connect→ready window, covering both the WebSocket upgrade
		// and the QWebChannel handshake: a peer that accepts the socket but never
		// finishes either would otherwise leave the plugin waiting on it forever,
		// since `onclose` never fires on a socket nobody closes.
		this.#handshakeTimer = setTimeout(() => {
			this.#handshakeTimer = undefined;
			// A completed handshake clears this timer before marking the connection
			// ready, so reaching here means this attempt never got there. Only the
			// generation matters: a newer attempt owns its own timer.
			if (generation !== this.#generation) {
				return;
			}
			streamDeck.logger.warn("Meld handshake timed out; retrying");
			this.#teardownSocket();
			this.#scheduleReconnect();
		}, this.#handshakeTimeoutMs);

		socket.onopen = (): void => {
			if (generation !== this.#generation) {
				return;
			}
			// eslint-disable-next-line no-new -- QWebChannel wires itself onto the transport.
			new QWebChannel(socket, (channel: { objects: Record<string, MeldObject> }) => {
				if (generation !== this.#generation) {
					return;
				}
				this.#onChannelReady(channel.objects.meld);
			});
		};

		socket.onclose = (): void => {
			if (generation !== this.#generation) {
				return;
			}
			// The peer closed first; the watchdog has nothing left to guard and would
			// only fire a spurious timeout against this dead attempt.
			if (this.#handshakeTimer) {
				clearTimeout(this.#handshakeTimer);
				this.#handshakeTimer = undefined;
			}
			this.#onDisconnected();
			this.#scheduleReconnect();
		};

		socket.onerror = (): void => {
			// `onclose` always follows `onerror`; let it drive the reconnect so we
			// don't double-schedule.
			if (generation === this.#generation) {
				streamDeck.logger.debug("Meld socket error");
			}
		};
	}

	#onChannelReady(meld: MeldObject | undefined): void {
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
		meld.sessionChanged.connect(() => this.#emitter.emit("sessionChanged", meld.session));
		meld.isStreamingChanged.connect(() => this.#emitter.emit("streamingChanged", !!meld.isStreaming));
		meld.isRecordingChanged.connect(() => this.#emitter.emit("recordingChanged", !!meld.isRecording));
		// Optional: part of the track-observer feature — a build without it must
		// degrade to snapshot-only gain, not throw during the handshake.
		meld.gainUpdated?.connect((trackId, gain, muted) =>
			this.#emitter.emit("gainChanged", { trackId, gain, muted }),
		);

		this.#ready = true;

		// Re-register every active observer against the fresh `meld` object.
		for (const [context, trackId] of this.#observers) {
			meld.registerTrackObserver?.(context, trackId);
		}

		// Only a fully completed handshake resets the backoff; a recurring throw
		// above must keep growing the delay instead of hammering Meld every second.
		this.#reconnectDelay = this.#reconnectMinMs;

		// Announce readiness, then push the initial authoritative state so listeners
		// hydrate deterministically without racing the first signal.
		this.#emitter.emit("ready");
		this.#emitter.emit("sessionChanged", meld.session);
		this.#emitter.emit("streamingChanged", !!meld.isStreaming);
		this.#emitter.emit("recordingChanged", !!meld.isRecording);
	}

	#onDisconnected(): void {
		if (!this.#ready && !this.#meld) {
			return;
		}
		this.#ready = false;
		this.#meld = undefined;
		this.#emitter.emit("closed");
	}

	#scheduleReconnect(): void {
		if (this.#disposed || this.#reconnectTimer) {
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
		if (this.#handshakeTimer) {
			clearTimeout(this.#handshakeTimer);
			this.#handshakeTimer = undefined;
		}
		const socket = this.#socket;
		if (!socket) {
			return;
		}
		this.#socket = undefined;
		socket.onopen = null;
		socket.onclose = null;
		socket.onerror = null;
		socket.onmessage = null;
		try {
			socket.close();
		} catch {
			// ignore
		}
		// Detaching the handlers means `onclose` will never run for this socket, so
		// the disconnect has to be recorded here or `ready`/`meld` would keep
		// describing a transport that is gone. Idempotent: a teardown that follows
		// a real close is a no-op.
		this.#onDisconnected();
	}
}
