// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import streamDeck, { action } from "@elgato/streamdeck";

import type { MeldSession } from "../meld/index.js";
import { SessionToggleAction } from "./session-toggle.js";

/** Settings for {@link ToggleBackgroundEffect}. */
type ToggleBackgroundEffectSettings = {
	scene?: string;
	layer?: string;
	action?: string;
};

/**
 * The camera layer property behind Meld's "Background" switch. Whether the
 * effect blurs or removes the background is a per-device setting chosen in
 * Meld; this switch turns the effect on or off for one camera layer.
 */
export const BACKGROUND_EFFECT_PROPERTY = "backgroundEffectEnabled";

/**
 * Toggles (or forces) the background blur / removal effect on a camera layer.
 *
 * The layer's `backgroundEffectEnabled` field is published by Meld's
 * StreamDeckMapper for camera layers. Builds that predate the field still
 * accept the property through `setProperty`, so Enable / Disable keep working
 * against them; only Toggle, which has to know the current value, requires it.
 */
@action({ UUID: "co.meldstudio.streamdeck.toggle-background-effect" })
export class ToggleBackgroundEffect extends SessionToggleAction<ToggleBackgroundEffectSettings> {
	protected readonly missingItemState = 1;
	protected readonly forceOnValue = "enable";

	protected targetOf(settings: ToggleBackgroundEffectSettings): string | undefined {
		return settings.layer;
	}

	protected isConfigured(settings: ToggleBackgroundEffectSettings): boolean {
		// The layer id is the durable target; its parent scene is derived from the
		// session whenever the stored chain is stale or incomplete.
		return !!settings.layer;
	}

	protected mode(settings: ToggleBackgroundEffectSettings): string | undefined {
		return settings.action;
	}

	protected override migrateSettings(
		settings: ToggleBackgroundEffectSettings,
		session: MeldSession,
	): ToggleBackgroundEffectSettings {
		let migrated = super.migrateSettings(settings, session);
		const layer = session.getLayer(migrated.layer);
		if (layer && migrated.scene !== layer.parent) {
			migrated = { ...migrated, scene: layer.parent };
		}
		return migrated;
	}

	protected currentValue(settings: ToggleBackgroundEffectSettings, session: MeldSession): boolean | null {
		const layer = session.getLayer(settings.layer);
		// A layer that exists but carries no field is a camera on a Meld build that
		// does not publish it (or a non-camera layer chosen from such a build): the
		// state is unknown rather than "off".
		return typeof layer?.backgroundEffectEnabled === "boolean" ? layer.backgroundEffectEnabled : null;
	}

	protected override actsWithUnknownState(settings: ToggleBackgroundEffectSettings): boolean {
		// The target is real as long as the layer is in the current snapshot; only
		// its value may be unreadable. Enable / Disable are idempotent writes and
		// are forwarded regardless.
		return this.session().has(settings.layer);
	}

	protected override setDirect(settings: ToggleBackgroundEffectSettings, desired: boolean): boolean {
		const meld = this.meld.meld;
		if (!settings.layer || !meld?.setProperty) {
			return false;
		}
		meld.setProperty(settings.layer, BACKGROUND_EFFECT_PROPERTY, desired);
		return true;
	}

	protected toggle(settings: ToggleBackgroundEffectSettings, next: boolean | null): void {
		if (!settings.layer) {
			return;
		}
		// Meld exposes no toggle call for this property, so the plugin writes the
		// value the press should produce. The base class derives it from the
		// pending press when one exists, so a quick second press cannot undo the
		// first by re-reading the not-yet-republished snapshot.
		if (next === null) {
			streamDeck.logger.warn(
				`Camera background toggle skipped for ${settings.layer}: Meld did not publish its current state. Use Enable or Disable.`,
			);
			return;
		}
		this.setDirect(settings, next);
	}
}
