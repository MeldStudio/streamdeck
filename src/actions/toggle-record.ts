// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { MeldAction, type RenderArgs } from "./base.js";

/** Starts or stops recording, reflecting Meld's authoritative recording state. */
@action({ UUID: "co.meldstudio.streamdeck.toggle-record" })
export class ToggleRecord extends MeldAction {
	/** Reflects the current recording state on the key (state 1 = recording). */
	protected render({ action }: RenderArgs<JsonObject>): Promise<void> {
		return this.setKeyState(action, this.isRecording ? 1 : 0);
	}

	/** @inheritdoc */
	override onKeyUp(_ev: KeyUpEvent): void {
		this.meld.meld?.toggleRecord?.();
	}
}
