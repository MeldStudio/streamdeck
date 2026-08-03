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
		const effect = this.#effect(settings, session);
		return effect ? effect.enabled : null;
	}

	protected toggle(settings: ToggleEffectSettings): void {
		if (!settings.scene || !settings.layer || !settings.effect) {
			return;
		}
		// The session's real parent chain is authoritative, so Meld is never sent
		// a mismatched triple even for stale stored scene/layer ids.
		const session = this.session();
		const effect = this.#effect(settings, session);
		const effectId = effect?.id ?? settings.effect;
		const layerId = effect?.parent ?? settings.layer;
		const sceneId = session.getLayer(layerId)?.parent ?? settings.scene;
		this.meld.meld?.toggleEffect?.(sceneId, layerId, effectId);
	}

	/**
	 * Resolves the configured effect, accepting the historical id form as well.
	 *
	 * Before effects had stable ids the inspector stored them as
	 * `<layerId>-<index>`, and profiles upgraded from that plugin still do. Meld
	 * never publishes that form in the session snapshot — it only accepts it as a
	 * `toggleEffect` argument — so resolving it here is what keeps those keys
	 * alive instead of reporting the effect as missing.
	 * @param settings The action's settings.
	 * @param session The session to resolve against.
	 */
	#effect(settings: ToggleEffectSettings, session: MeldSession): IdentifiedItem<EffectItem> | undefined {
		const direct = session.getEffect(settings.effect);
		if (direct) {
			return direct;
		}
		const separator = settings.effect?.lastIndexOf("-") ?? -1;
		if (!settings.effect || separator <= 0) {
			return undefined;
		}
		const layerId = settings.effect.slice(0, separator);
		const index = Number.parseInt(settings.effect.slice(separator + 1), 10);
		if (!Number.isInteger(index) || index < 0 || !session.getLayer(layerId)) {
			return undefined;
		}
		return session.effects(layerId)[index];
	}
}
