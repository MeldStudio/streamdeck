// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action } from "@elgato/streamdeck";

import type { MeldSession } from "../meld/index.js";
import { SessionToggleAction } from "./session-toggle.js";

/** Settings for {@link ToggleMonitor}. */
type ToggleMonitorSettings = {
	track?: string;
	action?: string;
};

/** Toggles (or forces) an audio track's monitoring (cue) state. */
@action({ UUID: "co.meldstudio.streamdeck.toggle-monitor" })
export class ToggleMonitor extends SessionToggleAction<ToggleMonitorSettings> {
	protected readonly missingItemState = 0;
	protected readonly forceOnValue = "cue";

	protected isConfigured(settings: ToggleMonitorSettings): boolean {
		return !!settings.track;
	}

	protected mode(settings: ToggleMonitorSettings): string | undefined {
		return settings.action;
	}

	protected currentValue(settings: ToggleMonitorSettings, session: MeldSession): boolean | null {
		const track = session.getTrack(settings.track);
		return track ? track.monitoring : null;
	}

	protected toggle(settings: ToggleMonitorSettings): void {
		if (settings.track) {
			this.meld.meld?.toggleMonitor?.(settings.track);
		}
	}

	protected override setDirect(settings: ToggleMonitorSettings, desired: boolean): boolean {
		const meld = this.meld.meld;
		if (!settings.track) {
			return false;
		}
		if (meld?.setProperty) {
			meld.setProperty(settings.track, "monitoring", desired);
			return true;
		}
		return false;
	}
}
