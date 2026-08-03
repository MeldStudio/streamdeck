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
	return { scenario: b.build("ms", "media"), ids: { scene, other, clip } };
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
