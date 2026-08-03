// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action } from "@elgato/streamdeck";

import type { IdentifiedItem, LayerItem, MeldSession } from "../meld/index.js";
import { SessionToggleAction } from "./session-toggle.js";

/** Settings for {@link ToggleLayer}. */
type ToggleLayerSettings = {
	scene?: string;
	layer?: string;
	action?: string;
};

/** Toggles (or forces) a layer's visibility within a scene. */
@action({ UUID: "co.meldstudio.streamdeck.toggle-layer" })
export class ToggleLayer extends SessionToggleAction<ToggleLayerSettings> {
	protected readonly missingItemState = 0;
	protected readonly forceOnValue = "show";

	protected isConfigured(settings: ToggleLayerSettings): boolean {
		return !!settings.scene && !!settings.layer;
	}

	protected mode(settings: ToggleLayerSettings): string | undefined {
		return settings.action;
	}

	protected currentValue(settings: ToggleLayerSettings, session: MeldSession): boolean | null {
		// The layer id alone identifies the target. Legacy profiles can hold a
		// scene from a previous selection alongside it; the layer must keep working
		// across the upgrade, so the stored scene is not required to match.
		const layer = session.getLayer(settings.layer);
		return layer ? layer.visible : null;
	}

	protected toggle(settings: ToggleLayerSettings): void {
		if (!settings.scene || !settings.layer) {
			return;
		}
		// The layer's real parent from the session is authoritative, so Meld is
		// never sent a mismatched scene/layer pair even for stale stored scenes.
		const layer: IdentifiedItem<LayerItem> | undefined = this.session().getLayer(settings.layer);
		this.meld.meld?.toggleLayer?.(layer?.parent ?? settings.scene, settings.layer);
	}
}
