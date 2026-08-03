// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// MeldSession is the one place that understands the shape of `session.items`.
// The snapshots here are built with the same builder the fake Meld uses, so they
// carry the exact fields StreamDeckMapper.cpp emits.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MeldSession } from "../src/meld/session.ts";
import type { Session } from "../src/meld/types.ts";
import { SessionBuilder } from "../tools/fake-meld/session.ts";

/** A snapshot with a scene, two layers, an effect and two tracks. */
function build(): { session: Session; ids: Record<string, string> } {
	const b = new SessionBuilder("sess");
	const scene = b.scene("Main", { current: true });
	const other = b.scene("Other", { staged: true });
	const camera = b.layer(scene, "Camera");
	const overlay = b.layer(scene, "Overlay", { visible: false });
	const stray = b.layer(other, "Stray");
	const effect = b.effect(camera, "Blur");
	const mic = b.track("Microphone");
	const owned = b.track("Game", { parent: camera });
	const scenario = b.build("sess", "selectors");
	return {
		session: scenario.session as Session,
		ids: { scene, other, camera, overlay, stray, effect, mic, owned },
	};
}

describe("MeldSession", () => {
	test("reports absence for an empty or missing snapshot", () => {
		const empty = new MeldSession(undefined);
		assert.equal(empty.isPresent, false);
		assert.deepEqual(empty.items, {});
		assert.deepEqual(empty.scenes(), []);
		assert.equal(empty.get("anything"), undefined);
		assert.equal(empty.has("anything"), false);
	});

	test("typed selectors return only items of the matching type", () => {
		const { session, ids } = build();
		const s = new MeldSession(session);

		assert.equal(s.getScene(ids.scene)?.name, "Main");
		assert.equal(s.getLayer(ids.camera)?.name, "Camera");
		assert.equal(s.getEffect(ids.effect)?.name, "Blur");
		assert.equal(s.getTrack(ids.mic)?.name, "Microphone");

		// Asking for the wrong type must not return the item.
		assert.equal(s.getTrack(ids.scene), undefined);
		assert.equal(s.getScene(ids.camera), undefined);
		assert.equal(s.getLayer(ids.effect), undefined);
		assert.equal(s.getEffect(ids.mic), undefined);
	});

	test("selectors pair each item with its id", () => {
		const { session, ids } = build();
		const s = new MeldSession(session);
		assert.equal(s.getScene(ids.scene)?.id, ids.scene);
		assert.equal(s.get(ids.mic)?.id, ids.mic);
	});

	test("undefined ids resolve to undefined rather than throwing", () => {
		const { session } = build();
		const s = new MeldSession(session);
		assert.equal(s.get(undefined), undefined);
		assert.equal(s.getScene(undefined), undefined);
		assert.equal(s.getTrack(undefined), undefined);
		assert.equal(s.has(undefined), false);
	});

	test("byType filters to a parent when one is given", () => {
		const { session, ids } = build();
		const s = new MeldSession(session);

		assert.deepEqual(
			s.layers(ids.scene).map((l) => l.name).sort(),
			["Camera", "Overlay"],
		);
		assert.deepEqual(
			s.layers(ids.other).map((l) => l.name),
			["Stray"],
		);
		assert.deepEqual(s.effects(ids.camera).map((e) => e.name), ["Blur"]);
		assert.deepEqual(s.effects(ids.overlay), []);
	});

	test("tracks filter by parent, and parentless tracks are excluded", () => {
		const { session, ids } = build();
		const s = new MeldSession(session);

		// Meld omits `parent` entirely for tracks with no scene object, so a
		// parent-filtered query must not match them.
		assert.deepEqual(s.tracks(ids.camera).map((t) => t.name), ["Game"]);
		assert.deepEqual(s.tracks().map((t) => t.name).sort(), ["Game", "Microphone"]);
	});

	test("scenes carry the flags the actions key off", () => {
		const { session, ids } = build();
		const scenes = new MeldSession(session).scenes();

		const current = scenes.find((s) => s.current);
		const staged = scenes.find((s) => s.staged);
		assert.equal(current?.id, ids.scene);
		assert.equal(staged?.id, ids.other);
		// `vertical` is what the property inspectors filter on.
		assert.equal(scenes.every((s) => s.vertical === false), true);
	});

	test("find returns the first match with its id", () => {
		const { session, ids } = build();
		const s = new MeldSession(session);

		const found = s.find((item) => item.type === "track" && item.name === "Microphone");
		assert.equal(found?.id, ids.mic);
		assert.equal(s.find(() => false), undefined);
	});

	test("a key inherited from Object.prototype is not mistaken for an item", () => {
		// Item ids are opaque strings from Meld; a lookup that consulted the
		// prototype chain would resolve "constructor" or "toString" to a function.
		const s = new MeldSession({ items: {} });
		assert.equal(s.has("constructor"), false);
		assert.equal(s.get("toString"), undefined);
		assert.equal(s.getTrack("hasOwnProperty"), undefined);
	});
});
