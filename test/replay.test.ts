// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The replay controls act on a track the user never selects: the action finds it
// by name. Its gain never appears in the session snapshot, so it is only known
// through the track observer — which is what these tests pin down.

import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Replay } from "../src/actions/replay.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeMeld } from "../tools/fake-meld/server.ts";
import { SessionBuilder } from "../tools/fake-meld/session.ts";
import { disappear, FakeActionInstance, keyEvent, press, mount, willAppear } from "./helpers/fake-stream-deck.ts";

type Settings = { action?: string };

/**
 * Waits for a condition instead of guessing how long a round-trip takes.
 * @param condition Polled until it returns true.
 * @param timeoutMs How long to wait before giving up.
 */
async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("timed out waiting for condition");
		}
		await sleep(10);
	}
}

/** A session containing the replay clip's layer and its audio track. */
function replayScenario(gain: number): { scenario: ReturnType<SessionBuilder["build"]>; trackId: string } {
	const b = new SessionBuilder("replay");
	const scene = b.scene("Live", { current: true });
	const clip = b.layer(scene, "Replay Clip", { mediaSource: "replay.mp4", isPlaying: true });
	// The action locates the track by this exact name.
	const trackId = b.track("Replay Clip", { parent: clip, gain });
	return { scenario: b.build("replay", "replay clip"), trackId };
}

describe("Replay", () => {
	let server: FakeMeld;
	let connection: MeldConnection;
	let action: Replay;
	let key: FakeActionInstance<Settings>;
	let trackId: string;
	let port = 0;

	before(async () => {
		const built = replayScenario(0.5);
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
		server.setGain(trackId, 0.5);
		server.invocations.length = 0;
		action = new Replay(connection);
		key = new FakeActionInstance<Settings>("replay-key", { action: "volume_up" });
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, { action: "volume_up" }) as never);
		// The action learns the gain from the observer registration round-trip. Wait
		// for that to actually land rather than guessing a duration, so a slow
		// machine cannot turn a passing test into a false failure.
		await waitFor(() => server.callsTo("registerTrackObserver").length > 0);
		await sleep(20);
	});

	afterEach(async () => {
		// Replay's observer context is a constant shared by every replay key, and
		// the registry lives on the connection, so a context left registered makes
		// the next test's registration a no-op and its gain never arrives.
		await disappear(action, key);
		await sleep(20);
	});

	test("observes the replay track so its gain is known before any press", async () => {
		const registrations = server.callsTo("registerTrackObserver");
		assert.ok(registrations.length >= 1, "the replay track should be observed");
		assert.equal(registrations.at(-1)?.args[1], trackId);
	});

	test("volume up raises the gain rather than slamming it to silence", async () => {
		const before = server.gainOf(trackId) as number;
		await press(action, key, { action: "volume_up" });
		await sleep(80);

		const sent = server.callsTo("setGain").at(-1)?.args[1] as number;
		assert.ok(sent !== undefined, "the press should reach Meld");
		assert.ok(sent > before, `volume up should raise gain from ${before}, got ${sent}`);
		// Stepping from an assumed 0 would land near the -60 dB floor.
		assert.ok(sent > 0.1, `volume up must not collapse the track toward silence (${sent})`);
	});

	test("a volume press before the track's gain is known does nothing", async () => {
		// The track is identified from the session, but its gain only arrives via
		// the observer. In the window between the two there is no base to step from,
		// and assuming 0 would send the clip to the -60 dB floor on the first press.
		const slow = new FakeMeld(replayScenario(0.5).scenario, { echoDelayMs: 1_000 });
		const slowPort = await slow.listen(0);
		const slowConnection = new MeldConnection({ port: slowPort, reconnectMinMs: 100 });

		try {
			const ready = new Promise<void>((resolve) => {
				const off = slowConnection.on("ready", () => {
					off();
					resolve();
				});
			});
			slowConnection.connect();
			await ready;

			const cold = new Replay(slowConnection);
			const instance = new FakeActionInstance<Settings>("replay-cold", { action: "volume_up" });
			mount(cold, [instance]);
			await cold.onWillAppear(willAppear(instance, { action: "volume_up" }) as never);
			await sleep(80); // rendered and observing, but the gain echo is still in flight

			assert.ok(slow.callsTo("registerTrackObserver").length >= 1, "the track is identified and observed");
			await cold.onKeyUp(keyEvent(instance, { action: "volume_up" }) as never);
			await sleep(80);

			assert.equal(slow.callsTo("setGain").length, 0, "with no known gain the press must not send one");

			// Once the gain lands the same press works normally.
			await sleep(1_100);
			await cold.onKeyUp(keyEvent(instance, { action: "volume_up" }) as never);
			await sleep(80);
			const sent = slow.callsTo("setGain").at(-1)?.args[1] as number;
			assert.ok(sent > 0.5, `expected a step up from 0.5 once known, got ${sent}`);
		} finally {
			slowConnection.dispose();
			await slow.close();
		}
	});

	test("volume down lowers the gain by a step", async () => {
		const before = server.gainOf(trackId) as number;
		await press(action, key, { action: "volume_down" });
		await sleep(80);

		const sent = server.callsTo("setGain").at(-1)?.args[1] as number;
		assert.ok(sent < before, `volume down should lower gain from ${before}, got ${sent}`);
		assert.ok(sent > 0, "one step down from mid-scale must not reach silence");
	});

	test("steps from the gain Meld reports now, not the one captured at render", async () => {
		// A fader moved in Meld refreshes the observer cache without re-rendering
		// the key, so a press must read the current value.
		server.setGain(trackId, 0.2);
		await sleep(80);

		await press(action, key, { action: "volume_up" });
		await sleep(80);

		const sent = server.callsTo("setGain").at(-1)?.args[1] as number;
		assert.ok(sent > 0.2 && sent < 0.4, `expected a step up from 0.2, got ${sent}`);
	});

	test("mute and cue presses target the replay track", async () => {
		await press(action, key, { action: "mute" });
		await sleep(60);
		assert.deepEqual(server.callsTo("setMuted").at(-1)?.args, [trackId, true]);

		await press(action, key, { action: "cue" });
		await sleep(60);
		assert.deepEqual(server.callsTo("setProperty").at(-1)?.args, [trackId, "monitoring", true]);
	});

	test("keeps the observer while another replay key is still on screen", async () => {
		// The observer context is shared by every replay key, so releasing it when
		// only one of two disappears would silently stop gain updates for the one
		// still visible — and its next volume press would step from a stale base.
		const second = new FakeActionInstance<Settings>("replay-key-2", { action: "mute" });
		mount(action, [key, second]);
		await action.onWillAppear(willAppear(second, { action: "mute" }) as never);
		await sleep(40);
		server.invocations.length = 0;

		await disappear(action, second);
		await sleep(60);

		assert.equal(
			server.callsTo("unregisterTrackObserver").length,
			0,
			"the observer must survive while a replay key remains",
		);

		// Put the mount back to a single key so afterEach's teardown matches.
		mount(action, [key]);
	});

	test("releases the track observer once the last replay key disappears", async () => {
		server.invocations.length = 0;
		await disappear(action, key);
		await sleep(60);

		assert.equal(
			server.callsTo("unregisterTrackObserver").length,
			1,
			"the shared observer must be released when no replay key remains",
		);
	});
});
