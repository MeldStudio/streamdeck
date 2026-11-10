// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The Camera Background action, driven end-to-end against the result-level
// Meld mock. Meld publishes `backgroundEffectEnabled` on camera layers only and
// has no dedicated toggle call, so the action reads the snapshot and writes the
// property back through `setProperty`. Meld 0.10.7.5 and later accept the write
// even when they never publish the field: Enable / Disable must still work
// there, and Toggle must refuse rather than guess.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { BACKGROUND_EFFECT_PROPERTY, ToggleBackgroundEffect } from "../src/actions/toggle-background-effect.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeActionInstance, mount, press, retarget, willAppear } from "./helpers/fake-stream-deck.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";
import { type FakeLayer, type Scenario, SessionBuilder } from "./helpers/session-builder.ts";

/** One scene holding a camera with the effect on, a camera with it off, and an image layer. */
function build(namespace: string): { scenario: Scenario; ids: Record<string, string> } {
	const b = new SessionBuilder(namespace);
	const scene = b.scene("Main", { current: true });
	const other = b.scene("BRB");
	const cameraOn = b.layer(scene, "Webcam", { backgroundEffectEnabled: true });
	const cameraOff = b.layer(scene, "Face Cam", { backgroundEffectEnabled: false });
	const image = b.layer(scene, "Frame", { source: "file:///frame.png" });
	// A camera on a Meld build that predates the field looks like a plain layer.
	const legacyCamera = b.layer(other, "Old Webcam");
	return { scenario: b.build(namespace, "camera background"), ids: { scene, other, cameraOn, cameraOff, image, legacyCamera } };
}

/**
 * A Meld build that accepts the property but does not publish it: no layer
 * carries the field, so cameras and other layers look alike.
 */
function buildLegacy(namespace: string): { scenario: Scenario; ids: Record<string, string> } {
	const b = new SessionBuilder(namespace);
	const scene = b.scene("Main", { current: true });
	const camera = b.layer(scene, "Webcam");
	const image = b.layer(scene, "Frame", { source: "file:///frame.png" });
	return { scenario: b.build(namespace, "camera background (legacy)"), ids: { scene, camera, image } };
}

describe("camera background effect", () => {
	let server: MockWebChannel;
	let connection: MeldConnection;
	let ids: Record<string, string>;
	let port = 0;

	before(async () => {
		const built = build("bg");
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
		server.loadScenario(build("bg").scenario);
		server.resetCalls();
		// The reloaded snapshot rides the autosave debounce.
		await sleep(700);
	});

	test("the key reflects the camera's published state", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const on = new FakeActionInstance("on", { scene: ids.scene, layer: ids.cameraOn });
		const off = new FakeActionInstance("off", { scene: ids.scene, layer: ids.cameraOff });
		mount(action, [on, off]);
		await action.onWillAppear(willAppear(on, { scene: ids.scene, layer: ids.cameraOn }) as never);
		await action.onWillAppear(willAppear(off, { scene: ids.scene, layer: ids.cameraOff }) as never);

		assert.equal(on.state, 0, "an enabled effect shows the active state");
		assert.equal(off.state, 1, "a disabled effect shows the inactive state");
	});

	test("toggle writes the inverse of the authoritative value and follows the echo", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const settings = { scene: ids.scene, layer: ids.cameraOn, action: "toggle" };
		const key = new FakeActionInstance("toggle", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);

		await press(action, key, settings);
		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [
			ids.cameraOn,
			BACKGROUND_EFFECT_PROPERTY,
			false,
		]);
		assert.equal(key.state, 1, "the press is painted before Meld confirms it");

		// A second press before the (debounced) snapshot arrives reasons from the
		// pending value, not the stale snapshot, so it does not undo the first.
		await press(action, key, settings);
		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [
			ids.cameraOn,
			BACKGROUND_EFFECT_PROPERTY,
			true,
		]);
		assert.equal(key.state, 0);

		await sleep(700);
		assert.equal((server.session.items[ids.cameraOn] as FakeLayer).backgroundEffectEnabled, true);
		assert.equal(key.state, 0, "the confirmed snapshot agrees with the last press");
	});

	test("enable and disable are idempotent writes", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const key = new FakeActionInstance("force", { scene: ids.scene, layer: ids.cameraOn, action: "enable" });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.scene, layer: ids.cameraOn, action: "enable" }) as never);

		// Already enabled: the write still goes out (Meld ignores a no-op set) and
		// the key stays in the enabled state rather than toggling.
		await press(action, key, { scene: ids.scene, layer: ids.cameraOn, action: "enable" });
		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [
			ids.cameraOn,
			BACKGROUND_EFFECT_PROPERTY,
			true,
		]);
		assert.equal(key.state, 0);

		await press(action, key, { scene: ids.scene, layer: ids.cameraOn, action: "disable" });
		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [
			ids.cameraOn,
			BACKGROUND_EFFECT_PROPERTY,
			false,
		]);
		assert.equal(key.state, 1);

		await sleep(700);
		assert.equal((server.session.items[ids.cameraOn] as FakeLayer).backgroundEffectEnabled, false);
	});

	test("a camera whose state Meld does not publish still accepts enable and disable", async () => {
		const legacy = buildLegacy("bg-legacy");
		server.loadScenario(legacy.scenario);
		await sleep(700);

		const action = new ToggleBackgroundEffect(connection);
		const settings = { scene: legacy.ids.scene, layer: legacy.ids.camera, action: "enable" };
		const key = new FakeActionInstance("legacy", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		assert.equal(key.state, 1, "an unknown state renders as inactive");
		const painted = key.states.length;

		await press(action, key, settings);
		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [
			legacy.ids.camera,
			BACKGROUND_EFFECT_PROPERTY,
			true,
		]);

		await press(action, key, { ...settings, action: "disable" });
		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [
			legacy.ids.camera,
			BACKGROUND_EFFECT_PROPERTY,
			false,
		]);
		// No snapshot will ever confirm either write, so painting the desired state
		// would light the key for the pending window and then drop it back to the
		// unknown state while the effect is actually on.
		assert.deepEqual(key.states.slice(painted), [], "no unconfirmable state is painted");
	});

	test("toggle refuses to guess when Meld does not publish the state", async () => {
		const legacy = buildLegacy("bg-legacy");
		server.loadScenario(legacy.scenario);
		await sleep(700);

		const action = new ToggleBackgroundEffect(connection);
		const settings = { scene: legacy.ids.scene, layer: legacy.ids.camera, action: "toggle" };
		const key = new FakeActionInstance("legacy-toggle", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);

		await press(action, key, settings);

		assert.equal(server.methods.setProperty.mock.callCount(), 0, "nothing is written blind");
		assert.equal(key.state, 1, "no state is faked");
	});

	test("a non-camera layer is never written once Meld identifies cameras", async () => {
		// A key configured against a build that listed every layer may point at an
		// image or text layer. Once Meld publishes the field, its absence means the
		// layer is not a camera, so no mode may write to it.
		const action = new ToggleBackgroundEffect(connection);
		for (const mode of ["toggle", "enable", "disable"]) {
			const settings = { scene: ids.scene, layer: ids.image, action: mode };
			const key = new FakeActionInstance(`image-${mode}`, settings);
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, settings) as never);
			const painted = key.states.length;
			await press(action, key, settings);
			assert.deepEqual(key.states.slice(painted), [], `${mode}: no state is painted`);
		}
		assert.equal(server.methods.setProperty.mock.callCount(), 0);
	});

	test("two toggle keys on one camera build on each other's presses", async () => {
		// Meld has no toggle call for this switch, so each press writes an absolute
		// value. Two keys reasoning from their own presses would both read the stale
		// snapshot and write the same value, losing one toggle.
		const action = new ToggleBackgroundEffect(connection);
		const settings = { scene: ids.scene, layer: ids.cameraOn, action: "toggle" };
		const a = new FakeActionInstance("two-a", settings);
		const b = new FakeActionInstance("two-b", settings);
		mount(action, [a, b]);
		await action.onWillAppear(willAppear(a, settings) as never);
		await action.onWillAppear(willAppear(b, settings) as never);

		await press(action, a, settings);
		await sleep(20);
		assert.equal(b.state, 1, "the other key shows the press too");
		await press(action, b, settings);
		await sleep(20);

		assert.deepEqual(
			server.methods.setProperty.mock.calls.map((call) => call.arguments[2]),
			[false, true],
		);
		assert.equal(a.state, 0);
		assert.equal(b.state, 0);

		await sleep(700);
		assert.equal((server.session.items[ids.cameraOn] as FakeLayer).backgroundEffectEnabled, true);
		assert.equal(a.state, 0);
		assert.equal(b.state, 0);
	});

	test("toggle builds on another key's enable or disable", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const toggle = { scene: ids.scene, layer: ids.cameraOn, action: "toggle" };
		const enable = { scene: ids.scene, layer: ids.cameraOn, action: "enable" };
		const a = new FakeActionInstance("mixed-toggle", toggle);
		const b = new FakeActionInstance("mixed-enable", enable);
		mount(action, [a, b]);
		await action.onWillAppear(willAppear(a, toggle) as never);
		await action.onWillAppear(willAppear(b, enable) as never);

		await press(action, a, toggle);
		await press(action, b, enable);
		await press(action, a, toggle);
		await sleep(20);

		assert.deepEqual(
			server.methods.setProperty.mock.calls.map((call) => call.arguments[2]),
			[false, true, false],
		);
		assert.equal(a.state, 1);
		assert.equal(b.state, 1);
	});

	test("a layer missing from the current Meld instance is never written to", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const foreign = build("another-meld").ids.cameraOn;
		for (const mode of ["toggle", "enable", "disable"]) {
			const settings = { scene: ids.scene, layer: foreign, action: mode };
			const key = new FakeActionInstance(`foreign-${mode}`, settings);
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, settings) as never);
			assert.equal(key.state, 1, `${mode}: a missing layer shows the inactive state`);
			await press(action, key, settings);
		}
		assert.equal(server.methods.setProperty.mock.callCount(), 0);
	});

	test("a stale stored scene is repaired from the layer's real parent", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const stale = { scene: ids.other, layer: ids.cameraOff, action: "toggle" };
		const key = new FakeActionInstance("stale", stale);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, stale) as never);

		assert.deepEqual(key.settingsWrites.at(-1), { scene: ids.scene, layer: ids.cameraOff, action: "toggle" });
		assert.equal(key.state, 1, "the layer id alone identifies the target");
	});

	test("retargeting the key drops the previous layer's pending press", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const first = { scene: ids.scene, layer: ids.cameraOn, action: "toggle" };
		const key = new FakeActionInstance("retarget", first);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, first) as never);
		await press(action, key, first);
		assert.equal(key.state, 1, "the pending press paints the inverse");

		await retarget(action, key, { scene: ids.scene, layer: ids.cameraOff, action: "toggle" });
		assert.equal(key.state, 1, "the new camera's authoritative state is shown");

		await press(action, key, { scene: ids.scene, layer: ids.cameraOff, action: "toggle" });
		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [
			ids.cameraOff,
			BACKGROUND_EFFECT_PROPERTY,
			true,
		]);
	});

	test("an unconfigured key paints nothing and ignores presses", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const key = new FakeActionInstance("unconfigured", { action: "toggle" });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { action: "toggle" }) as never);
		await press(action, key, { action: "toggle" });

		assert.equal(key.state, undefined);
		assert.equal(server.methods.setProperty.mock.callCount(), 0);
	});

	test("a Meld build without setProperty receives nothing", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const key = new FakeActionInstance("no-set-property", { scene: ids.scene, layer: ids.cameraOff, action: "toggle" });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.scene, layer: ids.cameraOff, action: "toggle" }) as never);
		const setProperty = server.meld.setProperty;
		server.meld.setProperty = undefined;
		const painted = key.states.length;
		try {
			await press(action, key, { scene: ids.scene, layer: ids.cameraOff, action: "toggle" });
			await press(action, key, { scene: ids.scene, layer: ids.cameraOff, action: "enable" });
		} finally {
			server.meld.setProperty = setProperty;
		}
		assert.equal(server.methods.setProperty.mock.callCount(), 0);
		assert.deepEqual(key.states.slice(painted), [], "no state is painted for a write that cannot happen");
	});

	test("an unconfirmed press does not leak into a restarted Meld instance", async () => {
		const settings = { scene: ids.scene, layer: ids.cameraOn, action: "toggle" };
		const action = new ToggleBackgroundEffect(connection);
		const key = new FakeActionInstance("restart", settings);
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, settings) as never);
		await press(action, key, settings);
		assert.equal(key.state, 1, "the in-flight press is painted immediately");

		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;
		// With Meld gone there is no session to act on: a press is dropped, and the
		// key keeps what it last showed rather than guessing.
		key.reset();
		await press(action, key, settings);
		assert.equal(key.state, undefined);

		// The same project reopened: the ids match, and the effect is still on.
		server = new MockWebChannel(build("bg").scenario);
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		await server.listen(port);
		await ready;
		await sleep(60);

		assert.equal(key.state, 0, "the restarted instance's published state is authoritative");
	});

	test("the implicit press mode is migrated to an explicit toggle", async () => {
		const action = new ToggleBackgroundEffect(connection);
		const key = new FakeActionInstance("migrate", { scene: ids.scene, layer: ids.cameraOn });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { scene: ids.scene, layer: ids.cameraOn }) as never);
		assert.deepEqual(key.settingsWrites.at(-1), { scene: ids.scene, layer: ids.cameraOn, action: "toggle" });
	});
});
