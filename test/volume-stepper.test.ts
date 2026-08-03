// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The volume dial end-to-end: a real VolumeStepper on a real MeldConnection,
// talking to the fake Meld. These cover the reconciliation rules that the
// dial-desync bug class kept violating — gain only ever arrives via the track
// observer, an echo of an older write must not revert a newer one, and a value
// that is never confirmed must not linger on the touchscreen.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { VolumeStepper } from "../src/actions/volume-stepper.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeMeld } from "../tools/fake-meld/server.ts";
import { SessionBuilder } from "../tools/fake-meld/session.ts";
import { dialRotate, FakeActionInstance, mount, willAppear } from "./helpers/fake-stream-deck.ts";

type Settings = { track?: string; stepsize?: string; metertype?: string };

/** Session with one audio track at a known gain. */
function audioScenario(gain: number): { scenario: ReturnType<SessionBuilder["build"]>; trackId: string } {
	const builder = new SessionBuilder("vol");
	builder.scene("Main", { current: true });
	const trackId = builder.track("Microphone", { gain });
	return { scenario: builder.build("vol", "one track"), trackId };
}

describe("VolumeStepper", () => {
	let server: FakeMeld;
	let connection: MeldConnection;
	let action: VolumeStepper;
	let dial: FakeActionInstance<Settings>;
	let trackId: string;
	let port = 0;

	before(async () => {
		const built = audioScenario(0.8);
		trackId = built.trackId;
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
		// Start every test from the same mid-scale gain: the fake keeps whatever the
		// previous test left, and near full scale the dB steps clamp and stop moving.
		server.setGain(trackId, 0.5);
		// A fresh action per test: the caches under test are per-instance.
		action = new VolumeStepper(connection);
		dial = new FakeActionInstance<Settings>("dial-1", { track: trackId, stepsize: "1" });
		mount(action, [dial]);
		await action.onWillAppear(willAppear(dial, { track: trackId, stepsize: "1" }, "Encoder") as never);
		await sleep(60);
		dial.reset();
	});

	afterEach(async () => {
		// The observer registry lives on the shared connection, so a context left
		// registered would suppress the next test's hydrating gain update.
		await action.onWillDisappear({ action: dial, payload: { settings: {} } } as never);
		await sleep(20);
	});

	test("hydrates the dial from the observer's immediate gain update", async () => {
		// Registering the observer makes Meld report the current gain right away, so
		// a freshly appeared dial shows a real value rather than "--".
		const fresh = new VolumeStepper(connection);
		const instance = new FakeActionInstance<Settings>("dial-fresh", { track: trackId, stepsize: "1" });
		mount(fresh, [instance]);
		await fresh.onWillAppear(willAppear(instance, { track: trackId, stepsize: "1" }, "Encoder") as never);
		await sleep(80);

		const painted = instance.feedback;
		assert.ok(painted, "the dial should have been painted");
		assert.notEqual(painted.value, "--", "gain should be known once the observer is registered");
		assert.equal(painted.title, "Microphone");
	});

	test("a rotation sends the stepped gain to Meld", async () => {
		const before = server.gainOf(trackId);
		assert.ok(before !== undefined);

		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "1" }, 1) as never);
		await sleep(80);

		const calls = server.callsTo("setGain");
		assert.equal(calls.length, 1, "one rotation should send exactly one setGain");
		const sent = calls[0].args[1] as number;
		assert.ok(sent > before, `rotating up should raise gain from ${before}, got ${sent}`);
		// One tick at the default 1 dB step is a small move, not a jump to a rail.
		assert.ok(sent < 1, "a single tick must not slam the track to full scale");
	});

	test("a slow echo of an older write does not revert a newer rotation", async () => {
		// This is the dial-desync scenario. With Meld's echo lagging behind the
		// user's ticks, the update confirming tick 1 lands while tick 2's value is
		// already on screen. The old value must neither repaint the dial backwards
		// nor become the base for tick 3 (which would silently lose a tick).
		// The echo lag must exceed the gap between ticks, so tick 1's echo lands
		// while tick 2 is displayed and tick 2's echo is still in flight — the only
		// window in which the reconciliation rule is observable.
		const slow = new FakeMeld(audioScenario(0.5).scenario, { echoDelayMs: 400 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100 });
		const slowTrack = audioScenario(0.5).trackId;

		try {
			const ready = new Promise<void>((resolve) => {
				const off = slowConnection.on("ready", () => {
					off();
					resolve();
				});
			});
			slowConnection.connect();
			await ready;

			const slowAction = new VolumeStepper(slowConnection);
			const slowDial = new FakeActionInstance<Settings>("slow-dial", { track: slowTrack, stepsize: "1" });
			mount(slowAction, [slowDial]);
			await slowAction.onWillAppear(willAppear(slowDial, { track: slowTrack, stepsize: "1" }, "Encoder") as never);
			// Let the observer's initial (delayed) gain land so the dial is hydrated.
			await sleep(500);

			const settings = { track: slowTrack, stepsize: "1" };
			slowAction.onDialRotate(dialRotate(slowDial, settings, 1) as never); // echo lands ~t+400
			await sleep(200);
			slowAction.onDialRotate(dialRotate(slowDial, settings, 1) as never); // echo lands ~t+600
			await sleep(40);

			const sends = slow.callsTo("setGain").map((c) => c.args[1] as number);
			assert.equal(sends.length, 2, "each tick should send once");
			assert.ok(sends[1] > sends[0], "the second tick must build on the first, not repeat it");
			const paintedAfterTicks = slowDial.feedback?.value;
			slowDial.reset();

			// Now inside the window where tick 1's echo has landed but tick 2's has
			// not. Every paint in this window must still show tick 2's value.
			await sleep(250);
			for (const painted of slowDial.feedbacks) {
				assert.equal(
					painted.value,
					paintedAfterTicks,
					"the lagging echo of an older write must not repaint the dial backwards",
				);
			}

			// Tick 3, still inside that window, must continue from tick 2's value —
			// re-basing on the echoed older value silently loses a tick.
			slowAction.onDialRotate(dialRotate(slowDial, settings, 1) as never);
			await sleep(60);
			const third = slow.callsTo("setGain").at(-1)?.args[1] as number;
			assert.ok(third > sends[1], `the third tick should exceed ${sends[1]}, got ${third} (a tick was lost)`);
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("a matching echo confirms the optimistic value", async () => {
		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "1" }, 1) as never);
		await sleep(60);
		const sent = server.callsTo("setGain").at(-1)?.args[1] as number;

		// The fake echoes automatically because the observer is registered; the dial
		// should be showing the confirmed value and stay there.
		const settled = dial.feedback?.value;
		await sleep(900); // past the 750ms optimistic TTL
		assert.equal(dial.feedback?.value, settled, "a confirmed value must not change at TTL expiry");
		assert.equal(server.gainOf(trackId), sent);
	});

	test("an external gain change in Meld repaints the dial", async () => {
		server.setGain(trackId, 0.25);
		await sleep(80);
		assert.equal(dial.feedback?.value, "-12 dB", "the dial should follow Meld's own fader");
	});

	test("mute state comes from the fast gainUpdated path", async () => {
		server.setMuted(trackId, true);
		await sleep(80);
		const painted = dial.feedback;
		assert.ok(painted?.icon?.includes("audioMute"), `expected the muted icon, got ${painted?.icon}`);
		assert.ok(painted?.indicator?.bar_bg_c.includes("666666"), "a muted track shows a grey bar");

		server.setMuted(trackId, false);
		await sleep(80);
		assert.ok(!dial.feedback?.icon?.includes("audioMute"), "unmuting should restore the audio icon");
	});

	test("a blank step size still steps by the inspector default", async () => {
		const before = server.callsTo("setGain").length;
		// A user who clears the StepSize field persists "", which must not make the
		// dial a silent no-op.
		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "" }, 1) as never);
		await sleep(60);

		const calls = server.callsTo("setGain");
		assert.equal(calls.length, before + 1, "a blank step size must still move the gain");
		assert.notEqual(calls.at(-1)?.args[1], server.gainOf(trackId) === 0 ? 0 : undefined);
	});

	test("a dial bound to no track paints the unknown indicator", async () => {
		const unbound = new VolumeStepper(connection);
		const instance = new FakeActionInstance<Settings>("dial-unbound", {});
		mount(unbound, [instance]);
		await unbound.onWillAppear(willAppear(instance, {}, "Encoder") as never);
		await sleep(60);

		assert.equal(instance.feedback?.value, "--");
		assert.equal(instance.feedback?.title, "Adjust Volume");
	});

	test("rotating a track Meld does not know is a no-op", async () => {
		const ghost = new VolumeStepper(connection);
		const instance = new FakeActionInstance<Settings>("dial-ghost", { track: "DEADBEEF", stepsize: "1" });
		mount(ghost, [instance]);
		await ghost.onWillAppear(willAppear(instance, { track: "DEADBEEF", stepsize: "1" }, "Encoder") as never);
		await sleep(60);

		const before = server.callsTo("setGain").length;
		ghost.onDialRotate(dialRotate(instance, { track: "DEADBEEF", stepsize: "1" }, 1) as never);
		await sleep(60);

		assert.equal(
			server.callsTo("setGain").length,
			before,
			"with no known gain the dial must not guess a value and send it",
		);
		assert.equal(instance.feedback?.value, "--");
	});
});
