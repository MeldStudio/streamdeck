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
import { legacyEffectId, type Scenario, SessionBuilder } from "../tools/fake-meld/session.ts";
import { FakeActionInstance, keyEvent, press, mount, willAppear } from "./helpers/fake-stream-deck.ts";

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
	// Three effects, so a legacy `<layerId>-<index>` id genuinely has to pick the
	// right one. Their ids sort into a different order than the model order, which
	// is exactly the trap: resolving by snapshot order would choose another effect.
	const effectA = b.effect(layerA, "Blur", { enabled: true });
	const effectA2 = b.effect(layerA, "Sharpen", { enabled: true });
	const effectA3 = b.effect(layerA, "Chroma Key", { enabled: true });
	const track = b.track("Microphone", { gain: 0.7, muted: false });
	return {
		scenario: b.build(namespace, "toggles"),
		ids: { sceneA, sceneB, layerA, layerB, effectA, effectA2, effectA3, track },
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

		await press(action, key, { scene: ids.sceneA, layer: ids.layerA });
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

		await press(action, key, settings);
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

		await press(action, key, settings);
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

		await press(action, key, settings);
		await sleep(120);

		assert.equal(server.callsTo("toggleLayer").length, 0, "no command should reach Meld");
		assert.deepEqual(key.states, [], "no state should be painted for a nonexistent item");
	});

	test("force mode without a direct setter never toggles away from the desired state", async () => {
		// ToggleLayer has no setDirect, so force mode goes through the compare-then-
		// toggle path. Forcing "show" on a layer that is already visible must do
		// nothing: toggling here would hide the very layer the user asked to show.
		const settings = { scene: ids.sceneA, layer: ids.layerA, action: "show" };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);
		assert.equal(key.state, 1, "the layer starts visible");

		await press(action, key, settings);
		await sleep(120);

		assert.equal(server.callsTo("toggleLayer").length, 0, "forcing the state it is already in must not toggle");
		assert.equal(
			(server.session.items[ids.layerA] as { visible: boolean }).visible,
			true,
			"the layer must still be visible",
		);
		assert.equal(key.state, 1);
	});

	test("force mode without a direct setter toggles when the state differs", async () => {
		// The complement: forcing "show" on a hidden layer must toggle exactly once.
		const settings = { scene: ids.sceneB, layer: ids.layerB, action: "show" };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);
		assert.equal(key.state, 0, "the layer starts hidden");

		await press(action, key, settings);
		await sleep(120);

		assert.equal(server.callsTo("toggleLayer").length, 1, "a differing state must toggle once");
		assert.equal((server.session.items[ids.layerB] as { visible: boolean }).visible, true);
		assert.equal(key.state, 1);
	});

	test("force mode is idempotent and does not fake a state for a missing track", async () => {
		const action = new ToggleMute(connection);
		const present = { track: ids.track, action: "mute" };
		const key = new FakeActionInstance("k", present);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, present) as never);
		await sleep(40);

		// Forcing mute on an unmuted track sets it directly.
		await press(action, key, present);
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

	test("an upgraded profile's <layerId>-<index> effect id toggles the right effect", async () => {
		// Meld resolves this form against its own effects model — the order the user
		// sees — which the snapshot does not expose (Qt serializes items sorted by
		// id). Resolving the index here would therefore pick a different effect, so
		// the id is forwarded verbatim and Meld does the lookup, as it did for the
		// pre-migration plugin.
		const settings = {
			scene: ids.sceneA,
			layer: ids.layerA,
			// Index 0, not 1: the model order and the id-sorted snapshot order are a
			// three-element reversal here, so index 1 is their fixed point and could
			// not tell the two apart.
			effect: legacyEffectId(ids.layerA, 0),
		};
		const action = new ToggleEffect(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);

		await press(action, key, settings);
		await sleep(120);

		const calls = server.callsTo("toggleEffect");
		assert.equal(calls.length, 1, "the press must reach Meld");
		assert.deepEqual(
			calls[0].args,
			[ids.sceneA, ids.layerA, legacyEffectId(ids.layerA, 0)],
			"the legacy id must be forwarded untouched for Meld to resolve",
		);
		// Index 0 in model order is "Blur"; in id-sorted snapshot order it would be
		// "Chroma Key", so only one of the two can be right.
		assert.equal(
			(server.session.items[ids.effectA] as { enabled: boolean }).enabled,
			false,
			"the effect at that model index must be the one that toggled",
		);
		assert.equal((server.session.items[ids.effectA2] as { enabled: boolean }).enabled, true);
		assert.equal((server.session.items[ids.effectA3] as { enabled: boolean }).enabled, true);
	});

	test("pressing 'show' twice inside Meld's debounce does not hide the layer", async () => {
		// Meld republishes the session behind its autosave, so a second press lands
		// while the snapshot still says "hidden". Reasoning from that stale value
		// would toggle again and undo the first press — the user asks to show a
		// layer twice and it goes dark.
		const settings = { scene: ids.sceneB, layer: ids.layerB, action: "show" };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(60);
		assert.equal(key.state, 0, "the layer starts hidden");

		await press(action, key, settings);
		// Meld's autosave is retriggerable, so ordinary concurrent activity keeps
		// pushing the confirmation out well past a single debounce. That is the
		// case the TTL exists for, and waiting out one undisturbed 600ms window
		// would let any TTL above it pass.
		for (let i = 0; i < 6; i++) {
			server.setMuted(ids.track, i % 2 === 0);
			await sleep(150);
		}
		await press(action, key, settings);
		await sleep(900);

		assert.equal(
			(server.session.items[ids.layerB] as { visible: boolean }).visible,
			true,
			"two 'show' presses must leave the layer visible",
		);
		assert.equal(key.state, 1);
		// Sampling only the final state would miss a key that flashed back to
		// "hidden" while waiting — which is what a TTL shorter than the
		// confirmation latency produces. (Repeats of 1 are expected: a key press
		// clears the dedupe cache, so the idempotent second press repaints.)
		assert.deepEqual(
			key.states.slice(1),
			key.states.slice(1).map(() => 1),
			`the key must never go dark after lighting; painted ${JSON.stringify(key.states)}`,
		);
	});

	test("a toggle press repaints immediately rather than waiting for the snapshot", async () => {
		// The confirmation is hundreds of milliseconds away; a key that only
		// repaints then reads as unresponsive.
		const settings = { scene: ids.sceneA, layer: ids.layerA };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(60);
		assert.equal(key.state, 1, "the layer starts visible");

		await press(action, key, settings);
		await sleep(50); // well inside the debounce
		assert.equal(key.state, 0, "the key must follow the press without waiting for Meld");
	});

	test("an unconfigured key neither paints nor sends", async () => {
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", {});
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, {}) as never);
		await sleep(40);

		await press(action, key, {});
		await sleep(120);
		assert.deepEqual(key.states, []);
		assert.equal(server.callsTo("toggleLayer").length, 0);
	});
});
