// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action } from "@elgato/streamdeck";

import type { EffectItem, IdentifiedItem, MeldSession } from "../meld/index.js";
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
		const effect = this.#effect(settings, session);
		return effect ? effect.enabled : null;
	}

	protected toggle(settings: ToggleEffectSettings): void {
		if (!settings.scene || !settings.layer || !settings.effect) {
			return;
		}
		// Settings can hold a layer/effect from a previously-selected parent (e.g.
		// saved before a dropdown changed); never send Meld a mismatched triple.
		if (this.meld.ready && !this.#effect(settings, this.session())) {
			return;
		}
		this.meld.meld?.toggleEffect?.(settings.scene, settings.layer, settings.effect);
	}

	/** The configured effect, only when its layer/scene chain matches the settings. */
	#effect(settings: ToggleEffectSettings, session: MeldSession): IdentifiedItem<EffectItem> | undefined {
		const effect = session.getEffect(settings.effect);
		if (!effect || effect.parent !== settings.layer) {
			return undefined;
		}
		const layer = session.getLayer(settings.layer);
		return layer && layer.parent === settings.scene ? effect : undefined;
	}
}
