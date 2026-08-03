// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The transition dial, driven end-to-end against the fake Meld. Meld resolves
// `setStagedScene` through its horizontal scene model only — unlike `showScene`,
// which also searches the vertical one — so anything the dial offers from the
// vertical canvas is a selection it can never actually reach.

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { TransitionStepper } from "../src/actions/transition-stepper.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeMeld } from "../tools/fake-meld/server.ts";
import { type Scenario, SessionBuilder } from "../tools/fake-meld/session.ts";
import { dialRotate, FakeActionInstance, keyEvent, mount, willAppear } from "./helpers/fake-stream-deck.ts";

/** Three horizontal scenes plus a vertical twin of the first. */
function build(): { scenario: Scenario; ids: Record<string, string> } {
	const b = new SessionBuilder("trans");
	const alpha = b.scene("Alpha", { current: true });
	const bravo = b.scene("Bravo");
	const charlie = b.scene("Charlie");
	const alphaV = b.scene("Alpha", { vertical: true });
	return { scenario: b.build("trans", "transition"), ids: { alpha, bravo, charlie, alphaV } };
}

describe("TransitionStepper", () => {
	let server: FakeMeld;
	let connection: MeldConnection;
	let action: TransitionStepper;
	let dial: FakeActionInstance;
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
		action = new TransitionStepper(connection);
		dial = new FakeActionInstance("dial", {});
		mount(action, [dial]);
		await action.onWillAppear(willAppear(dial, {}, "Encoder") as never);
		await sleep(40);
	});

	test("never offers a vertical-canvas scene", async () => {
		// Rotating a full turn through the selectable scenes must never land on the
		// vertical twin: Meld would refuse to stage it and the dial would show a
		// selection that does not exist.
		const staged: string[] = [];
		for (let i = 0; i < 6; i++) {
			action.onDialRotate(dialRotate(dial, {}, 1) as never);
			await sleep(40);
			staged.push(server.callsTo("setStagedScene").at(-1)?.args[0] as string);
		}

		assert.equal(staged.includes(ids.alphaV), false, "the vertical twin must never be staged");
		assert.deepEqual(
			[...new Set(staged)].sort(),
			[ids.bravo, ids.charlie].sort(),
			"only the non-current horizontal scenes are selectable",
		);
	});

	test("every scene the dial stages is one Meld accepts", async () => {
		// The fake enforces Meld's own rule, so a refused stage leaves nothing
		// staged — the dial would then be showing a name the session disagrees with.
		action.onDialRotate(dialRotate(dial, {}, 1) as never);
		await sleep(60);

		const requested = server.callsTo("setStagedScene").at(-1)?.args[0] as string;
		const stagedInMeld = Object.entries(server.session.items).find(
			([, item]) => item.type === "scene" && item.staged,
		)?.[0];
		assert.equal(stagedInMeld, requested, "Meld must have accepted the scene the dial selected");
		assert.equal(dial.feedback?.title, (server.session.items[requested] as { name: string }).name);
	});

	test("pressing the dial transitions to the staged scene", async () => {
		action.onDialRotate(dialRotate(dial, {}, 1) as never);
		await sleep(60);
		const requested = server.callsTo("setStagedScene").at(-1)?.args[0] as string;

		action.onDialDown(keyEvent(dial, {}) as never);
		await sleep(80);

		assert.equal(server.callsTo("showStagedScene").length, 1);
		assert.equal(
			(server.session.items[requested] as { current: boolean }).current,
			true,
			"the staged scene should have become current",
		);
	});

	test("rotation is inert while Meld is unreachable", async () => {
		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;

		const painted = dial.feedback?.title;
		action.onDialRotate(dialRotate(dial, {}, 1) as never);
		await sleep(40);
		assert.equal(dial.feedback?.title, painted, "a disconnected dial must not fake a selection");

		// Restore the instance for the remaining tests.
		server = new FakeMeld(build().scenario);
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		await server.listen(port);
		await ready;
	});
});
