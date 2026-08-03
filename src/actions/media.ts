// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import type { IdentifiedItem, LayerItem, MeldSession } from "../meld/index.js";
import { MeldAction, type RenderArgs } from "./base.js";

/** Settings for {@link Media}. */
type MediaSettings = {
	scene?: string;
	layer?: string;
	action?: string;
};

const ICON_PLAY = "assets/Media/Key Icon/media-controls-play";
const ICON_PAUSE = "assets/Media/Key Icon/media-controls-pause";
const ICON_RESTART = "assets/Media/Key Icon/media-controls-skip-back";

/** Controls playback of a media layer (play / pause / restart / toggle). */
@action({ UUID: "co.meldstudio.streamdeck.media" })
export class Media extends MeldAction<MediaSettings> {
	/** Reflects the media layer's playback state on the key. */
	protected async render({ action, settings, session, reason }: RenderArgs<MediaSettings>): Promise<void> {
		// With no snapshot there is nothing authoritative to show; keep the last
		// icon rather than flashing "paused" through a reconnect blip.
		if (!session.isPresent && reason !== "willAppear") {
			return;
		}
		const layer = this.#findMediaLayer(settings, session);
		await this.setKeyImage(action, this.#iconFor(settings.action, layer?.isPlaying ?? false));
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
					meld?.callFunctionWithArgs?.(layer.id, "seekTo", [0]);
				}
				break;
			default:
				// "toggle" (and unset): play when paused, pause when playing.
				if (!layer) {
					return;
				}
				if (layer.isPlaying) {
					await this.setKeyImage(ev.action, this.#iconFor(settings.action, false));
					meld?.callFunction?.(layer.id, "pause");
				} else {
					await this.setKeyImage(ev.action, this.#iconFor(settings.action, true));
					meld?.callFunction?.(layer.id, "play");
				}
				break;
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

	/** Resolves the configured media layer, verifying it belongs to the scene. */
	#findMediaLayer(settings: MediaSettings, session: MeldSession): IdentifiedItem<LayerItem> | undefined {
		const { scene, layer } = settings;
		if (!scene || !layer) {
			return undefined;
		}
		const item = session.getLayer(layer);
		if (!item || item.parent !== scene || !item.mediaSource) {
			return undefined;
		}
		return item;
	}
}
