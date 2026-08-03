// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Two actions whose keys must not lie about state they cannot confirm: the media
// key through a reconnect blip, and the show-scene key when its stored scene
// belongs to a Meld instance that is no longer running.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Media } from "../src/actions/media.ts";
import { ShowScene } from "../src/actions/show-scene.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeMeld } from "../tools/fake-meld/server.ts";
import { type Scenario, SessionBuilder } from "../tools/fake-meld/session.ts";
import { FakeActionInstance, keyEvent, mount, willAppear } from "./helpers/fake-stream-deck.ts";

/** A scene with a playing media layer. */
function build(): { scenario: Scenario; ids: Record<string, string> } {
	const b = new SessionBuilder("ms");
	const scene = b.scene("Live", { current: true });
	const other = b.scene("Break");
	const clip = b.layer(scene, "Clip", { mediaSource: "clip.mp4", isPlaying: true });
	const track = b.track("Microphone", { gain: 0.6 });
	return { scenario: b.build("ms", "media"), ids: { scene, other, clip, track } };
}

describe("Media and ShowScene", () => {
	let server: FakeMeld;
	let connection: MeldConnection;
	let ids: Record<string, string>;
	let port = 0;

	before(async () => {
		const built = build();
		ids = built.ids;
		server = new FakeMeld(built.scenario);
		port = await server.listen(0);
		connection = new MeldConnection({ port, handshakeTimeoutMs: 300, reconnectMinMs: 100 });
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		connection.connect();
		await ready;
	});

	after(async () => {
		connection.dispose();
		await server.close();
	});

	beforeEach(async () => {
		server.loadScenario(build().scenario);
		server.invocations.length = 0;
		await sleep(40);
	});

	test("the media key shows the playing state", async () => {
		const action = new Media(connection);
		const key = new FakeActionInstance("m", { scene: ids.scene, layer: ids.clip, action: "toggle" });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.scene, layer: ids.clip, action: "toggle" }) as never);
		await sleep(60);

		assert.ok(key.image?.includes("pause"), `a playing clip shows the pause icon, got ${key.image}`);
	});

	test("a media press converges on the playback state Meld reports back", async () => {
		// The press paints optimistically, but the authoritative answer arrives in
		// the republished snapshot. Both must agree, or the key flips to the wrong
		// icon shortly after every press.
		const settings = { scene: ids.scene, layer: ids.clip, action: "toggle" };
		const action = new Media(connection);
		const key = new FakeActionInstance("m", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(60);
		assert.ok(key.image?.includes("pause"), "the clip starts playing");

		// Toggle: playing -> paused.
		await action.onKeyUp(keyEvent(key, settings) as never);
		await sleep(150);
		assert.equal(
			(server.session.items[ids.clip] as { isPlaying: boolean }).isPlaying,
			false,
			"Meld should have paused the clip",
		);
		assert.ok(key.image?.includes("play"), `a paused clip shows the play icon, got ${key.image}`);

		// And back again.
		await action.onKeyUp(keyEvent(key, settings) as never);
		await sleep(150);
		assert.equal((server.session.items[ids.clip] as { isPlaying: boolean }).isPlaying, true);
		assert.ok(key.image?.includes("pause"), `a playing clip shows the pause icon, got ${key.image}`);
	});

	test("two toggle presses inside Meld's debounce alternate rather than repeat", async () => {
		// `isPlaying` only refreshes when Meld republishes the session, behind its
		// autosave debounce. A second press in that window must act on the pending
		// intent, not re-read the pre-press snapshot and send the same command.
		const slow = new FakeMeld(build().scenario, { sessionDebounceMs: 600 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100 });
		const slowIds = build().ids;

		try {
			const ready = new Promise<void>((resolve) => {
				const off = slowConnection.on("ready", () => {
					off();
					resolve();
				});
			});
			slowConnection.connect();
			await ready;

			const settings = { scene: slowIds.scene, layer: slowIds.clip, action: "toggle" };
			const action = new Media(slowConnection);
			const key = new FakeActionInstance("m", settings);
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, settings) as never);
			await sleep(60);
			slow.invocations.length = 0;

			await action.onKeyUp(keyEvent(key, settings) as never); // playing -> pause
			await sleep(120);
			await action.onKeyUp(keyEvent(key, settings) as never); // still inside the debounce
			await sleep(120);

			const members = slow.callsTo("callFunction").map((c) => c.args[1]);
			assert.deepEqual(members, ["pause", "play"], "the second press must resume, not pause again");
			assert.ok(key.image?.includes("pause"), "and the key shows the playing state it asked for");
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("restart uses Meld's own skip-back, which respects a clip's loop point", async () => {
		const settings = { scene: ids.scene, layer: ids.clip, action: "restart" };
		const action = new Media(connection);
		const key = new FakeActionInstance("m", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(60);

		await action.onKeyUp(keyEvent(key, settings) as never);
		await sleep(80);

		// seekTo(0) would jump outside a trimmed clip's configured region.
		assert.deepEqual(server.callsTo("callFunction").at(-1)?.args, [ids.clip, "skipBack"]);
		assert.equal(server.callsTo("callFunctionWithArgs").length, 0);
	});

	test("a stale stored scene does not make the media key inert", async () => {
		// Upgraded profiles can hold a scene from a previous selection. Meld's
		// callFunction resolves the layer by id alone, so the key must keep working
		// rather than silently doing nothing — the same tolerance the toggle actions
		// apply to their stored chains.
		const settings = { scene: ids.other, layer: ids.clip, action: "toggle" };
		const action = new Media(connection);
		const key = new FakeActionInstance("m", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(60);
		assert.ok(key.image?.includes("pause"), "the key must still reflect the playing clip");

		await action.onKeyUp(keyEvent(key, settings) as never);
		await sleep(150);
		assert.deepEqual(server.callsTo("callFunction").at(-1)?.args, [ids.clip, "pause"]);
	});

	test("the media key holds its icon through a connection blip", async () => {
		// The clip never stopped playing; flipping to "play" would tell the user it
		// did, and it would stay wrong for the whole reconnect.
		const action = new Media(connection);
		const key = new FakeActionInstance("m", { scene: ids.scene, layer: ids.clip, action: "toggle" });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.scene, layer: ids.clip, action: "toggle" }) as never);
		await sleep(60);
		const before = key.image;
		key.reset();

		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;
		await sleep(60);

		assert.deepEqual(key.images, [], "a disconnect must not repaint the media key");

		server = new FakeMeld(build().scenario);
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		await server.listen(port);
		await ready;
		await sleep(60);
		assert.equal(key.image ?? before, before, "the icon should be unchanged after reconnect");
	});

	test("a show-scene key lights only once Meld confirms the scene", async () => {
		const action = new ShowScene(connection);
		const key = new FakeActionInstance("s", { scene: ids.other });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.other }) as never);
		await sleep(60);
		assert.equal(key.state, 0, "a scene that is not current starts unlit");

		action.onKeyUp(keyEvent(key, { scene: ids.other }) as never);
		await sleep(120);

		assert.equal(server.callsTo("showScene").length, 1);
		assert.equal(key.state, 1, "the key lights for the scene that actually went live");
		assert.equal((server.session.items[ids.other] as { current: boolean }).current, true);
	});

	test("a show-scene key stays lit while Meld's debounced snapshot catches up", async () => {
		// A scene switch is only confirmed when the session snapshot is republished,
		// and that rides Meld's retriggerable ~600ms autosave — far slower than a
		// gain echo. The key must hold its optimistic light across that gap instead
		// of blinking dark and back.
		const slow = new FakeMeld(build().scenario, { sessionDebounceMs: 600 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100 });
		const slowIds = build().ids;

		try {
			const ready = new Promise<void>((resolve) => {
				const off = slowConnection.on("ready", () => {
					off();
					resolve();
				});
			});
			slowConnection.connect();
			await ready;

			const action = new ShowScene(slowConnection);
			const key = new FakeActionInstance("s", { scene: slowIds.other });
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, { scene: slowIds.other }) as never);
			await sleep(60);
			key.reset();

			action.onKeyUp(keyEvent(key, { scene: slowIds.other }) as never);
			await sleep(100);
			assert.equal(key.state, 1, "the press lights the key immediately");

			// A repaint driven by something other than the session — here a recording
			// change — re-renders from the snapshot, which still shows the old current
			// scene. The pending request is what has to keep the key lit; without it
			// this render paints 0.
			slow.setRecording(true);
			await sleep(120);

			// Meld's autosave timer is retriggerable, so ordinary concurrent activity
			// — a fader move, a layer edit — keeps pushing the confirmation out. Each
			// edit here resets the 600ms debounce, which is the realistic case where a
			// short optimistic TTL loses the race.
			for (let i = 0; i < 6; i++) {
				slow.setMuted(slowIds.track, i % 2 === 0);
				await sleep(150);
			}

			// Let the edits stop so the snapshot finally lands.
			await sleep(800);
			assert.equal(key.state, 1, "the key is lit once the confirmation arrives");
			assert.ok(
				!key.states.includes(0),
				`the key must never blink dark while waiting; painted ${JSON.stringify(key.states)}`,
			);

			assert.equal(
				(slow.session.items[slowIds.other] as { current: boolean }).current,
				true,
				"and Meld did make the scene current",
			);
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("a show-scene key for a scene this instance lacks neither sends nor lights", async () => {
		// A profile carrying an id from a different project: showScene would be a
		// silent no-op in Meld, so lighting the key would fake a confirmation.
		const action = new ShowScene(connection);
		const key = new FakeActionInstance("s", { scene: "GONESCENE" });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: "GONESCENE" }) as never);
		await sleep(60);
		key.reset();

		action.onKeyUp(keyEvent(key, { scene: "GONESCENE" }) as never);
		await sleep(120);

		assert.equal(server.callsTo("showScene").length, 0, "no command should reach Meld");
		assert.deepEqual(key.states, [], "the key must not light for a scene that does not exist");
	});
});
