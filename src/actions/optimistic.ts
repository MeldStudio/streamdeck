// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

/** Default lifetime of an optimistic value before it is discarded (ms). */
const DEFAULT_TTL_MS = 750;

/**
 * Holds short-lived, per-context "optimistic" values used to make dials and
 * toggles feel responsive without letting them drift out of sync with Meld.
 *
 * The rule is simple and always the same: **authoritative state wins.** A user
 * interaction stores an optimistic value so the UI updates immediately; the
 * value self-expires after a short TTL, and any authoritative update from Meld
 * clears it outright. This replaces the ad-hoc `trackInfo[track].gain` /
 * `sceneRequested` bookkeeping that caused the dial-desync bug.
 */
export class OptimisticStore<T> {
	readonly #pending = new Map<string, { value: T; timer: ReturnType<typeof setTimeout> }>();
	readonly #ttlMs: number;

	constructor(ttlMs: number = DEFAULT_TTL_MS) {
		this.#ttlMs = ttlMs;
	}

	/**
	 * Records an optimistic value for a context, replacing any existing one and
	 * (re)starting its expiry timer.
	 * @param context Context id.
	 * @param value Optimistic value to display until Meld confirms.
	 */
	set(context: string, value: T): void {
		this.clear(context);
		const timer = setTimeout(() => this.#pending.delete(context), this.#ttlMs);
		// Do not keep the process alive purely for an optimistic-value expiry.
		timer.unref?.();
		this.#pending.set(context, { value, timer });
	}

	/**
	 * Returns the current optimistic value for a context, or `undefined` when none
	 * is active.
	 * @param context Context id.
	 */
	get(context: string): T | undefined {
		return this.#pending.get(context)?.value;
	}

	/**
	 * Drops any optimistic value for a context. Call this whenever authoritative
	 * state arrives, so Meld's value takes over.
	 * @param context Context id.
	 */
	clear(context: string): void {
		const entry = this.#pending.get(context);
		if (entry) {
			clearTimeout(entry.timer);
			this.#pending.delete(context);
		}
	}

	/** Clears every optimistic value (e.g. on disconnect). */
	clearAll(): void {
		for (const { timer } of this.#pending.values()) {
			clearTimeout(timer);
		}
		this.#pending.clear();
	}
}
