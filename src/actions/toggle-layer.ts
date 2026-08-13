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
	protected readonly missingItemState = 1;
	protected readonly forceOnValue = "show";

	protected targetOf(settings: ToggleLayerSettings): string | undefined {
		return settings.layer;
	}

	protected isConfigured(settings: ToggleLayerSettings): boolean {
		// The layer id is the durable target. Its parent can be reconstructed from
		// the session when an old inspector left the stored chain incomplete.
		return !!settings.layer;
	}

	protected mode(settings: ToggleLayerSettings): string | undefined {
		return settings.action;
	}

	protected override migrateSettings(settings: ToggleLayerSettings, session: MeldSession): ToggleLayerSettings {
		let migrated = super.migrateSettings(settings, session);
		const layer = session.getLayer(migrated.layer);
		if (layer && migrated.scene !== layer.parent) {
			migrated = { ...migrated, scene: layer.parent };
		}
		return migrated;
	}

	protected currentValue(settings: ToggleLayerSettings, session: MeldSession): boolean | null {
		// The layer id alone identifies the target. Legacy profiles can hold a
		// scene from a previous selection alongside it; the layer must keep working
		// across the upgrade, so the stored scene is not required to match.
		const layer = session.getLayer(settings.layer);
		return layer ? layer.visible : null;
	}

	protected toggle(settings: ToggleLayerSettings): void {
		if (!settings.layer) {
			return;
		}
		// The layer's real parent from the session is authoritative, so Meld is
		// never sent a mismatched scene/layer pair even for stale stored scenes.
		const layer: IdentifiedItem<LayerItem> | undefined = this.session().getLayer(settings.layer);
		const sceneId = layer?.parent ?? settings.scene;
		if (sceneId) {
			this.meld.meld?.toggleLayer?.(sceneId, settings.layer);
		}
	}
}
