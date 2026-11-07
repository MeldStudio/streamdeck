// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { MeldAction } from "./base.js";

/** Settings for {@link Clip}. */
type ClipSettings = {
	clipDuration?: string | number | null;
};

const DEFAULT_CLIP_DURATION = 90;
const MAX_CLIP_DURATION = 120;

/** Records a configurable-duration clip to disk. */
@action({ UUID: "co.meldstudio.streamdeck.clip" })
export class Clip extends MeldAction<ClipSettings> {
	protected override migrateSettings(settings: ClipSettings): ClipSettings {
		const clipDuration = String(this.#duration(settings.clipDuration));
		if (settings.clipDuration === clipDuration) {
			return settings;
		}
		return { ...settings, clipDuration };
	}

	/** Nothing to render — the key has a single, static state. */
	protected render(): void {}

	/** @inheritdoc */
	override onKeyUp(ev: KeyUpEvent<ClipSettings>): void {
		const meld = this.meld.meld;
		const settings = this.settingsFor(ev.action.id) ?? ev.payload.settings;
		const duration = this.#duration(settings.clipDuration);
		if (meld?.sendCommandWithArgs) {
			meld.sendCommandWithArgs("meld.recordClip", [duration]);
		} else {
			// Older API v3 builds only support the argument-less maximum clip.
			meld?.sendCommand?.("meld.recordClip");
		}
	}

	/** Normalizes user input to Meld's advertised finite 0–120 second range. */
	#duration(value: string | number | null | undefined): number {
		const parsed = value == null || (typeof value === "string" && value.trim() === "") ? Number.NaN : Number(value);
		if (!Number.isFinite(parsed)) {
			return DEFAULT_CLIP_DURATION;
		}
		return Math.min(MAX_CLIP_DURATION, Math.max(0, parsed));
	}
}
