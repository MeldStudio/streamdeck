// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { MeldAction } from "./base.js";

/** Records a 90-second clip to disk. Stateless. */
@action({ UUID: "co.meldstudio.streamdeck.clip" })
export class Clip extends MeldAction {
	/** Nothing to render — the key has a single, static state. */
	protected render(): void {}

	/** @inheritdoc */
	override onKeyUp(_ev: KeyUpEvent): void {
		this.meld.meld?.sendCommand?.("meld.recordClip");
	}
}
