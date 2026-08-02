// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type DialDownEvent, type DialRotateEvent, type KeyUpEvent, type TouchTapEvent } from "@elgato/streamdeck";

import type { IdentifiedItem, TrackItem } from "../meld/index.js";
import { MeldAction, type RenderArgs } from "./base.js";
import { toDb, toGain } from "./gain.js";
import { OptimisticStore } from "./optimistic.js";

/** Settings for {@link VolumeStepper}. */
type VolumeStepperSettings = {
	track?: string;
	stepsize?: string;
	metertype?: string;
};

const AUDIO_ICON = "assets/Audio Track/Mute_Unmute Audio Track/Action Icons/audioTrack";
const AUDIO_ICON_40 = "assets/Audio Track/Mute_Unmute Audio Track/Action Icons/audioUnmuted40";
const AUDIO_ICON_MUTE = "assets/Audio Track/Mute_Unmute Audio Track/Action Icons/audioMute";

/** The resolved display state for a track. */
type TrackDisplay = {
	gain?: number;
	muted: boolean;
	monitoring: boolean;
	name?: string;
};

/**
 * Stream Deck+ dial that adjusts an audio track's volume, with tap-to-set and
 * push-to-mute.
 *
 * This is the action the whole refactor was motivated by. The desync is fixed by
 * two things working together:
 *  - the shared {@link MeldConnection} re-registers this dial's track observer on
 *    every reconnect, so live gain updates never silently stop; and
 *  - an {@link OptimisticStore} shows the user's rotation immediately but always
 *    yields to Meld's authoritative `gainUpdated` value, which clears it.
 */
@action({ UUID: "co.meldstudio.streamdeck.volume-stepper" })
export class VolumeStepper extends MeldAction<VolumeStepperSettings> {
	/** Optimistic gain per context, cleared as soon as Meld confirms. */
	readonly #optimisticGain = new OptimisticStore<number>();

	/** Latest authoritative gain/mute per track id, from `gainUpdated`. */
	readonly #trackGain = new Map<string, { gain: number; muted: boolean }>();

	constructor() {
		super();
		this.meld.on("gainChanged", ({ trackId, gain, muted }) => {
			this.#trackGain.set(trackId, { gain, muted });
			// Authoritative value: drop the optimistic guess and repaint any dial on
			// this track.
			for (const action of this.actions) {
				const settings = this.settingsFor(action.id);
				if (settings?.track !== trackId) {
					continue;
				}
				this.#optimisticGain.clear(action.id);
				const item = this.session().getTrack(trackId);
				void this.#renderFeedback(action, settings, this.#resolve(action.id, trackId, item));
			}
		});
	}

	/** @inheritdoc */
	override onDialRotate(ev: DialRotateEvent<VolumeStepperSettings>): void {
		const { track, stepsize, metertype } = ev.payload.settings;
		if (!track) {
			return;
		}
		const usePercent = metertype === "percent";
		const step = Number.parseFloat(stepsize ?? "");
		const offset = (Number.isFinite(step) ? step : 0) * ev.payload.ticks;

		let gain = this.#currentGain(ev.action.id, track) ?? 0;
		if (usePercent) {
			gain = Math.min(1, Math.max(0, gain + 0.01 * offset));
		} else {
			gain = toGain(toDb(gain) + offset);
		}

		this.#applyGain(ev.action, ev.payload.settings, track, gain);
	}

	/** @inheritdoc */
	override onDialDown(ev: DialDownEvent<VolumeStepperSettings>): void {
		const track = ev.payload.settings.track;
		if (track) {
			this.meld.meld?.toggleMute?.(track);
		}
	}

	/** @inheritdoc */
	override onKeyUp(ev: KeyUpEvent<VolumeStepperSettings>): void {
		const track = ev.payload.settings.track;
		if (track) {
			this.meld.meld?.toggleMute?.(track);
		}
	}

	/** @inheritdoc */
	override onTouchTap(ev: TouchTapEvent<VolumeStepperSettings>): void {
		if (ev.payload.hold) {
			return;
		}
		const track = ev.payload.settings.track;
		if (!track) {
			return;
		}

		const x = ev.payload.tapPos[0];
		// The indicator bar spans x≈80..180; taps there set the volume directly.
		if (x > 80) {
			if (x > 180) {
				return;
			}
			this.#applyGain(ev.action, ev.payload.settings, track, (x - 80) / 100);
		} else {
			this.meld.meld?.toggleMonitor?.(track);
		}
	}

	/** @inheritdoc */
	protected override onDisappear(context: string): void {
		this.meld.unregisterTrackObserver(context);
		this.#optimisticGain.clear(context);
	}

	/** @inheritdoc */
	protected async render({ action, settings, session, reason }: RenderArgs<VolumeStepperSettings>): Promise<void> {
		const track = settings.track;
		if (!track) {
			this.meld.unregisterTrackObserver(action.id);
			await this.#renderFeedback(action, settings, { muted: true, monitoring: false });
			return;
		}

		// Only touch the observer registry while connected; leaving it intact while
		// disconnected is what lets the connection re-register it on reconnect.
		if (this.meld.ready) {
			if (session.has(track)) {
				this.meld.registerTrackObserver(action.id, track);
			} else {
				this.meld.unregisterTrackObserver(action.id);
			}
		}

		if (reason === "closed") {
			// Keep the last painted feedback rather than flashing on a blip.
			return;
		}

		await this.#renderFeedback(action, settings, this.#resolve(action.id, track, session.getTrack(track)));
	}

	/** Optimistically sets a new gain, paints it, and sends it to Meld. */
	#applyGain(
		action: RenderArgs<VolumeStepperSettings>["action"],
		settings: VolumeStepperSettings,
		track: string,
		gain: number,
	): void {
		this.#optimisticGain.set(action.id, gain);
		this.meld.meld?.setGain?.(track, gain);
		const item = this.session().getTrack(track);
		void this.#renderFeedback(action, settings, { ...this.#resolve(action.id, track, item), gain });
	}

	/** The best-known gain for a context: optimistic first, then the observer cache. */
	#currentGain(context: string, track: string): number | undefined {
		return this.#optimisticGain.get(context) ?? this.#trackGain.get(track)?.gain;
	}

	/** Merges optimistic gain, the observer cache, and the session snapshot. */
	#resolve(context: string, track: string, item: IdentifiedItem<TrackItem> | undefined): TrackDisplay {
		const cached = this.#trackGain.get(track);
		return {
			gain: this.#optimisticGain.get(context) ?? cached?.gain,
			muted: item?.muted ?? cached?.muted ?? true,
			monitoring: item?.monitoring ?? false,
			name: item?.name,
		};
	}

	/** Renders the dial's touchscreen feedback for the given display state. */
	#renderFeedback(
		action: RenderArgs<VolumeStepperSettings>["action"],
		settings: VolumeStepperSettings,
		display: TrackDisplay,
	): Promise<void> {
		const usePercent = settings.metertype === "percent";
		const { gain, muted, name } = display;
		const hasGain = Number.isFinite(gain);

		let volume: string;
		let barValue: number;
		if (!hasGain) {
			volume = "--";
			barValue = 0;
		} else if (usePercent) {
			volume = `${Math.trunc((gain as number) * 100)}%`;
			barValue = gain as number;
		} else {
			const dB = toDb(gain as number);
			volume = dB === -60 ? "-∞ dB" : `${Math.round(dB)} dB`;
			barValue = (dB + 60) / 60;
		}

		let icon = AUDIO_ICON_MUTE;
		if (!muted && hasGain) {
			if ((gain as number) > 0.4) {
				icon = AUDIO_ICON;
			} else if ((gain as number) > 0) {
				icon = AUDIO_ICON_40;
			}
		}

		return this.asDial(action).setFeedback({
			icon,
			title: name ?? "Adjust Volume",
			value: volume,
			indicator: {
				value: barValue * 100,
				enabled: true,
				bar_bg_c: muted || !hasGain ? "0:#666666,1:#666666" : "0:#6DDE92,1:#6DDE92",
			},
		});
	}
}
