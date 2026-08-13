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
	protected readonly missingItemState = 1;
	protected readonly forceOnValue = "show";

	protected targetOf(settings: ToggleEffectSettings): string | undefined {
		return settings.effect;
	}

	protected isConfigured(settings: ToggleEffectSettings): boolean {
		// StreamDeckMapper publishes stable effect ids. Parent fields can be
		// reconstructed from the effect in the live session.
		return !!settings.effect;
	}

	protected mode(settings: ToggleEffectSettings): string | undefined {
		return settings.action;
	}

	protected override migrateSettings(settings: ToggleEffectSettings, session: MeldSession): ToggleEffectSettings {
		let migrated = super.migrateSettings(settings, session);
		const effect = this.#resolveEffect(migrated, session);
		const layerId = effect?.parent;
		const sceneId = session.getLayer(layerId)?.parent;
		if (
			effect &&
			layerId &&
			sceneId &&
			(migrated.effect !== effect.id || migrated.layer !== layerId || migrated.scene !== sceneId)
		) {
			migrated = { ...migrated, scene: sceneId, layer: layerId, effect: effect.id };
		}
		return migrated;
	}

	protected currentValue(settings: ToggleEffectSettings, session: MeldSession): boolean | null {
		// The stable effect id alone identifies the target. A stale scene/layer from
		// previous selections must not hide its authoritative state.
		const effect = this.#resolveEffect(settings, session);
		return effect ? effect.enabled : null;
	}

	protected toggle(settings: ToggleEffectSettings): void {
		if (!settings.effect) {
			return;
		}
		const session = this.session();
		const effect = this.#resolveEffect(settings, session);
		if (!effect) {
			// Never forward an id absent from the current mapper snapshot. It belongs
			// to another project/process and Meld would silently discard it.
			return;
		}
		// The session's real parent chain is authoritative, so Meld is never sent
		// a mismatched triple even for stale stored scene/layer ids.
		const layerId = effect.parent;
		const sceneId = session.getLayer(layerId)?.parent ?? settings.scene;
		if (sceneId) {
			this.meld.meld?.toggleEffect?.(sceneId, layerId, effect.id);
		}
	}

	/**
	 * Resolves either a stable mapper id or the historical `<layerId>-<index>`
	 * settings form. Indexed settings are immediately migrated to the stable id;
	 * commands are never sent to Meld with the indexed form. The one-time indexed
	 * lookup intentionally uses the currently serialized effect order: old indexes
	 * were never stable across reorders, but resolving the present index is the
	 * required upgrade behavior before persisting the resulting mapper id.
	 */
	#resolveEffect(settings: ToggleEffectSettings, session: MeldSession) {
		const direct = session.getEffect(settings.effect);
		if (direct || !settings.effect) {
			return direct;
		}

		const separator = settings.effect.lastIndexOf("-");
		if (separator <= 0) {
			return undefined;
		}
		const layerId = settings.effect.slice(0, separator);
		const indexText = settings.effect.slice(separator + 1);
		if (!/^\d+$/.test(indexText) || !session.getLayer(layerId)) {
			return undefined;
		}
		return session.effects(layerId)[Number.parseInt(indexText, 10)];
	}
}
