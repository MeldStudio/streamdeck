// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The real ui/lib/meld-pi.js, driven against a fake DOM. It backs the property
// inspectors of 7 of the 14 actions, and its failures are quiet: a dropdown that
// silently lists nothing reads as "Meld has no scenes" rather than a plugin
// fault, and a settings chain left mismatched produces a key that looks
// configured but does nothing.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FakeInput, FakeSelect, loadPropertyInspector } from "./helpers/fake-dom.ts";

/** Session items covering two scenes, their layers, and an effect. */
const ITEMS = {
	sceneA: { type: "scene", name: "Scene A", current: true, staged: false, vertical: false, index: 0 },
	sceneB: { type: "scene", name: "Scene B", current: false, staged: false, vertical: false, index: 1 },
	sceneV: { type: "scene", name: "Scene A [Vertical]", current: false, staged: false, vertical: true, index: 2 },
	layerA1: { type: "layer", name: "Camera", parent: "sceneA", visible: true, index: 0 },
	layerA2: { type: "layer", name: "Overlay", parent: "sceneA", visible: false, index: 1 },
	layerB1: { type: "layer", name: "Slides", parent: "sceneB", visible: true, index: 0 },
	effectA1: { type: "effect", name: "Blur", parent: "layerA1", enabled: true },
	trackMic: { type: "track", name: "Microphone", muted: false, monitoring: false },
};

describe("property inspector runtime", () => {
	test("registers with Stream Deck and asks the plugin for the session", () => {
		const pi = loadPropertyInspector();
		pi.socket.open();

		const register = pi.socket.framesFor("registerPropertyInspector");
		assert.equal(register.length, 1, "the inspector must register itself");

		const requests = pi.socket
			.framesFor("sendToPlugin")
			.filter((f) => (f.payload as { event?: string })?.event === "meld.getSession");
		assert.equal(requests.length, 1, "it must ask the plugin for a snapshot on open");
	});

	test("a root select lists every item of its type", () => {
		const pi = loadPropertyInspector();
		const scene = pi.element("scene", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene"]);
		pi.pushSession(ITEMS);

		assert.deepEqual(scene.labels, ["[No Selection]", "Scene A", "Scene B", "Scene A [Vertical]"]);
		assert.equal(scene.value, "", "nothing configured means no selection");
	});

	test("a keepFilter hides items the action cannot use", () => {
		// show-scene filters out the vertical twins Meld publishes.
		const pi = loadPropertyInspector();
		const scene = pi.element("scene", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene"], (type, item) =>
			type === "scene" ? !(item as { vertical?: boolean }).vertical : true,
		);
		pi.pushSession(ITEMS);

		assert.deepEqual(scene.labels, ["[No Selection]", "Scene A", "Scene B"]);
	});

	test("a child select lists only the chosen parent's children", () => {
		const pi = loadPropertyInspector({ scene: "sceneA" });
		const scene = pi.element("scene", new FakeSelect());
		const layer = pi.element("layer", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene", "layer"]);
		pi.pushSession(ITEMS);

		assert.equal(scene.value, "sceneA");
		assert.deepEqual(layer.labels, ["[No Selection]", "Camera", "Overlay"]);
		assert.equal(layer.values.includes("layerB1"), false, "another scene's layer must not be offered");
	});

	test("a child select is empty while no parent is chosen", () => {
		// Otherwise the user could pick a layer that belongs to no selected scene.
		const pi = loadPropertyInspector();
		pi.element("scene", new FakeSelect());
		const layer = pi.element("layer", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene", "layer"]);
		pi.pushSession(ITEMS);

		assert.deepEqual(layer.labels, ["[No Selection]"]);
	});

	test("changing a parent clears every downstream id in one write", () => {
		const pi = loadPropertyInspector({ scene: "sceneA", layer: "layerA1", effect: "effectA1" });
		const scene = pi.element("scene", new FakeSelect());
		pi.element("layer", new FakeSelect());
		pi.element("effect", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene", "layer", "effect"]);
		pi.pushSession(ITEMS);
		pi.socket.open();
		pi.socket.sent.length = 0;

		scene.choose("sceneB");

		const writes = pi.socket.framesFor("setSettings");
		assert.equal(writes.length, 1, "one atomic write, never a half-updated chain");
		assert.deepEqual(writes[0].payload, { scene: "sceneB", layer: "", effect: "" });
	});

	test("a stale child id shows [No Selection] rather than a blank control", () => {
		// Legacy profiles hold pairs like {scene: B, layer: <child of A>} because the
		// old inspector never cleared downstream keys.
		const pi = loadPropertyInspector({ scene: "sceneB", layer: "layerA1" });
		const scene = pi.element("scene", new FakeSelect());
		const layer = pi.element("layer", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene", "layer"]);
		pi.pushSession(ITEMS);

		assert.equal(scene.value, "sceneB");
		assert.equal(layer.selectedIndex, 0, "a stale id must fall back to the placeholder");
		assert.equal(layer.labels[0], "[No Selection]");
		assert.deepEqual(layer.labels, ["[No Selection]", "Slides"], "only the new parent's children are offered");
	});

	test("a stale mid-chain id does not unfilter the select below it", () => {
		// With the layer reset to the placeholder, the effect list must stay empty
		// rather than offering every effect in the session.
		const pi = loadPropertyInspector({ scene: "sceneB", layer: "layerA1", effect: "effectA1" });
		pi.element("scene", new FakeSelect());
		const layer = pi.element("layer", new FakeSelect());
		const effect = pi.element("effect", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene", "layer", "effect"]);
		pi.pushSession(ITEMS);

		assert.equal(layer.value, "", "the stale layer resolves to no selection");
		assert.deepEqual(effect.labels, ["[No Selection]"], "no effect may be offered without a layer");
	});

	test("selects repopulate when a new Meld instance publishes different ids", () => {
		const pi = loadPropertyInspector({ scene: "sceneA" });
		const scene = pi.element("scene", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene"]);
		pi.pushSession(ITEMS);
		assert.equal(scene.value, "sceneA");

		// A different project: all-new ids.
		pi.pushSession({
			fresh1: { type: "scene", name: "Live", current: true, staged: false, vertical: false, index: 0 },
		});

		assert.deepEqual(scene.labels, ["[No Selection]", "Live"]);
		assert.equal(scene.selectedIndex, 0, "the old id is gone, so the placeholder shows");
	});

	test("an empty session leaves only the placeholder", () => {
		const pi = loadPropertyInspector();
		const track = pi.element("track", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["track"]);
		pi.pushSession({}, false);

		assert.deepEqual(track.labels, ["[No Selection]"]);
	});

	test("choosing an item persists exactly that id", () => {
		const pi = loadPropertyInspector();
		const track = pi.element("track", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["track"]);
		pi.pushSession(ITEMS);
		pi.socket.open();
		pi.socket.sent.length = 0;

		track.choose("trackMic");

		const writes = pi.socket.framesFor("setSettings");
		assert.equal(writes.length, 1);
		assert.deepEqual(writes[0].payload, { track: "trackMic" });
	});

	test("bindField applies its fallback when the setting is absent", () => {
		const pi = loadPropertyInspector();
		const step = pi.element("stepsize", new FakeInput());
		pi.MeldPI.bindField("stepsize", "1");

		assert.equal(step.value, "1", "the inspector shows the documented default");
	});

	test("bindField shows the stored value over the fallback", () => {
		const pi = loadPropertyInspector({ stepsize: "3" });
		const step = pi.element("stepsize", new FakeInput());
		pi.MeldPI.bindField("stepsize", "1");

		assert.equal(step.value, "3");
	});

	test("editing a field persists it without disturbing other settings", () => {
		const pi = loadPropertyInspector({ track: "trackMic", metertype: "db" });
		const step = pi.element("stepsize", new FakeInput());
		pi.MeldPI.bindField("stepsize", "1");
		pi.socket.open();
		pi.socket.sent.length = 0;

		step.enter("5");

		const writes = pi.socket.framesFor("setSettings");
		assert.equal(writes.length, 1);
		assert.deepEqual(writes[0].payload, { track: "trackMic", metertype: "db", stepsize: "5" });
	});

	test("settings pushed by Stream Deck are reflected in the controls", () => {
		const pi = loadPropertyInspector({ scene: "sceneA" });
		const scene = pi.element("scene", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene"]);
		pi.pushSession(ITEMS);
		assert.equal(scene.value, "sceneA");

		pi.pushSettings({ scene: "sceneB" });
		assert.equal(scene.value, "sceneB", "an external settings change must move the control");
	});

	test("watchConnection hides its notice only while Meld is connected", () => {
		const pi = loadPropertyInspector();
		const loading = pi.element("loading", new FakeSelect());
		pi.MeldPI.watchConnection("loading");

		// Before any snapshot the plugin is assumed disconnected.
		assert.equal(loading.style.display, "", "the notice shows until the plugin reports a connection");

		pi.pushSession(ITEMS, true);
		assert.equal(loading.style.display, "none");

		pi.pushSession({}, false);
		assert.equal(loading.style.display, "", "losing Meld must bring the notice back");
	});

	test("a malformed frame is ignored rather than breaking the inspector", () => {
		const pi = loadPropertyInspector();
		const scene = pi.element("scene", new FakeSelect());
		pi.MeldPI.bindSessionSelects(["scene"]);

		assert.doesNotThrow(() => pi.socket.onmessage?.({ data: "not json" }));
		pi.pushSession(ITEMS);
		assert.deepEqual(scene.labels, ["[No Selection]", "Scene A", "Scene B", "Scene A [Vertical]"]);
	});

	test("binding an id with no matching element is harmless", () => {
		// Several inspectors bind a field their markup omits.
		const pi = loadPropertyInspector();
		assert.doesNotThrow(() => pi.MeldPI.bindSessionSelects(["scene", "layer"]));
		assert.doesNotThrow(() => pi.MeldPI.bindField("action", "toggle"));
		assert.doesNotThrow(() => pi.MeldPI.watchConnection("loading"));
	});
});
