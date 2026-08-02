// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { MeldAction } from "./base.js";

/** Takes a screenshot in Meld Studio. Stateless. */
@action({ UUID: "co.meldstudio.streamdeck.screenshot" })
export class Screenshot extends MeldAction {
	/** Nothing to render — the key has a single, static state. */
	protected render(): void {}

	/** @inheritdoc */
	override onKeyUp(_ev: KeyUpEvent): void {
		const meld = this.meld.meld;
		if (meld?.sendCommand) {
			meld.sendCommand("meld.screenshot");
		} else if (meld?.sendEvent) {
			// Backwards compatibility with older Meld builds.
			meld.sendEvent("co.meldstudio.events.screenshot");
		}
	}
}
