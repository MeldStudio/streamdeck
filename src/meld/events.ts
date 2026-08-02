// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import type { Session } from "./types.js";

/** Payload emitted by the fast `gainUpdated` track observer signal. */
export type GainChange = {
	trackId: string;
	gain: number;
	muted: boolean;
};

/** The full map of Meld connection events and their argument tuples. */
export type MeldEventMap = {
	/** The QWebChannel handshake finished; `meld` is available and a fresh snapshot follows. */
	ready: [];
	/** The socket closed; `meld` is no longer usable until the next `ready`. */
	closed: [];
	/** The authoritative session snapshot changed. */
	sessionChanged: [session: Session | undefined];
	/** A registered track's gain/mute changed (faster than a full session update). */
	gainChanged: [change: GainChange];
	/** `isStreaming` changed. */
	streamingChanged: [streaming: boolean];
	/** `isRecording` changed. */
	recordingChanged: [recording: boolean];
};

type Listener<Args extends unknown[]> = (...args: Args) => void;

/**
 * A tiny strongly-typed event emitter. Deliberately not Node's `EventEmitter`
 * so the event names and argument tuples are checked at compile time — the
 * scattered, stringly-typed `$MS.on(...)` calls were a source of the state bugs
 * this refactor removes.
 */
export class TypedEmitter<Events extends Record<string, unknown[]>> {
	readonly #listeners = new Map<keyof Events, Set<Listener<never>>>();

	/**
	 * Subscribes to an event.
	 * @param event Event name.
	 * @param listener Callback invoked with the event's arguments.
	 * @returns A function that removes the listener.
	 */
	on<E extends keyof Events>(event: E, listener: Listener<Events[E]>): () => void {
		let set = this.#listeners.get(event);
		if (!set) {
			set = new Set();
			this.#listeners.set(event, set);
		}
		set.add(listener as Listener<never>);
		return () => this.off(event, listener);
	}

	/**
	 * Removes a previously-registered listener.
	 * @param event Event name.
	 * @param listener The exact callback passed to {@link on}.
	 */
	off<E extends keyof Events>(event: E, listener: Listener<Events[E]>): void {
		this.#listeners.get(event)?.delete(listener as Listener<never>);
	}

	/**
	 * Emits an event to all listeners. Listener exceptions are isolated so one
	 * bad subscriber cannot break the others.
	 * @param event Event name.
	 * @param args Event arguments.
	 */
	emit<E extends keyof Events>(event: E, ...args: Events[E]): void {
		const set = this.#listeners.get(event);
		if (!set) {
			return;
		}
		for (const listener of [...set]) {
			(listener as Listener<Events[E]>)(...args);
		}
	}
}
