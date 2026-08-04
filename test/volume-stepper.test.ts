// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The volume dial end-to-end: a real VolumeStepper on a real MeldConnection,
// talking to the result-level Meld mock. These cover the reconciliation rules that the
// dial-desync bug class kept violating — gain only ever arrives via the track
// observer, an echo of an older write must not revert a newer one, and a value
// that is never confirmed must not linger on the touchscreen.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { VolumeStepper } from "../src/actions/volume-stepper.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { SessionBuilder } from "./helpers/session-builder.ts";
import { dialRotate, disappear, FakeActionInstance, mount, willAppear } from "./helpers/fake-stream-deck.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";

type Settings = { track?: string; stepsize?: string; metertype?: string };

/** Session with one audio track at a known gain. */
function audioScenario(gain: number): { scenario: ReturnType<SessionBuilder["build"]>; trackId: string } {
	const builder = new SessionBuilder("vol");
	builder.scene("Main", { current: true });
	const trackId = builder.track("Microphone", { gain });
	return { scenario: builder.build("vol", "one track"), trackId };
}

describe("VolumeStepper", () => {
	let server: MockWebChannel;
	let connection: MeldConnection;
	let action: VolumeStepper;
	let dial: FakeActionInstance<Settings>;
	let trackId: string;
	let port = 0;

	before(async () => {
		const built = audioScenario(0.8);
		trackId = built.trackId;
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
		await disappear(action, dial);
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

		// Leave nothing visible behind: an action stays subscribed to the shared
		// connection for the process's life, so a dial left mounted keeps
		// re-registering on later tests' session updates.
		await disappear(fresh, instance);
	});

	test("a rotation sends the stepped gain to Meld", async () => {
		const before = server.gainOf(trackId);
		assert.ok(before !== undefined);

		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "1" }, 1) as never);
		await sleep(80);

		const calls = server.methods.setGain.mock.calls;
		assert.equal(calls.length, 1, "one rotation should send exactly one setGain");
		const sent = calls[0].arguments[1] as number;
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
		const slow = new MockWebChannel(audioScenario(0.5).scenario, { echoDelayMs: 400 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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

			const sends = slow.methods.setGain.mock.calls.map((call) => call.arguments[1] as number);
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
			const third = slow.methods.setGain.mock.calls.at(-1)?.arguments[1] as number;
			assert.ok(third > sends[1], `the third tick should exceed ${sends[1]}, got ${third} (a tick was lost)`);
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("a lagging echo is still rejected at the smallest usable step", async () => {
		// The echo guard compares gains with an absolute epsilon, so its correctness
		// depends on staying below the smallest per-tick delta. Near the -60 dB floor
		// with a 0.1 dB step that delta is ~1e-5 — five orders of magnitude finer
		// than a mid-scale 1 dB tick — and the step field accepts any number, so this
		// is the regime that actually bounds the constant.
		const tiny = new MockWebChannel(audioScenario(0.001).scenario, { echoDelayMs: 400 });
		const tinyPort = await tiny.listen(0);
		const tinyConnection = new MeldConnection({ port: tinyPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
		const tinyTrack = audioScenario(0.001).trackId;

		try {
			const ready = new Promise<void>((resolve) => {
				const off = tinyConnection.on("ready", () => {
					off();
					resolve();
				});
			});
			tinyConnection.connect();
			await ready;

			const settings = { track: tinyTrack, stepsize: "0.1" };
			const tinyAction = new VolumeStepper(tinyConnection);
			const tinyDial = new FakeActionInstance<Settings>("tiny-dial", settings);
			mount(tinyAction, [tinyDial]);
			await tinyAction.onWillAppear(willAppear(tinyDial, settings, "Encoder") as never);
			await sleep(500);

			tinyAction.onDialRotate(dialRotate(tinyDial, settings, 1) as never);
			await sleep(200);
			tinyAction.onDialRotate(dialRotate(tinyDial, settings, 1) as never);
			await sleep(40);

			const sends = tiny.methods.setGain.mock.calls.map((call) => call.arguments[1] as number);
			assert.equal(sends.length, 2);
			assert.ok(sends[1] > sends[0], "the second tick builds on the first");

			// Tick 1's echo lands here, carrying a value ~1e-5 away from tick 2's.
			await sleep(250);
			tinyAction.onDialRotate(dialRotate(tinyDial, settings, 1) as never);
			await sleep(60);

			const third = tiny.methods.setGain.mock.calls.at(-1)?.arguments[1] as number;
			assert.ok(
				third > sends[1],
				`the third tick must exceed ${sends[1]}, got ${third} — the lagging echo was mistaken for confirmation`,
			);
		} finally {
			tinyConnection.dispose();
			await tiny.close();
		}
	});

	test("a matching echo confirms and releases the optimistic value", async () => {
		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "1" }, 1) as never);
		await sleep(80);
		const sent = server.methods.setGain.mock.calls.at(-1)?.arguments[1] as number;
		assert.equal(server.gainOf(trackId), sent);

		// Confirmation is only observable through what happens next: with the
		// optimistic value released, an unrelated gain change from Meld repaints
		// immediately. If it were still pending, the echo guard would discard that
		// update and the dial would sit on the stale value until the TTL expired.
		dial.reset();
		server.setGain(trackId, 0.25);
		await sleep(80);

		assert.equal(
			dial.feedback?.value,
			"-12 dB",
			"a confirmed rotation must not leave an optimistic value blocking later updates",
		);

		// And the next tick must build on Meld's value, not the released one.
		const before = server.methods.setGain.mock.callCount();
		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "1" }, 1) as never);
		await sleep(80);
		const next = server.methods.setGain.mock.calls[before].arguments[1] as number;
		assert.ok(next > 0.25 && next < 0.35, `the next tick should step up from 0.25, got ${next}`);
	});

	test("an unconfirmed rotation expires back to authoritative state", async () => {
		// If Meld never confirms a rotation, the optimistic value must not sit on the
		// touchscreen indefinitely: at TTL it is dropped and the dial repaints from
		// the last authoritative gain. Here the echo is delayed past the 750ms TTL,
		// so the repaint is observable before the confirmation finally lands.
		const slow = new MockWebChannel(audioScenario(0.5).scenario, { echoDelayMs: 1_500 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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
			const slowDial = new FakeActionInstance<Settings>("expiry-dial", { track: slowTrack, stepsize: "6" });
			mount(slowAction, [slowDial]);
			await slowAction.onWillAppear(willAppear(slowDial, { track: slowTrack, stepsize: "6" }, "Encoder") as never);
			await sleep(1_700); // let the observer's delayed hydration land
			const authoritative = slowDial.feedback?.value;
			assert.ok(authoritative, "the dial should be hydrated before the rotation");

			slowAction.onDialRotate(dialRotate(slowDial, { track: slowTrack, stepsize: "6" }, 1) as never);
			await sleep(60);
			assert.notEqual(slowDial.feedback?.value, authoritative, "the rotation paints optimistically");

			// Past the TTL, still before the echo.
			await sleep(900);
			assert.equal(
				slowDial.feedback?.value,
				authoritative,
				"an unconfirmed value must expire back to the authoritative reading",
			);
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("keeps following the track after Meld restores the same session", async () => {
		// Reopening a project tears down and rebuilds Meld's audio tracks without
		// dropping the channel, which silently discards every observer registration.
		// The ids are persisted, so they come back identical — and a registration
		// deduped on "same context, same track" would never be re-sent, leaving the
		// dial frozen with no gain updates for the rest of the connection.
		// Count only what this test provokes: the shared server accumulates every
		// earlier test's registrations, so an un-reset counter is already high
		// enough to satisfy the assertion before the restore happens.
		server.resetCalls();
		server.loadScenario(audioScenario(0.4).scenario);
		await sleep(800);

		assert.equal(
			server.methods.registerTrackObserver.mock.callCount(),
			1,
			"the restore must provoke exactly one re-registration",
		);

		// And it must actually be live: an external move has to reach the dial.
		dial.reset();
		server.setGain(trackId, 0.25);
		await sleep(100);
		assert.equal(dial.feedback?.value, "-12 dB", "the dial must still follow the restored track");

		// The next tick steps from Meld's value, not a frozen one.
		const before = server.methods.setGain.mock.callCount();
		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "1" }, 1) as never);
		await sleep(80);
		const sent = server.methods.setGain.mock.calls[before].arguments[1] as number;
		assert.ok(sent > 0.25 && sent < 0.35, `expected a step up from 0.25, got ${sent}`);
	});

	test("an external gain change in Meld repaints the dial", async () => {
		server.setGain(trackId, 0.25);
		await sleep(80);
		assert.equal(dial.feedback?.value, "-12 dB", "the dial should follow Meld's own fader");
	});

	test("mute state comes from the fast gainUpdated path, ahead of the snapshot", async () => {
		// Meld emits gainUpdated immediately but republishes the session behind a
		// debounced save, so the fast path is the fresher of the two. Here the
		// snapshot still reports unmuted while the event says muted: the dial must
		// follow the event, or it shows the wrong icon for the whole debounce.
		const snapshotMuted = () => (server.session.items[trackId] as { muted: boolean }).muted;
		assert.equal(snapshotMuted(), false, "the snapshot starts unmuted");

		server.emitGainOnly(trackId, server.gainOf(trackId) as number, true);
		await sleep(80);

		assert.equal(snapshotMuted(), false, "the snapshot is deliberately still stale");
		const painted = dial.feedback;
		assert.ok(painted?.icon?.includes("audioMute"), `expected the muted icon, got ${painted?.icon}`);
		assert.ok(painted?.indicator?.bar_bg_c.includes("666666"), "a muted track shows a grey bar");

		// And the reverse: the event says unmuted, so the icon comes back.
		server.emitGainOnly(trackId, server.gainOf(trackId) as number, false);
		await sleep(80);
		assert.ok(!dial.feedback?.icon?.includes("audioMute"), "unmuting should restore the audio icon");
	});

	test("a blank step size still steps by the inspector default", async () => {
		const gainBefore = server.gainOf(trackId) as number;
		const before = server.methods.setGain.mock.callCount();
		// A user who clears the StepSize field persists "", which must not make the
		// dial a silent no-op — sending the unchanged gain counts as one.
		action.onDialRotate(dialRotate(dial, { track: trackId, stepsize: "" }, 1) as never);
		await sleep(80);

		const calls = server.methods.setGain.mock.calls;
		assert.equal(calls.length, before + 1, "a blank step size must still send a gain");
		const sent = calls.at(-1)?.arguments[1] as number;
		assert.ok(sent > gainBefore, `the gain must actually move from ${gainBefore}, got ${sent}`);
		// One 1 dB tick from mid-scale, not a jump to a rail.
		assert.ok(sent < 0.6, `a single default-sized tick must stay small, got ${sent}`);
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

		const before = server.methods.setGain.mock.callCount();
		ghost.onDialRotate(dialRotate(instance, { track: "DEADBEEF", stepsize: "1" }, 1) as never);
		await sleep(60);

		assert.equal(
			server.methods.setGain.mock.callCount(),
			before,
			"with no known gain the dial must not guess a value and send it",
		);
		assert.equal(instance.feedback?.value, "--");
	});
});
