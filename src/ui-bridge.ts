// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import streamDeck from "@elgato/streamdeck";
import type { JsonValue } from "@elgato/utils";

import { meld } from "./meld/index.js";

/** Event name property inspectors send to request the current session. */
const GET_SESSION = "meld.getSession";
/** Event name the plugin uses to push session snapshots to a property inspector. */
const SESSION = "meld.session";

/**
 * Bridges Meld session data to the property inspectors.
 *
 * In the old plugin every property inspector opened its own QWebChannel
 * connection to Meld, which is a primary cause of the state drift this refactor
 * removes. Here the property inspectors hold no Meld connection at all: they ask
 * the plugin for the session over Stream Deck's PI↔plugin channel, and the
 * plugin — the single source of truth — answers and pushes live updates.
 */
export function registerUiBridge(): void {
	const push = (): void => {
		// The session items are plain JSON at runtime; assert that for the typed API.
		const payload = {
			event: SESSION,
			connected: meld.ready,
			items: meld.session?.items ?? {},
		} as unknown as JsonValue;
		void streamDeck.ui.sendToPropertyInspector(payload);
	};

	// Answer explicit requests from a property inspector.
	streamDeck.ui.onSendToPlugin((ev) => {
		const payload = ev.payload as { event?: string } | undefined;
		if (payload?.event === GET_SESSION) {
			push();
		}
	});

	// Send a fresh snapshot whenever a property inspector opens...
	streamDeck.ui.onDidAppear(() => push());

	// ...and whenever the authoritative state changes while one is open.
	meld.on("ready", push);
	meld.on("closed", push);
	meld.on("sessionChanged", push);
}
