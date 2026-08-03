// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import streamDeck, {
	action,
	type DialDownEvent,
	type DialRotateEvent,
	type KeyUpEvent,
	type TouchTapEvent,
} from "@elgato/streamdeck";

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
/**
 * Two gains within this distance are the same value: an update this close to the
 * pending optimistic gain is the echo confirming it. This only needs to absorb
 * float serialization noise on the Meld round-trip — it must stay far below the
 * smallest per-tick gain delta (≈1e-5 at -60 dB with a 0.1 dB step), or an echo
 * of an older write could be mistaken for confirmation of a newer one.
 */
const GAIN_EPSILON = 1e-7;

@action({ UUID: "co.meldstudio.streamdeck.volume-stepper" })
export class VolumeStepper extends MeldAction<VolumeStepperSettings> {
	/**
	 * Optimistic gain per context, cleared as soon as Meld confirms. If it expires
	 * unconfirmed (write dropped, disconnect mid-rotation), repaint from
	 * authoritative state so the phantom value doesn't linger on the touchscreen.
	 */
	readonly #optimisticGain = new OptimisticStore<number>(undefined, (context) =>
		this.#repaintAuthoritative(context),
	);

	/** Latest authoritative gain/mute per track id, from `gainUpdated`. */
	readonly #trackGain = new Map<string, { gain: number; muted: boolean }>();

	constructor() {
		super();
		// The observer cache and any unconfirmed optimistic values are only valid
		// for the connection they were observed on: Meld emits gainUpdated solely on
		// change, so a value cached before a disconnect would otherwise mask the
		// fresh snapshot (and re-base rotations) after reconnect, even if the user
		// moved the fader in Meld while we were away.
		this.meld.on("closed", () => {
			this.#trackGain.clear();
			this.#optimisticGain.clearAll();
		});
		this.meld.on("gainChanged", ({ trackId, gain, muted }) => {
			this.#trackGain.set(trackId, { gain, muted });
			for (const action of this.actions) {
				const settings = this.settingsFor(action.id);
				if (settings?.track !== trackId) {
					continue;
				}
				// During a rotation Meld echoes each of our earlier setGain calls. An
				// echo of an OLDER write must not clobber a NEWER optimistic value —
				// that reverts the dial mid-rotation and loses ticks (the original
				// desync). Only treat the update as confirming the optimistic value
				// when it matches; otherwise keep the newer guess (a genuinely
				// external change still wins within one TTL via expiry repaint).
				const optimistic = this.#optimisticGain.get(action.id);
				if (optimistic !== undefined && Math.abs(optimistic - gain) > GAIN_EPSILON) {
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
		// A missing or blanked step size falls back to the inspector's default of 1;
		// 0 would silently turn the dial into a no-op.
		const step = Number.parseFloat(stepsize ?? "");
		const offset = (Number.isFinite(step) ? step : 1) * ev.payload.ticks;

		let gain = this.#currentGain(ev.action.id, track);
		if (gain === undefined) {
			// No authoritative gain known yet (dial shows "--"). Stepping from an
			// assumed 0 would slam a live track toward silence, so do nothing.
			return;
		}
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
	protected override onSettingsChanged({
		action,
		settings,
		previous,
	}: RenderArgs<VolumeStepperSettings> & { previous: VolumeStepperSettings | undefined }): void {
		if (previous?.track !== settings.track) {
			// A pending optimistic gain belongs to the previously bound track; never
			// apply or display it against the new one.
			this.#optimisticGain.clear(action.id);
			this.#dropCacheIfUnobserved(previous?.track, action.id);
		}
	}

	/** @inheritdoc */
	protected override onDisappear(context: string, settings: VolumeStepperSettings | undefined): void {
		this.meld.unregisterTrackObserver(context);
		this.#optimisticGain.clear(context);
		this.#dropCacheIfUnobserved(settings?.track, context);
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
		// Never paint a value that cannot reach Meld (e.g. tap-to-set mid-blip):
		// the send would silently no-op and the phantom gain would linger.
		if (!this.meld.ready) {
			return;
		}
		this.#optimisticGain.set(action.id, gain);
		this.meld.meld?.setGain?.(track, gain);
		const item = this.session().getTrack(track);
		void this.#renderFeedback(action, settings, { ...this.#resolve(action.id, track, item), gain });
	}

	/**
	 * The best-known gain for a context: optimistic first, then the observer
	 * cache, then the session snapshot (Meld only emits `gainUpdated` on change,
	 * so after a plugin restart the snapshot is the only source until the first
	 * change).
	 */
	#currentGain(context: string, track: string): number | undefined {
		return (
			this.#optimisticGain.get(context) ??
			this.#trackGain.get(track)?.gain ??
			this.session().getTrack(track)?.gain
		);
	}

	/** Merges optimistic gain, the observer cache, and the session snapshot. */
	#resolve(context: string, track: string, item: IdentifiedItem<TrackItem> | undefined): TrackDisplay {
		if (!item) {
			// The track is gone from the session (or there is no session): show the
			// unknown indicator rather than a stale cached gain.
			return { muted: true, monitoring: false };
		}
		const cached = this.#trackGain.get(track);
		return {
			gain: this.#optimisticGain.get(context) ?? cached?.gain ?? item.gain,
			// The gainUpdated fast path outruns full session updates, so the cache is
			// fresher than the snapshot for mute (mirroring the gain precedence).
			muted: cached?.muted ?? item.muted ?? true,
			monitoring: item.monitoring ?? false,
			name: item.name,
		};
	}

	/**
	 * Drops a track's observer-cache entry when no other visible context is bound
	 * to it. An unobserved track receives no `gainUpdated` events, so its cached
	 * value would silently go stale and outrank the fresher session snapshot if
	 * the track were bound again later.
	 */
	#dropCacheIfUnobserved(track: string | undefined, exceptContext: string): void {
		if (!track) {
			return;
		}
		for (const action of this.actions) {
			if (action.id !== exceptContext && this.settingsFor(action.id)?.track === track) {
				return;
			}
		}
		this.#trackGain.delete(track);
	}

	/** Repaints a context from authoritative state (no optimistic value). */
	#repaintAuthoritative(context: string): void {
		// While disconnected there is no authoritative state to restore; keep the
		// last painted feedback (the reconnect render repaints everything).
		if (!this.meld.ready) {
			return;
		}
		for (const action of this.actions) {
			if (action.id !== context) {
				continue;
			}
			const settings = this.settingsFor(action.id);
			const track = settings?.track;
			if (!settings || !track) {
				return;
			}
			void this.#renderFeedback(action, settings, this.#resolve(context, track, this.session().getTrack(track)));
			return;
		}
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
			// Round rather than truncate: float artifacts like 0.29*100 === 28.999…
			// would otherwise display one percent low.
			volume = `${Math.round((gain as number) * 100)}%`;
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

		return this.asDial(action)
			.setFeedback({
				icon,
				title: name ?? "Adjust Volume",
				value: volume,
				indicator: {
					value: barValue * 100,
					enabled: true,
					bar_bg_c: muted || !hasGain ? "0:#666666,1:#666666" : "0:#6DDE92,1:#6DDE92",
				},
			})
			.catch((err) => {
				streamDeck.logger.error(`Failed to set feedback for ${action.id}`, err);
			});
	}
}
