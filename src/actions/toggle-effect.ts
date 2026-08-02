// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action } from "@elgato/streamdeck";

import type { MeldSession } from "../meld/index.js";
import { SessionToggleAction } from "./session-toggle.js";

/** Settings for {@link ToggleEffect}. */
type ToggleEffectSettings = {
	scene?: string;
	layer?: string;
	effect?: string;
	action?: string;
};

/** Toggles (or forces) an effect's enabled state within a layer. */
@action({ UUID: "co.meldstudio.streamdeck.toggle-effect" })
export class ToggleEffect extends SessionToggleAction<ToggleEffectSettings> {
	protected readonly missingItemState = 0;
	protected readonly forceOnValue = "show";

	protected isConfigured(settings: ToggleEffectSettings): boolean {
		return !!settings.scene && !!settings.layer && !!settings.effect;
	}

	protected mode(settings: ToggleEffectSettings): string | undefined {
		return settings.action;
	}

	protected currentValue(settings: ToggleEffectSettings, session: MeldSession): boolean | null {
		const effect = session.getEffect(settings.effect);
		return effect ? effect.enabled : null;
	}

	protected toggle(settings: ToggleEffectSettings): void {
		if (settings.scene && settings.layer && settings.effect) {
			this.meld.meld?.toggleEffect?.(settings.scene, settings.layer, settings.effect);
		}
	}
}
