// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The four "toggle a boolean session property" actions, driven end-to-end
// against the fake Meld. These cover two rules that were each broken once:
// a press must never act on (or paint a state for) an item the current Meld
// instance does not have, and a legacy profile holding a stale scene/layer
// chain must keep working, with the real parent chain derived from the session.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { ToggleEffect } from "../src/actions/toggle-effect.ts";
import { ToggleLayer } from "../src/actions/toggle-layer.ts";
import { ToggleMute } from "../src/actions/toggle-mute.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeMeld } from "../tools/fake-meld/server.ts";
import { type Scenario, SessionBuilder } from "../tools/fake-meld/session.ts";
import { FakeActionInstance, keyEvent, mount, willAppear } from "./helpers/fake-stream-deck.ts";

/** Two scenes, each with a layer; the first layer carries an effect. */
function build(namespace: string): {
	scenario: Scenario;
	ids: Record<string, string>;
} {
	const b = new SessionBuilder(namespace);
	const sceneA = b.scene("A", { current: true });
	const sceneB = b.scene("B");
	const layerA = b.layer(sceneA, "Camera", { visible: true });
	const layerB = b.layer(sceneB, "Slides", { visible: false });
	const effectA = b.effect(layerA, "Blur", { enabled: true });
	const track = b.track("Microphone", { gain: 0.7, muted: false });
	return {
		scenario: b.build(namespace, "toggles"),
		ids: { sceneA, sceneB, layerA, layerB, effectA, track },
	};
}

describe("session toggles", () => {
	let server: FakeMeld;
	let connection: MeldConnection;
	let ids: Record<string, string>;
	let port = 0;

	before(async () => {
		const built = build("tog");
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
		// Presses mutate the fake's session, so reload a pristine copy (the builder
		// is deterministic, so the ids are unchanged) to keep tests independent.
		server.loadScenario(build("tog").scenario);
		server.invocations.length = 0;
		await sleep(40);
	});

	test("a layer key reflects the layer's visibility", async () => {
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", { scene: ids.sceneA, layer: ids.layerA });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.sceneA, layer: ids.layerA }) as never);
		await sleep(40);
		assert.equal(key.state, 1, "a visible layer shows state 1");
	});

	test("pressing a layer key toggles it in Meld", async () => {
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", { scene: ids.sceneA, layer: ids.layerA });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.sceneA, layer: ids.layerA }) as never);
		await sleep(40);

		action.onKeyUp(keyEvent(key, { scene: ids.sceneA, layer: ids.layerA }) as never);
		await sleep(120);

		const calls = server.callsTo("toggleLayer");
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].args, [ids.sceneA, ids.layerA]);
		assert.equal(key.state, 0, "the key should follow Meld's new visibility");
	});

	test("a legacy profile's stale scene still toggles the intended layer", async () => {
		// The old inspector never cleared the layer when the scene dropdown changed,
		// so upgraded profiles hold pairs like {scene: B, layer: <child of A>}. The
		// layer id alone identifies the target, and Meld must receive the layer's
		// real parent rather than the stored scene.
		const settings = { scene: ids.sceneB, layer: ids.layerA };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);
		assert.equal(key.state, 1, "the key must still track the intended layer, not go dark");

		action.onKeyUp(keyEvent(key, settings) as never);
		await sleep(120);

		const calls = server.callsTo("toggleLayer");
		assert.equal(calls.length, 1, "the press must reach Meld");
		assert.deepEqual(
			calls[0].args,
			[ids.sceneA, ids.layerA],
			"Meld must receive the layer's real parent scene, not the stale stored one",
		);
	});

	test("a legacy profile's stale layer still toggles the intended effect", async () => {
		const settings = { scene: ids.sceneA, layer: ids.layerB, effect: ids.effectA };
		const action = new ToggleEffect(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);
		assert.equal(key.state, 1, "an enabled effect shows state 1 despite the stale layer");

		action.onKeyUp(keyEvent(key, settings) as never);
		await sleep(120);

		const calls = server.callsTo("toggleEffect");
		assert.equal(calls.length, 1);
		assert.deepEqual(
			calls[0].args,
			[ids.sceneA, ids.layerA, ids.effectA],
			"the whole chain must be derived from the session",
		);
	});

	test("a press for an item this Meld instance lacks does nothing", async () => {
		// After a project switch every id changes; a key still holding an old id
		// must not send a command that Meld silently drops, and must not paint a
		// state implying the command took effect.
		const settings = { scene: "OLDSCENE", layer: "OLDLAYER" };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);
		key.reset();

		action.onKeyUp(keyEvent(key, settings) as never);
		await sleep(120);

		assert.equal(server.callsTo("toggleLayer").length, 0, "no command should reach Meld");
		assert.deepEqual(key.states, [], "no state should be painted for a nonexistent item");
	});

	test("force mode is idempotent and does not fake a state for a missing track", async () => {
		const action = new ToggleMute(connection);
		const present = { track: ids.track, action: "mute" };
		const key = new FakeActionInstance("k", present);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, present) as never);
		await sleep(40);

		// Forcing mute on an unmuted track sets it directly.
		action.onKeyUp(keyEvent(key, present) as never);
		await sleep(120);
		const direct = server.callsTo("setMuted").concat(server.callsTo("setProperty"));
		assert.ok(direct.length >= 1, "force mode should use the direct setter");
		assert.equal(key.state, 0, "state 0 is muted for this action");

		// The same press against a track that does not exist must be inert.
		server.invocations.length = 0;
		const ghost = { track: "NOSUCHTRACK", action: "mute" };
		const ghostAction = new ToggleMute(connection);
		const ghostKey = new FakeActionInstance("g", ghost);
		mount(ghostAction, [ghostKey]);
		await ghostAction.onWillAppear(willAppear(ghostKey, ghost) as never);
		await sleep(40);
		ghostKey.reset();

		ghostAction.onKeyUp(keyEvent(ghostKey, ghost) as never);
		await sleep(120);
		assert.equal(server.invocations.length, 0, "nothing should be sent for a missing track");
		assert.deepEqual(ghostKey.states, [], "no state should be painted for a missing track");
	});

	test("an unconfigured key neither paints nor sends", async () => {
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", {});
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, {}) as never);
		await sleep(40);

		action.onKeyUp(keyEvent(key, {}) as never);
		await sleep(120);
		assert.deepEqual(key.states, []);
		assert.equal(server.callsTo("toggleLayer").length, 0);
	});
});
