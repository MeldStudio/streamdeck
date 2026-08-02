// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action } from "@elgato/streamdeck";

import type { MeldSession } from "../meld/index.js";
import { SessionToggleAction } from "./session-toggle.js";

/** Settings for {@link ToggleMute}. */
type ToggleMuteSettings = {
	track?: string;
	action?: string;
};

/** Toggles (or forces) an audio track's mute state. */
@action({ UUID: "co.meldstudio.streamdeck.toggle-mute" })
export class ToggleMute extends SessionToggleAction<ToggleMuteSettings> {
	// When the track is gone, the manifest's "unmuted" state (1) is shown.
	protected readonly missingItemState = 1;
	protected readonly forceOnValue = "mute";

	protected isConfigured(settings: ToggleMuteSettings): boolean {
		return !!settings.track;
	}

	protected mode(settings: ToggleMuteSettings): string | undefined {
		return settings.action;
	}

	protected currentValue(settings: ToggleMuteSettings, session: MeldSession): boolean | null {
		const track = session.getTrack(settings.track);
		return track ? track.muted : null;
	}

	/** State 0 = muted, state 1 = unmuted. */
	protected override valueToKeyState(muted: boolean): 0 | 1 {
		return muted ? 0 : 1;
	}

	protected toggle(settings: ToggleMuteSettings): void {
		if (settings.track) {
			this.meld.meld?.toggleMute?.(settings.track);
		}
	}

	protected override setDirect(settings: ToggleMuteSettings, desired: boolean): boolean {
		const meld = this.meld.meld;
		if (!settings.track) {
			return false;
		}
		if (meld?.setMuted) {
			meld.setMuted(settings.track, desired);
			return true;
		}
		if (meld?.setProperty) {
			meld.setProperty(settings.track, "muted", desired);
			return true;
		}
		return false;
	}
}
