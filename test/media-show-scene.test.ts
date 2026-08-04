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
import { type Scenario, SessionBuilder } from "./helpers/session-builder.ts";
import { FakeActionInstance, keyEvent, mount, press, retarget, willAppear } from "./helpers/fake-stream-deck.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";

/** A scene with a playing media layer. */
function build(): { scenario: Scenario; ids: Record<string, string> } {
	const b = new SessionBuilder("ms");
	const scene = b.scene("Live", { current: true });
	const other = b.scene("Break");
	const third = b.scene("Interlude");
	const clip = b.layer(scene, "Clip", { mediaSource: "clip.mp4", isPlaying: true });
	const clipB = b.layer(scene, "Clip B", { mediaSource: "other.mp4", isPlaying: true });
	const track = b.track("Microphone", { gain: 0.6 });
	return { scenario: b.build("ms", "media"), ids: { scene, other, third, clip, clipB, track } };
}

describe("Media and ShowScene", () => {
	let server: MockWebChannel;
	let connection: MeldConnection;
	let ids: Record<string, string>;
	let port = 0;

	before(async () => {
		const built = build();
		ids = built.ids;
		server = new MockWebChannel(built.scenario);
		port = await server.listen(0);
		connection = new MeldConnection({ port, handshakeTimeoutMs: 300, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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
		server.resetCalls();
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
		await press(action, key, settings);
		await sleep(150);
		assert.equal(
			(server.session.items[ids.clip] as { isPlaying: boolean }).isPlaying,
			false,
			"Meld should have paused the clip",
		);
		assert.ok(key.image?.includes("play"), `a paused clip shows the play icon, got ${key.image}`);

		// And back again.
		await press(action, key, settings);
		await sleep(150);
		assert.equal((server.session.items[ids.clip] as { isPlaying: boolean }).isPlaying, true);
		assert.ok(key.image?.includes("pause"), `a playing clip shows the pause icon, got ${key.image}`);
	});

	test("two toggle presses inside Meld's debounce alternate rather than repeat", async () => {
		// `isPlaying` only refreshes when Meld republishes the session, behind its
		// autosave debounce. A second press in that window must act on the pending
		// intent, not re-read the pre-press snapshot and send the same command.
		const slow = new MockWebChannel(build().scenario, { sessionDebounceMs: 600 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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
			slow.resetCalls();

			await press(action, key, settings); // playing -> pause
			await sleep(120);
			await press(action, key, settings); // still inside the debounce
			await sleep(120);

			const members = slow.methods.callFunction.mock.calls.map((call) => call.arguments[1]);
			assert.deepEqual(members, ["pause", "play"], "the second press must resume, not pause again");
			assert.ok(key.image?.includes("pause"), "and the key shows the playing state it asked for");
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("a pending press is dropped when the key is retargeted to another layer", async () => {
		// The inspector can retarget a key seconds after a press, while the first
		// clip's confirmation is still outstanding. Carrying that pending value over
		// would show the inverse of the new clip's state and send the wrong command.
		const slow = new MockWebChannel(build().scenario, { sessionDebounceMs: 600 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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

			const first = { scene: slowIds.scene, layer: slowIds.clip, action: "toggle" };
			const action = new Media(slowConnection);
			const key = new FakeActionInstance("m", first);
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, first) as never);
			await sleep(60);

			await press(action, key, first); // clip -> paused (pending, unconfirmed)
			await sleep(60);
			slow.resetCalls();

			// Retarget to the second media layer, which is playing.
			const second = { scene: slowIds.scene, layer: slowIds.clipB, action: "toggle" };
			await retarget(action, key, second);
			await sleep(60);
			assert.ok(key.image?.includes("pause"), `the new clip is playing, got ${key.image}`);

			await press(action, key, second);
			await sleep(80);
			assert.deepEqual(
				slow.methods.callFunction.mock.calls.at(-1)?.arguments,
				[slowIds.clipB, "pause"],
				"the press must act on the new layer's real state",
			);
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("a media press holds its icon across a retriggered autosave", async () => {
		// The optimistic TTL has to outlast Meld's retriggerable debounce, or the
		// key flips back to the pre-press icon and then forward again.
		const slow = new MockWebChannel(build().scenario, { sessionDebounceMs: 600 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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

			await press(action, key, settings); // playing -> paused
			key.reset();
			for (let i = 0; i < 6; i++) {
				slow.setMuted(slowIds.track, i % 2 === 0);
				await sleep(150);
			}
			await sleep(800);

			assert.ok(
				!key.images.some((image) => image?.includes("pause")),
				`the key must not flip back to the pre-press icon; painted ${JSON.stringify(key.images)}`,
			);
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

		await press(action, key, settings);
		await sleep(80);

		// seekTo(0) would jump outside a trimmed clip's configured region.
		assert.deepEqual(server.methods.callFunction.mock.calls.at(-1)?.arguments, [ids.clip, "skipBack"]);
		assert.equal(server.methods.callFunctionWithArgs.mock.callCount(), 0);
	});

	test("fixed play and pause modes dispatch directly and paint uniform icons", async () => {
		for (const mode of ["play", "pause"] as const) {
			server.resetCalls();
			const settings = { scene: ids.scene, layer: ids.clip, action: mode };
			const action = new Media(connection);
			const key = new FakeActionInstance(`media-${mode}`, settings);
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, settings) as never);
			await press(action, key, settings);

			assert.deepEqual(server.methods.callFunction.mock.calls.at(-1)?.arguments, [ids.clip, mode]);
			assert.ok(key.image?.includes(`media-controls-${mode}`), `${mode} should paint its fixed icon`);
		}
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

		await press(action, key, settings);
		await sleep(150);
		assert.deepEqual(server.methods.callFunction.mock.calls.at(-1)?.arguments, [ids.clip, "pause"]);
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

		server = new MockWebChannel(build().scenario);
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

	test("an unconfirmed media command does not leak into a restarted Meld instance", async () => {
		const settings = { scene: ids.scene, layer: ids.clip, action: "toggle" };
		const action = new Media(connection);
		const key = new FakeActionInstance("media-restart", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await press(action, key, settings);
		await sleep(40);
		assert.ok(key.image?.includes("play"), "the in-flight pause is painted immediately");

		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;

		server = new MockWebChannel(build().scenario);
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		await server.listen(port);
		await ready;
		await sleep(60);

		assert.ok(key.image?.includes("pause"), "the restarted instance's playing clip is authoritative");
	});

	test("a show-scene key lights only once Meld confirms the scene", async () => {
		const action = new ShowScene(connection);
		const key = new FakeActionInstance("s", { scene: ids.other });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.other }) as never);
		await sleep(60);
		assert.equal(key.state, 0, "a scene that is not current starts unlit");

		await press(action, key, { scene: ids.other });
		await sleep(120);

		assert.equal(server.methods.showScene.mock.callCount(), 1);
		assert.equal(key.state, 1, "the key lights for the scene that actually went live");
		assert.equal((server.session.items[ids.other] as { current: boolean }).current, true);
	});

	test("a show-scene key stays lit while Meld's debounced snapshot catches up", async () => {
		// A scene switch is only confirmed when the session snapshot is republished,
		// and that rides Meld's retriggerable ~600ms autosave — far slower than a
		// gain echo. The key must hold its optimistic light across that gap instead
		// of blinking dark and back.
		const slow = new MockWebChannel(build().scenario, { sessionDebounceMs: 600 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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

			await press(action, key, { scene: slowIds.other });
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

	test("one show-scene key's expiry does not darken another key's pending press", async () => {
		// Each key waits on its own confirmation. If an expiry repainted every key,
		// the first key's timeout would clear a second key's still-valid request and
		// repaint it from the pre-press snapshot.
		const slow = new MockWebChannel(build().scenario, { sessionDebounceMs: 600 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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
			const first = new FakeActionInstance("s1", { scene: slowIds.other });
			const second = new FakeActionInstance("s2", { scene: slowIds.third });
			mount(action, [first, second]);
			await action.onWillAppear(willAppear(first, { scene: slowIds.other }) as never);
			await action.onWillAppear(willAppear(second, { scene: slowIds.third }) as never);
			await sleep(60);

			// Keep Meld continuously busy for the whole window: the autosave is
			// retriggerable, so no snapshot lands and the only thing that can repaint
			// either key is an optimistic expiry.
			let busy = true;
			const churn = (async (): Promise<void> => {
				for (let i = 0; busy && i < 40; i++) {
					slow.setMuted(slowIds.track, i % 2 === 0);
					await sleep(120);
				}
			})();

			await press(action, first, { scene: slowIds.other });
			await sleep(900);

			second.reset();
			await press(action, second, { scene: slowIds.third });
			assert.equal(second.state, 1, "the second press lights its own key");

			// Past the FIRST key's TTL, still inside the second's.
			await sleep(2_400);
			busy = false;
			await churn;

			assert.ok(
				!second.states.includes(0),
				`the second key must not be darkened by the first key's expiry; painted ${JSON.stringify(second.states)}`,
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

		await press(action, key, { scene: "GONESCENE" });
		await sleep(120);

		assert.equal(server.methods.showScene.mock.callCount(), 0, "no command should reach Meld");
		assert.deepEqual(key.states, [], "the key must not light for a scene that does not exist");
	});

	test("an unconfigured show-scene key stays off and never dispatches", async () => {
		const action = new ShowScene(connection);
		const key = new FakeActionInstance("scene-unconfigured", {});
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, {}) as never);
		server.resetCalls();

		await press(action, key, {});

		assert.equal(key.state, 0);
		assert.equal(server.methods.showScene.mock.callCount(), 0);
	});
});
