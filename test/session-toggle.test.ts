// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The four "toggle a boolean session property" actions, driven end-to-end
// against a result-level Meld mock. These cover two rules that were each broken once:
// a press must never act on (or paint a state for) an item the current Meld
// instance does not have, and an existing profile holding a stale scene/layer
// chain must keep working, with the real parent chain derived from the session.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { ToggleEffect } from "../src/actions/toggle-effect.ts";
import { ToggleLayer } from "../src/actions/toggle-layer.ts";
import { ToggleMute } from "../src/actions/toggle-mute.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { indexedEffectId, type Scenario, SessionBuilder } from "./helpers/session-builder.ts";
import { FakeActionInstance, keyEvent, mount, press, retarget, willAppear } from "./helpers/fake-stream-deck.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";

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
	const layerC = b.layer(sceneA, "Lower Third", { visible: false });
	const effectA = b.effect(layerA, "Blur", { enabled: true });
	b.effect(layerA, "Sharpen", { enabled: true });
	b.effect(layerA, "Chroma Key", { enabled: true });
	const track = b.track("Microphone", { gain: 0.7, muted: false });
	const scenario = b.build(namespace, "toggles");
	const effectAtIndex1 = Object.entries(scenario.session.items)
		.filter(([, item]) => item.type === "effect" && item.parent === layerA)
		.at(1)?.[0];
	assert.ok(effectAtIndex1, "the scenario must expose at least two stable effects");
	return {
		scenario,
		ids: { sceneA, sceneB, layerA, layerB, layerC, effectA, effectAtIndex1, track },
	};
}

describe("session toggles", () => {
	let server: MockWebChannel;
	let connection: MeldConnection;
	let ids: Record<string, string>;
	let port = 0;

	before(async () => {
		const built = build("tog");
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
		// Presses mutate the mock's session, so reload a pristine copy (the builder
		// is deterministic, so the ids are unchanged) to keep tests independent.
		server.loadScenario(build("tog").scenario);
		server.resetCalls();
		// Wait for the reloaded snapshot to actually reach the plugin: it rides the
		// autosave debounce, so a shorter wait leaves each test reasoning from the
		// previous one's state.
		await sleep(700);
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

		const calls = server.methods.toggleLayer.mock.calls;
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].arguments, [ids.sceneA, ids.layerA]);
		assert.equal(key.state, 0, "the key should follow Meld's new visibility");
	});

	test("an unconfirmed toggle does not leak into a restarted Meld instance", async () => {
		const settings = { scene: ids.sceneA, layer: ids.layerA };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("restart-key", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await press(action, key, settings);
		await sleep(40);
		assert.equal(key.state, 0, "the in-flight press is painted immediately");

		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;

		server = new MockWebChannel(build("tog").scenario);
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		await server.listen(port);
		await ready;
		await sleep(60);

		assert.equal(key.state, 1, "the restarted instance's visible layer is authoritative");
	});

	test("an existing profile's stale scene still toggles the intended layer", async () => {
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

		const calls = server.methods.toggleLayer.mock.calls;
		assert.equal(calls.length, 1, "the press must reach Meld");
		assert.deepEqual(
				calls[0].arguments,
			[ids.sceneA, ids.layerA],
			"Meld must receive the layer's real parent scene, not the stale stored one",
		);
	});

	test("an existing profile's stale layer still toggles the intended effect", async () => {
		const settings = { scene: ids.sceneA, layer: ids.layerB, effect: ids.effectA };
		const action = new ToggleEffect(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);
		assert.equal(key.state, 1, "an enabled effect shows state 1 despite the stale layer");

		await press(action, key, settings);
		await sleep(120);

		const calls = server.methods.toggleEffect.mock.calls;
		assert.equal(calls.length, 1);
		assert.deepEqual(
				calls[0].arguments,
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

		assert.equal(server.methods.toggleLayer.mock.callCount(), 0, "no command should reach Meld");
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

		assert.equal(server.methods.toggleLayer.mock.callCount(), 0, "forcing the state it is already in must not toggle");
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

		assert.equal(server.methods.toggleLayer.mock.callCount(), 1, "a differing state must toggle once");
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
		const directCalls = server.methods.setMuted.mock.callCount() + server.methods.setProperty.mock.callCount();
		assert.ok(directCalls >= 1, "force mode should use the direct setter");
		assert.equal(key.state, 0, "state 0 is muted for this action");

		// The same press against a track that does not exist must be inert.
		server.resetCalls();
		const ghost = { track: "NOSUCHTRACK", action: "mute" };
		const ghostAction = new ToggleMute(connection);
		const ghostKey = new FakeActionInstance("g", ghost);
		mount(ghostAction, [ghostKey]);
		await ghostAction.onWillAppear(willAppear(ghostKey, ghost) as never);
		await sleep(40);
		ghostKey.reset();

		ghostAction.onKeyUp(keyEvent(ghostKey, ghost) as never);
		await sleep(120);
		assert.equal(server.callCount, 0, "nothing should be sent for a missing track");
		assert.deepEqual(ghostKey.states, [], "no state should be painted for a missing track");
	});

	test("an indexed effect setting migrates and dispatches the stable mapper id", async () => {
		const settings = { scene: ids.sceneB, layer: ids.layerB, effect: indexedEffectId(ids.layerA, 1) };
		const action = new ToggleEffect(connection);
		const key = new FakeActionInstance("indexed-effect", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(40);

		assert.deepEqual(key.settingsWrites, [
			{ scene: ids.sceneA, layer: ids.layerA, effect: ids.effectAtIndex1, action: "toggle" },
		]);
		assert.equal(key.state, 1, "the indexed setting should render from the resolved stable effect");

		// Exercise a press carrying the pre-migration payload: Stream Deck can echo
		// setSettings after the user has already pressed the key.
		await press(action, key, settings);
		await sleep(120);

		assert.deepEqual(server.methods.toggleEffect.mock.calls[0].arguments, [
			ids.sceneA,
			ids.layerA,
			ids.effectAtIndex1,
		]);
		assert.equal(key.state, 0);
	});

	test("an unresolvable effect id is inert", async () => {
		const settings = { scene: ids.sceneA, layer: ids.layerA, effect: "NOT-A-MAPPER-ID" };
		const action = new ToggleEffect(connection);
		const key = new FakeActionInstance("missing-effect", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		key.reset();

		await press(action, key, settings);

		assert.equal(server.methods.toggleEffect.mock.callCount(), 0);
		assert.deepEqual(key.states, [], "an unknown effect must not paint an optimistic result");
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

	test("an unrelated repaint during the wait does not undo the press", async () => {
		// Between the press and Meld's republished snapshot, anything else that
		// triggers a render — a recording change, say — re-reads the stale
		// `visible` and would light the key again unless the pending press wins.
		const settings = { scene: ids.sceneA, layer: ids.layerA };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await sleep(60);
		assert.equal(key.state, 1, "the layer starts visible");

		await press(action, key, settings);
		key.reset();
		server.setRecording(true); // a non-session render, snapshot still stale
		await sleep(150);

		assert.ok(
			!key.states.includes(1),
			`the key must stay dark while the press is pending; painted ${JSON.stringify(key.states)}`,
		);
		server.setRecording(false);
	});

	test("a pending press is dropped when the key is retargeted", async () => {
		// The inspector can point the key at a different layer while the first
		// press is still unconfirmed; the old pending value must not describe it.
		const first = { scene: ids.sceneB, layer: ids.layerB };
		const action = new ToggleLayer(connection);
		const key = new FakeActionInstance("k", first);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, first) as never);
		await sleep(60);

		await press(action, key, first); // layerB hidden -> visible (pending)
		await sleep(60);
		key.reset();

		// layerC is hidden. If the pending "visible" leaked across the retarget the
		// key would light for a layer that is not shown, and the next press would
		// hide an already-hidden layer.
		const second = { scene: ids.sceneA, layer: ids.layerC };
		await retarget(action, key, second);
		await sleep(60);

		assert.equal(key.state, 0, "the key must show the new layer's own state, not the old pending one");
		server.resetCalls();

		await press(action, key, second);
		await sleep(800);
		assert.equal(
			(server.session.items[ids.layerC] as { visible: boolean }).visible,
			true,
			"and the press must reveal it, not hide it further",
		);
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
		assert.equal(server.methods.toggleLayer.mock.callCount(), 0);
	});
});
