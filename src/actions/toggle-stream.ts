// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { MeldAction, type RenderArgs } from "./base.js";

/** Goes live or offline, reflecting Meld's authoritative streaming state. */
@action({ UUID: "co.meldstudio.streamdeck.toggle-stream" })
export class ToggleStream extends MeldAction {
	/** Reflects the current streaming state on the key (state 1 = live). */
	protected render({ action }: RenderArgs<JsonObject>): Promise<void> {
		return this.setKeyState(action, this.isStreaming ? 1 : 0);
	}

	/** @inheritdoc */
	override onKeyUp(_ev: KeyUpEvent): void {
		this.meld.meld?.toggleStream?.();
	}
}
