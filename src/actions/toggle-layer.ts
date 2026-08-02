// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action } from "@elgato/streamdeck";

import type { MeldSession } from "../meld/index.js";
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
		const layer = session.getLayer(settings.layer);
		return layer ? layer.visible : null;
	}

	protected toggle(settings: ToggleLayerSettings): void {
		if (settings.scene && settings.layer) {
			this.meld.meld?.toggleLayer?.(settings.scene, settings.layer);
		}
	}
}
