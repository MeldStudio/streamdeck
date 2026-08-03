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
		const layer = this.#layer(settings, session);
		return layer ? layer.visible : null;
	}

	protected toggle(settings: ToggleLayerSettings): void {
		if (!settings.scene || !settings.layer) {
			return;
		}
		// Settings can hold a layer from a previously-selected scene (e.g. saved
		// before the scene dropdown changed); never send Meld a mismatched pair.
		if (this.meld.ready && !this.#layer(settings, this.session())) {
			return;
		}
		this.meld.meld?.toggleLayer?.(settings.scene, settings.layer);
	}

	/** The configured layer, only when it actually belongs to the configured scene. */
	#layer(settings: ToggleLayerSettings, session: MeldSession): IdentifiedItem<LayerItem> | undefined {
		const layer = session.getLayer(settings.layer);
		return layer && layer.parent === settings.scene ? layer : undefined;
	}
}
