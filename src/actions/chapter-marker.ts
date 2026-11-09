// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { MeldAction, type RenderArgs } from "./base.js";

/** The Meld command registered for "Recording: Add Chapter Marker". */
export const CHAPTER_MARKER_COMMAND = "meld.insertRecordingChapterMarker";

/**
 * Inserts a chapter marker into every active recording.
 *
 * Meld only honours the command while recording (the command action is disabled
 * otherwise), so the key reflects the recording state: state 0 while a marker
 * can be added, state 1 while there is no recording to mark.
 */
@action({ UUID: "co.meldstudio.streamdeck.chapter-marker" })
export class ChapterMarker extends MeldAction {
	/** Reflects whether a marker can currently be added (state 0 = recording). */
	protected async render({ action, reason }: RenderArgs<JsonObject>): Promise<void> {
		// While disconnected there is nothing authoritative to show; keep the last
		// state rather than flashing "not recording" on a connection blip.
		if (!this.meld.ready && reason !== "willAppear") {
			return;
		}
		await this.setKeyState(action, this.isRecording ? 0 : 1);
	}

	/** @inheritdoc */
	override onKeyUp(_ev: KeyUpEvent): void {
		// Meld is authoritative about whether a recording is active: the command is
		// a no-op there when nothing is recording, so the press is always forwarded
		// rather than second-guessed from a possibly stale local flag.
		this.meld.meld?.sendCommand?.(CHAPTER_MARKER_COMMAND);
	}
}
