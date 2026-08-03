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
		// The effect id alone identifies the target. Legacy profiles can hold a
		// scene/layer from previous selections alongside it; the effect must keep
		// working across the upgrade, so the stored chain is not required to match.
		const effect = session.getEffect(settings.effect);
		return effect ? effect.enabled : null;
	}

	protected toggle(settings: ToggleEffectSettings): void {
		if (!settings.scene || !settings.layer || !settings.effect) {
			return;
		}
		// The session's real parent chain is authoritative, so Meld is never sent
		// a mismatched triple even for stale stored scene/layer ids.
		const session = this.session();
		const effect: IdentifiedItem<EffectItem> | undefined = session.getEffect(settings.effect);
		const layerId = effect?.parent ?? settings.layer;
		const sceneId = session.getLayer(layerId)?.parent ?? settings.scene;
		this.meld.meld?.toggleEffect?.(sceneId, layerId, settings.effect);
	}
}
