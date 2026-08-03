// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import type { MeldSession, TrackItem } from "../meld/index.js";
import { MeldAction, type RenderArgs } from "./base.js";
import { toDb, toGain } from "./gain.js";

/** Settings for {@link Replay}. */
type ReplaySettings = {
	action?: string;
};

/** Resolved state of the replay clip's audio track. */
type ReplayState = {
	layerId?: string;
	trackId?: string;
	muted: boolean;
	monitoring: boolean;
	/** Undefined until Meld reports the track's gain via `gainUpdated`. */
	gain?: number;
};

const VOLUME_STEP_DB = 3;

/** Observer context id used to follow the replay track's gain. */
const GAIN_OBSERVER_CONTEXT = "replay-gain";

/** Controls the replay clip: show/dismiss, mute/cue, and volume. */
@action({ UUID: "co.meldstudio.streamdeck.replay" })
export class Replay extends MeldAction<ReplaySettings> {
	/** Latest resolved replay-track state, refreshed on every render. */
	#replay: ReplayState = { muted: true, monitoring: false };

	/** Authoritative gain per track id, from `gainUpdated`. */
	readonly #trackGain = new Map<string, number>();

	constructor() {
		super();
		this.meld.on("gainChanged", ({ trackId, gain, muted }) => {
			this.#trackGain.set(trackId, gain);
			if (this.#replay.trackId === trackId) {
				this.#replay.muted = muted;
			}
		});
		// Gain is never part of the session snapshot, so a stale cache would
		// otherwise outlive the instance that produced it.
		this.meld.on("closed", () => this.#trackGain.clear());
	}

	/** Reflects the configured replay control's icon (derived from replay state). */
	protected render({ action, settings, session }: RenderArgs<ReplaySettings>): Promise<void> {
		this.#replay = this.#deriveReplay(session);
		// Observe the replay track so its gain is known before the user adjusts it;
		// registering yields an immediate `gainUpdated` from Meld.
		if (this.meld.ready) {
			if (this.#replay.trackId) {
				this.meld.registerTrackObserver(GAIN_OBSERVER_CONTEXT, this.#replay.trackId);
			} else {
				this.meld.unregisterTrackObserver(GAIN_OBSERVER_CONTEXT);
			}
		}
		return this.setKeyImage(action, this.#iconFor(settings.action));
	}

	/** @inheritdoc */
	override async onKeyUp(ev: KeyUpEvent<ReplaySettings>): Promise<void> {
		const replayAction = ev.payload.settings.action || "replay";
		const meld = this.meld.meld;
		const { trackId, layerId, gain } = this.#replay;

		switch (replayAction) {
			case "replay":
				if (!layerId) {
					meld?.sendCommand?.("meld.replay.show");
				}
				break;
			case "dismiss":
				meld?.sendCommand?.("meld.replay.dismiss");
				break;
			case "toggle":
				if (trackId) {
					meld?.toggleMute?.(trackId);
				}
				break;
			case "mute":
				if (trackId && meld?.setMuted) {
					meld.setMuted(trackId, true);
					this.#replay.muted = true;
				}
				break;
			case "unmute":
				if (trackId && meld?.setMuted) {
					meld.setMuted(trackId, false);
					this.#replay.muted = false;
				}
				break;
			case "toggle_cue":
				if (trackId) {
					meld?.toggleMonitor?.(trackId);
				}
				break;
			case "cue":
				if (trackId && meld?.setProperty) {
					meld.setProperty(trackId, "monitoring", true);
					this.#replay.monitoring = true;
				}
				break;
			case "uncue":
				if (trackId && meld?.setProperty) {
					meld.setProperty(trackId, "monitoring", false);
					this.#replay.monitoring = false;
				}
				break;
			case "volume_up":
			case "volume_down":
				// Without a known gain, stepping would start from an assumed 0 and
				// slam the track to silence instead of nudging it.
				if (trackId && gain !== undefined) {
					const step = replayAction === "volume_up" ? VOLUME_STEP_DB : -VOLUME_STEP_DB;
					const next = toGain(toDb(gain) + step);
					this.#trackGain.set(trackId, next);
					meld?.setGain?.(trackId, next);
				}
				break;
		}

		// Repaint immediately in case an optimistic mute/cue changed the icon.
		await this.setKeyImage(ev.action, this.#iconFor(ev.payload.settings.action));
	}

	/** Finds the replay clip's audio track and its current state in the session. */
	#deriveReplay(session: MeldSession): ReplayState {
		const track = session.find((item) => item.type === "track" && item.name === "Replay Clip");
		if (!track) {
			return { muted: true, monitoring: false };
		}
		const t = track as TrackItem & { id: string };
		return {
			layerId: t.parent,
			trackId: t.id,
			muted: t.muted,
			monitoring: t.monitoring,
			gain: this.#trackGain.get(t.id),
		};
	}

	/** Chooses the key image for a replay control based on the current state. */
	#iconFor(replayAction: string | undefined): string {
		switch (replayAction) {
			case "mute":
				return "assets/ReplayMute/replay-clip-muted";
			case "unmute":
				return "assets/ReplayMute/replay-clip-unmuted";
			case "toggle":
				return this.#replay.muted
					? "assets/ReplayMute/replay-clip-muted"
					: "assets/ReplayMute/replay-clip-unmuted";
			case "cue":
				return "assets/ReplayCUE/on";
			case "uncue":
				return "assets/ReplayCUE/off";
			case "toggle_cue":
				return this.#replay.monitoring ? "assets/ReplayCUE/on" : "assets/ReplayCUE/off";
			case "volume_up":
				return "assets/ReplayVolume/replay-clip-volumeUp";
			case "volume_down":
				return "assets/ReplayVolume/replay-clip-volumeDown";
			case "dismiss":
				return "assets/Replay/Key Icon/dismiss-clip-controls";
			default:
				return "assets/Replay/Key Icon/replay-clip-controls";
		}
	}
}
