// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import type { IdentifiedItem, LayerItem, MeldSession } from "../meld/index.js";
import { MeldAction, type RenderArgs } from "./base.js";
import { OptimisticStore } from "./optimistic.js";

/** Settings for {@link Media}. */
type MediaSettings = {
	scene?: string;
	layer?: string;
	action?: string;
};

const ICON_PLAY = "assets/Media/Key Icon/media-controls-play";
const ICON_PAUSE = "assets/Media/Key Icon/media-controls-pause";
const ICON_RESTART = "assets/Media/Key Icon/media-controls-skip-back";

/**
 * How long a press keeps precedence over the snapshot. Meld republishes the
 * session behind a retriggerable autosave, so the confirmation is slower than a
 * gain echo; this outlasts it while still self-correcting a press that never
 * took effect.
 */
const MEDIA_CONFIRM_TTL_MS = 3_000;

/** Controls playback of a media layer (play / pause / restart / toggle). */
@action({ UUID: "co.meldstudio.streamdeck.media" })
export class Media extends MeldAction<MediaSettings> {
	/**
	 * Playback state a press is waiting on, until the snapshot catches up. Meld
	 * republishes behind a debounced autosave, so without this a second press
	 * would recompute from the same stale value.
	 */
	readonly #optimisticPlaying = new OptimisticStore<boolean>(MEDIA_CONFIRM_TTL_MS, () =>
		void this.renderAll("sessionChanged"),
	);

	/** Reflects the media layer's playback state on the key. */
	protected async render({ action, settings, session, reason }: RenderArgs<MediaSettings>): Promise<void> {
		// With no snapshot there is nothing authoritative to show; keep the last
		// icon rather than flashing "paused" through a reconnect blip. A settings
		// change is different: the user just chose a different press mode, and for
		// the fixed-icon modes that choice alone determines the artwork, so the key
		// must not stay showing the previous mode until Meld comes back.
		if (!session.isPresent && reason !== "willAppear" && reason !== "didReceiveSettings") {
			return;
		}
		const layer = this.#findMediaLayer(settings, session);
		if (layer && this.#optimisticPlaying.get(action.id) === layer.isPlaying) {
			// The snapshot caught up with the press; stop overriding it.
			this.#optimisticPlaying.clear(action.id);
		}
		const playing = this.#optimisticPlaying.get(action.id) ?? layer?.isPlaying ?? false;
		await this.setKeyImage(action, this.#iconFor(settings.action, playing));
	}

	/** @inheritdoc */
	protected override onDisappear(context: string): void {
		this.#optimisticPlaying.clear(context);
	}

	/** @inheritdoc */
	protected override onSettingsChanged({
		action,
		settings,
		previous,
	}: RenderArgs<MediaSettings> & { previous: MediaSettings | undefined }): void {
		// A pending press belongs to the layer that was configured when it was
		// made; applying it to a newly chosen layer would show the inverse of that
		// clip's real state and send the wrong command next.
		if (previous !== undefined && previous.layer !== settings.layer) {
			this.#optimisticPlaying.clear(action.id);
		}
	}

	/** @inheritdoc */
	override async onKeyUp(ev: KeyUpEvent<MediaSettings>): Promise<void> {
		const settings = ev.payload.settings;
		const layer = this.#findMediaLayer(settings, this.session());
		const meld = this.meld.meld;

		switch (settings.action) {
			case "play":
				await this.setKeyImage(ev.action, ICON_PLAY);
				if (layer) {
					meld?.callFunction?.(layer.id, "play");
				}
				break;
			case "pause":
				await this.setKeyImage(ev.action, ICON_PAUSE);
				if (layer) {
					meld?.callFunction?.(layer.id, "pause");
				}
				break;
			case "restart":
				await this.setKeyImage(ev.action, ICON_RESTART);
				if (layer) {
					// `skipBack` is what Meld's own restart control uses: it returns to
					// the loop's start point on a trimmed clip, where seekTo(0) would
					// jump outside the configured region.
					meld?.callFunction?.(layer.id, "skipBack");
				}
				break;
			default: {
				// "toggle" (and unset): play when paused, pause when playing.
				if (!layer) {
					return;
				}
				// `isPlaying` comes from the session snapshot, which Meld only
				// republishes behind its autosave debounce. Two presses inside that
				// window would both read the pre-press value and send the same command
				// twice, so the pending intent takes precedence.
				const playing = this.#optimisticPlaying.get(ev.action.id) ?? layer.isPlaying;
				this.#optimisticPlaying.set(ev.action.id, !playing);
				await this.setKeyImage(ev.action, this.#iconFor(settings.action, !playing));
				meld?.callFunction?.(layer.id, playing ? "pause" : "play");
				break;
			}
		}
	}

	/** The image for a given press mode and playback state. */
	#iconFor(mediaAction: string | undefined, isPlaying: boolean): string {
		switch (mediaAction) {
			case "restart":
				return ICON_RESTART;
			case "play":
				return ICON_PLAY;
			case "pause":
				return ICON_PAUSE;
			default:
				return isPlaying ? ICON_PAUSE : ICON_PLAY;
		}
	}

	/**
	 * Resolves the configured media layer.
	 *
	 * The layer id alone identifies it, and that is all Meld needs:
	 * `callFunction` resolves the object by id and never consults a scene. The
	 * stored scene is not required to match, because an upgraded profile can hold
	 * one from a previous selection — the same tolerance toggle-layer and
	 * toggle-effect apply, so the key keeps working instead of going inert.
	 * @param settings The action's settings.
	 * @param session The session to resolve against.
	 */
	#findMediaLayer(settings: MediaSettings, session: MeldSession): IdentifiedItem<LayerItem> | undefined {
		const { scene, layer } = settings;
		if (!scene || !layer) {
			return undefined;
		}
		const item = session.getLayer(layer);
		if (!item || !item.mediaSource) {
			return undefined;
		}
		return item;
	}
}
