// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import type { KeyUpEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { MeldConnection, MeldSession } from "../meld/index.js";
import { MeldAction, type RenderArgs } from "./base.js";
import { OptimisticStore } from "./optimistic.js";

/**
 * How long a press keeps precedence over the session snapshot. Meld republishes
 * behind a ~600 ms retriggerable autosave, so this has to outlast a burst of
 * concurrent edits while still self-correcting a press that never took effect.
 */
const TOGGLE_CONFIRM_TTL_MS = 3_000;

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
	/**
	 * The value each pending press is waiting for, keyed by the target item rather
	 * than the key, so every key pointing at one item reasons from the same latest
	 * press. Meld confirms these through the republished session, which rides a
	 * retriggerable autosave, so the wait is far longer than a gain echo; an
	 * unconfirmed press expires back to whatever the session says.
	 */
	readonly #pending = new OptimisticStore<boolean>(TOGGLE_CONFIRM_TTL_MS, () =>
		void this.renderAll("sessionChanged"),
	);

	constructor(connection?: MeldConnection) {
		super(connection);
		// A pending press belongs to one Meld process. If that process exits before
		// its debounced snapshot confirms the command, the next instance must render
		// from its own session rather than inherit the abandoned intent.
		this.meld.on("closed", () => this.#pending.clearAll());
	}

	/** Key state shown when the configured item is absent from the session. */
	protected abstract readonly missingItemState: 0 | 1;

	/** The `action` settings value that means "force the property on". */
	protected abstract readonly forceOnValue: string;

	/** Whether the settings identify a target item. */
	protected abstract isConfigured(settings: T): boolean;

	/** The press-mode setting (`"toggle"`, the force-on value, or its inverse). */
	protected abstract mode(settings: T): string | undefined;

	/** Persist the historical implicit press mode so upgraded profiles are explicit. */
	protected override migrateSettings(settings: T, _session: MeldSession): T {
		if (this.mode(settings) != null) {
			return settings;
		}
		return { ...settings, action: "toggle" } as T;
	}

	/**
	 * The authoritative boolean for this action, or `null` when the target item is
	 * missing from the session.
	 */
	protected abstract currentValue(settings: T, session: MeldSession): boolean | null;

	/** Maps the authoritative boolean to the key's state (state 0 = active). */
	protected valueToKeyState(value: boolean): 0 | 1 {
		return value ? 0 : 1;
	}

	/**
	 * Toggles the property via Meld.
	 * @param settings The action's settings.
	 * @param next The value the press is expected to produce, or `null` when the
	 * current value is unknown. Actions backed by a native Meld toggle can ignore
	 * it; actions that write the property directly must use it rather than
	 * re-deriving it from the snapshot, which still predates any pending press.
	 */
	protected abstract toggle(settings: T, next: boolean | null): void;

	/**
	 * Whether a press should go ahead even when {@link currentValue} is `null`.
	 *
	 * Normally an unreadable value means the item is absent — from a previous Meld
	 * instance, say — and acting would send a command Meld silently drops while
	 * painting a state it never confirms. An action overrides this when it can
	 * identify a real target whose state it simply cannot read.
	 * @param _settings The action's settings.
	 */
	protected actsWithUnknownState(_settings: T): boolean {
		return false;
	}

	/**
	 * Whether the connected Meld can carry out this action's presses at all. When
	 * it cannot, a press is ignored outright rather than painting a state that no
	 * command will ever confirm.
	 */
	protected canAct(): boolean {
		return true;
	}

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
		if (!this.meld.ready || !this.canAct()) {
			return;
		}
		// Meld only republishes the session behind its debounced autosave, so the
		// snapshot still describes the state before any press made in the last
		// several hundred milliseconds. A pending press is therefore the better
		// answer: comparing against the stale snapshot would make a second press
		// toggle again and undo the first — pressing "show" twice would hide the
		// layer the user asked to show. The pending value is shared by every key on
		// the same target, so a second key pressed inside that window builds on the
		// first key's press instead of repeating it.
		const session = this.session();
		const target = this.#pendingKey(settings, session);
		const authoritative = this.currentValue(settings, session);
		const pending = target === undefined ? undefined : this.#pending.get(target);
		const current = pending ?? authoritative;
		if (current === null && !this.actsWithUnknownState(settings)) {
			return;
		}

		const mode = this.mode(settings);
		if (!mode || mode === "toggle") {
			const next = current === null ? null : !current;
			this.#apply(target, next);
			if (next !== null) {
				// Paint the press straight away; the confirmation is hundreds of
				// milliseconds behind and the key would otherwise look unresponsive.
				void this.setKeyState(ev.action, this.valueToKeyState(next));
			}
			this.toggle(settings, next);
			return;
		}

		const desired = mode === this.forceOnValue;
		if (current === null) {
			// Actionable but unreadable: there is nothing to compare against, so
			// forward the press and let Meld decide, as the pre-migration plugin did.
			// Nothing is painted or remembered, because no snapshot will ever confirm
			// it: the key would show the desired state until the pending value
			// expired and then fall back to the unknown state, contradicting Meld.
			if (!this.setDirect(settings, desired)) {
				this.toggle(settings, desired);
			}
			return;
		}

		if (this.setDirect(settings, desired)) {
			this.#apply(target, desired);
			void this.setKeyState(ev.action, this.valueToKeyState(desired));
			return;
		}

		// No direct setter: toggle only if we are not already in the desired state.
		if (current !== desired) {
			this.#apply(target, desired);
			void this.setKeyState(ev.action, this.valueToKeyState(desired));
			this.toggle(settings, desired);
		} else {
			void this.setKeyState(ev.action, this.valueToKeyState(current));
		}
	}

	/**
	 * The id this action acts on. Pending presses are keyed by it, so a key that
	 * is retargeted or removed neither carries a press to another item nor drops
	 * one that other keys on the same item still rely on.
	 * @param settings The action's settings.
	 */
	protected abstract targetOf(settings: T): string | undefined;

	/**
	 * The key a pending press is stored under: the target after migration, so a
	 * press that carries pre-migration settings (an indexed effect id, say) and the
	 * render that sees the migrated ones agree on the item.
	 * @param settings The action's settings, migrated or not.
	 * @param session The current session snapshot.
	 */
	#pendingKey(settings: T, session: MeldSession): string | undefined {
		return this.targetOf(this.migrateSettings(settings, session));
	}

	/**
	 * Records the value a press is waiting for, so a follow-up press reasons from
	 * it rather than from the not-yet-republished snapshot.
	 * Other keys on the same target are repainted so they show the press too.
	 * @param target The target item's id.
	 * @param value The value the press should produce, or `null` when unknown.
	 */
	#apply(target: string | undefined, value: boolean | null): void {
		if (target === undefined || value === null) {
			return;
		}
		this.#pending.set(target, value);
		void this.renderAll("sessionChanged");
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
		const target = this.#pendingKey(settings, session);
		const pending = target === undefined ? undefined : this.#pending.get(target);
		if (target !== undefined && pending !== undefined && value === pending) {
			// The snapshot caught up with the press; stop overriding it.
			this.#pending.clear(target);
		}
		const shown = (target === undefined ? undefined : this.#pending.get(target)) ?? value;
		if (shown === null) {
			return void this.setKeyState(action, this.missingItemState);
		}
		await this.setKeyState(action, this.valueToKeyState(shown));
	}
}
