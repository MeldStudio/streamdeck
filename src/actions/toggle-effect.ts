// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action } from "@elgato/streamdeck";

import type { IdentifiedItem, LayerItem, MeldSession } from "../meld/index.js";
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

	protected targetOf(settings: ToggleEffectSettings): string | undefined {
		return settings.effect;
	}

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

	/**
	 * A legacy id names an effect by its position in Meld's own effects model, an
	 * order the session snapshot does not carry, so the press has to go ahead
	 * without knowing the effect's current state.
	 */
	protected override actsWithUnknownState(settings: ToggleEffectSettings): boolean {
		return this.#legacyLayer(settings) !== undefined;
	}

	protected toggle(settings: ToggleEffectSettings): void {
		if (!settings.scene || !settings.layer || !settings.effect) {
			return;
		}
		const session = this.session();
		const effect = session.getEffect(settings.effect);
		if (!effect) {
			// A legacy `<layerId>-<index>` id. Meld resolves it against its effects
			// model — the order the user sees — which the snapshot does not expose,
			// so resolving it here would pick a different effect. Pass it through
			// verbatim with the stored chain, exactly as the pre-migration plugin
			// did, and let Meld apply its own fallback.
			this.meld.meld?.toggleEffect?.(settings.scene, settings.layer, settings.effect);
			return;
		}
		// The session's real parent chain is authoritative, so Meld is never sent
		// a mismatched triple even for stale stored scene/layer ids.
		const layerId = effect.parent;
		const sceneId = session.getLayer(layerId)?.parent ?? settings.scene;
		this.meld.meld?.toggleEffect?.(sceneId, layerId, effect.id);
	}

	/**
	 * The layer a legacy `<layerId>-<index>` id refers to, when the stored effect
	 * id is in that historical form and the layer still exists.
	 *
	 * Before effects had stable ids the inspector stored them this way, and
	 * upgraded profiles still do. Meld never publishes the form in the snapshot —
	 * it only accepts it as a `toggleEffect` argument.
	 * @param settings The action's settings.
	 */
	#legacyLayer(settings: ToggleEffectSettings): IdentifiedItem<LayerItem> | undefined {
		const session = this.session();
		if (!settings.effect || session.getEffect(settings.effect)) {
			return undefined;
		}
		const parts = settings.effect.split("-");
		if (parts.length !== 2 || !/^\d+$/.test(parts[1])) {
			return undefined;
		}
		return session.getLayer(parts[0]);
	}
}
