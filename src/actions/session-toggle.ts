// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import type { KeyUpEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { MeldSession } from "../meld/index.js";
import { MeldAction, type RenderArgs } from "./base.js";

/**
 * Shared behaviour for the four "toggle a boolean session property" actions:
 * layer visibility, effect enabled, track mute, and track monitoring.
 *
 * Each such action reflects one authoritative boolean from the session, and
 * supports three press modes: plain `toggle`, or forcing the property on/off.
 * Force mode prefers a direct idempotent setter when Meld exposes one, and
 * otherwise falls back to a toggle only when the current authoritative value
 * differs from the desired one — so pressing "mute" when already muted is a
 * no-op rather than an accidental unmute.
 */
export abstract class SessionToggleAction<T extends JsonObject> extends MeldAction<T> {
	/** Key state shown when the configured item is absent from the session. */
	protected abstract readonly missingItemState: 0 | 1;

	/** The `action` settings value that means "force the property on". */
	protected abstract readonly forceOnValue: string;

	/** Whether the settings identify a target item. */
	protected abstract isConfigured(settings: T): boolean;

	/** The press-mode setting (`"toggle"`, the force-on value, or its inverse). */
	protected abstract mode(settings: T): string | undefined;

	/**
	 * The authoritative boolean for this action, or `null` when the target item is
	 * missing from the session.
	 */
	protected abstract currentValue(settings: T, session: MeldSession): boolean | null;

	/** Maps the authoritative boolean to the key's state. Overridden by mute (inverted). */
	protected valueToKeyState(value: boolean): 0 | 1 {
		return value ? 1 : 0;
	}

	/** Toggles the property via Meld. */
	protected abstract toggle(settings: T): void;

	/**
	 * Attempts to set the property directly (idempotent) to {@link desired}.
	 * @returns `true` when a direct setter was available and used.
	 */
	protected setDirect(_settings: T, _desired: boolean): boolean {
		return false;
	}

	/** @inheritdoc */
	override onKeyUp(ev: KeyUpEvent<T>): void {
		const settings = ev.payload.settings;
		if (!this.isConfigured(settings)) {
			return;
		}
		// Acting requires a live connection and an item that exists in the current
		// session: a command for a dead id (e.g. from a previous Meld instance) is
		// a silent no-op in Meld and would never be echoed, so repainting here
		// would fake a confirmed state.
		if (!this.meld.ready) {
			return;
		}
		const current = this.currentValue(settings, this.session());
		if (current === null) {
			return;
		}

		const mode = this.mode(settings);
		if (!mode || mode === "toggle") {
			this.toggle(settings);
			return;
		}

		const desired = mode === this.forceOnValue;
		if (this.setDirect(settings, desired)) {
			void this.setKeyState(ev.action, this.valueToKeyState(desired));
			return;
		}

		// No direct setter: toggle only if we are not already in the desired state.
		if (current !== desired) {
			this.toggle(settings);
		} else {
			void this.setKeyState(ev.action, this.valueToKeyState(current));
		}
	}

	/** @inheritdoc */
	protected async render({ action, settings, session, reason }: RenderArgs<T>): Promise<void> {
		if (!this.isConfigured(settings)) {
			return;
		}
		// Nothing authoritative to show while disconnected; leave the key as-is.
		if (!session.isPresent && reason !== "willAppear") {
			return;
		}

		const value = this.currentValue(settings, session);
		if (value === null) {
			return void this.setKeyState(action, this.missingItemState);
		}
		await this.setKeyState(action, this.valueToKeyState(value));
	}
}
