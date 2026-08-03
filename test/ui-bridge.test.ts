// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The property inspectors hold no Meld connection of their own — they ask the
// plugin for session data. If the bridge ever stops answering, every dropdown
// in every inspector silently goes empty, which looks like "Meld has no scenes"
// rather than a plugin fault. These tests pin the contract.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import streamDeck from "@elgato/streamdeck";

import { MeldConnection } from "../src/meld/connection.ts";
import { registerUiBridge } from "../src/ui-bridge.ts";
import { FakeMeld } from "../tools/fake-meld/server.ts";
import { type Scenario, SessionBuilder } from "../tools/fake-meld/session.ts";

/** A payload the bridge pushed to the property inspector. */
type Pushed = { event: string; connected: boolean; items: Record<string, { type: string }> };

/** Scenario with one scene and one track, namespaced by `tag`. */
function scenarioFor(tag: string): { scenario: Scenario; sceneId: string; trackId: string } {
	const b = new SessionBuilder(tag);
	const sceneId = b.scene(`Scene ${tag}`, { current: true });
	const trackId = b.track(`Track ${tag}`, { gain: 0.5 });
	return { scenario: b.build(tag, `ui ${tag}`), sceneId, trackId };
}

describe("ui bridge", () => {
	const pushes: Pushed[] = [];
	let requestSession: (() => void) | undefined;
	let inspectorAppeared: (() => void) | undefined;
	let restore: () => void;

	let server: FakeMeld;
	let connection: MeldConnection;
	let port = 0;
	let first: ReturnType<typeof scenarioFor>;

	before(async () => {
		// Capture what the bridge would send to a property inspector.
		const ui = streamDeck.ui as unknown as Record<string, unknown>;
		const original = { ...ui };
		ui.sendToPropertyInspector = async (payload: unknown): Promise<void> => {
			pushes.push(payload as Pushed);
		};
		ui.onSendToPlugin = (handler: (ev: { payload: unknown }) => void): unknown => {
			requestSession = () => handler({ payload: { event: "meld.getSession" } });
			return { dispose: () => {} };
		};
		ui.onDidAppear = (handler: () => void): unknown => {
			inspectorAppeared = handler;
			return { dispose: () => {} };
		};
		restore = () => Object.assign(ui, original);

		first = scenarioFor("uiA");
		server = new FakeMeld(first.scenario);
		port = await server.listen(0);
		connection = new MeldConnection({ port, handshakeTimeoutMs: 300, reconnectMinMs: 100 });
		registerUiBridge(connection);
	});

	after(async () => {
		restore();
		connection.dispose();
		await server.close();
	});

	test("answers a request made before Meld is connected", () => {
		// An inspector opened while Meld is down must get an answer, not silence:
		// `connected: false` is what drives its "Connecting to Meld Studio…" notice.
		pushes.length = 0;
		requestSession?.();

		assert.equal(pushes.length, 1, "the bridge must always answer a request");
		assert.equal(pushes[0].event, "meld.session");
		assert.equal(pushes[0].connected, false);
		assert.deepEqual(pushes[0].items, {});
	});

	test("pushes the session as soon as Meld connects", async () => {
		pushes.length = 0;
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		connection.connect();
		await ready;
		await sleep(50);

		const connectedPush = pushes.find((p) => p.connected);
		assert.ok(connectedPush, "connecting must push a snapshot to open inspectors");
		assert.ok(connectedPush.items[first.sceneId], "the snapshot should carry the session items");
	});

	test("answers an inspector that opens while connected", () => {
		pushes.length = 0;
		inspectorAppeared?.();

		assert.equal(pushes.length, 1);
		assert.equal(pushes[0].connected, true);
		assert.equal(pushes[0].items[first.trackId]?.type, "track");
	});

	test("pushes an update when the session changes in Meld", async () => {
		pushes.length = 0;
		server.showScene(first.sceneId);
		await sleep(800);

		assert.ok(pushes.length >= 1, "a session change must reach open inspectors");
		assert.equal(pushes.at(-1)?.connected, true);
	});

	test("reports the disconnect, then the new instance's items", async () => {
		pushes.length = 0;
		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;
		await sleep(30);

		const closedPush = pushes.find((p) => !p.connected);
		assert.ok(closedPush, "a disconnect must be pushed so inspectors can show their notice");
		assert.deepEqual(closedPush.items, {}, "no stale items should be served while disconnected");

		// A different Meld instance: the inspector must be offered the new ids.
		const second = scenarioFor("uiB");
		pushes.length = 0;
		server = new FakeMeld(second.scenario);
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		await server.listen(port);
		await ready;
		await sleep(50);

		const fresh = pushes.find((p) => p.connected);
		assert.ok(fresh, "reconnecting must push the new session");
		assert.ok(fresh.items[second.sceneId], "the new instance's scene should be offered");
		assert.equal(fresh.items[first.sceneId], undefined, "the old instance's items must be gone");
	});
});
