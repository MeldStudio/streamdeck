// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Drives the real connection layer against the fake Meld from tools/fake-meld
// (the same server the `npm run fake-meld` dev tool uses, so the two cannot
// drift) over many connect/drop/reconnect cycles.
//
// The plugin is one long-lived process that outlives many Meld instances, so the
// invariant under test is that every reconnect re-derives state from the NEW
// instance rather than carrying anything over from the old one.
//
// Everything runs on an ephemeral port, never Meld's real one, so the suite
// cannot disturb (or be disturbed by) a Meld Studio or Stream Deck plugin
// running on the same machine.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { MeldConnection } from "../src/meld/connection.ts";
import { FakeMeld, type FakeMeldOptions } from "../tools/fake-meld/server.ts";
import { type Scenario, SessionBuilder } from "../tools/fake-meld/session.ts";

/** Builds a one-scene, one-track scenario with ids derived from `tag`. */
function tinyScenario(tag: string, gain = 0.5): { scenario: Scenario; sceneId: string; trackId: string } {
	const builder = new SessionBuilder(tag);
	const sceneId = builder.scene(`Scene ${tag}`, { current: true });
	const trackId = builder.track(`Track ${tag}`, { gain });
	return { scenario: builder.build(tag, `test scenario ${tag}`), sceneId, trackId };
}

/** Waits for a connection event, rejecting if it does not arrive in time. */
function once(connection: MeldConnection, event: "ready" | "closed", timeoutMs = 5_000): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error(`timed out waiting for "${event}"`));
		}, timeoutMs);
		const off = connection.on(event, () => {
			clearTimeout(timer);
			off();
			resolve();
		});
	});
}

describe("MeldConnection", () => {
	let connection: MeldConnection;
	let server: FakeMeld;
	let port = 0;
	let firstTrackId = "";

	/** Stops the current instance and waits for the connection to notice. */
	async function dropInstance(): Promise<void> {
		const closed = once(connection, "closed");
		await server.close();
		await closed;
	}

	/**
	 * Starts a fresh instance on the same port and waits for the plugin to
	 * hydrate, plus a moment for the traffic it sends afterwards (observer
	 * re-registration) to reach the server.
	 */
	async function startInstance(scenario: Scenario, options?: FakeMeldOptions): Promise<void> {
		server = new FakeMeld(scenario, options);
		const ready = once(connection, "ready", 20_000);
		await server.listen(port);
		await ready;
		await sleep(50);
	}

	before(async () => {
		// Bind an ephemeral port first, then point the connection at it.
		const first = tinyScenario("A");
		firstTrackId = first.trackId;
		server = new FakeMeld(first.scenario);
		port = await server.listen(0);
		// Compressed timings so the watchdog is genuinely exercised rather than
		// waiting out the production 10s bound.
		connection = new MeldConnection({ port, handshakeTimeoutMs: 300, reconnectMinMs: 100 });

		const ready = once(connection, "ready");
		connection.connect();
		await ready;
	});

	after(async () => {
		connection.dispose();
		await server.close();
	});

	test("exposes the API version and session of the connected instance", () => {
		assert.equal(connection.ready, true);
		assert.equal(connection.meld?.version, 2, "the fake advertises the same API version as Meld");
		assert.ok(connection.session?.items[firstTrackId], "the instance's track should be present");
	});

	test("session tracks carry no gain, matching StreamDeckMapper", () => {
		const track = connection.session?.items[firstTrackId];
		assert.equal(track?.type, "track");
		assert.equal(
			(track as { gain?: number }).gain,
			undefined,
			"Meld never puts gain in the snapshot; it arrives only via gainUpdated",
		);
	});

	test("replaces all state when a different Meld instance takes over", async () => {
		await dropInstance();
		assert.equal(connection.ready, false);
		assert.equal(connection.meld, undefined, "the meld object must not survive a disconnect");

		// A new instance exposes an entirely different set of item ids.
		const next = tinyScenario("B");
		await startInstance(next.scenario);

		assert.ok(connection.session?.items[next.trackId], "the new instance's track should be present");
		assert.equal(
			connection.session?.items[firstTrackId],
			undefined,
			"the previous instance's items must not survive the reconnect",
		);
	});

	test("registering an observer yields an immediate gain update", async () => {
		const { scenario, trackId } = tinyScenario("C", 0.75);
		await dropInstance();
		await startInstance(scenario);

		const gains: unknown[] = [];
		const off = connection.on("gainChanged", (change) => gains.push(change));
		connection.registerTrackObserver("ctx-1", trackId);
		await sleep(100);
		off();

		// StreamDeckMapper::registerTrack emits gainUpdated on registration, which
		// is how a dial hydrates without waiting for the user to move a fader.
		assert.deepEqual(gains, [{ trackId, gain: 0.75, muted: false }]);
	});

	test("re-registers track observers against each new instance", async () => {
		assert.equal(server.callsTo("registerTrackObserver").length, 1);

		const previousTrack = server.callsTo("registerTrackObserver")[0].args[1];
		await dropInstance();
		await startInstance(tinyScenario("D").scenario);

		const registrations = server.callsTo("registerTrackObserver");
		assert.equal(registrations.length, 1, "the observer should be re-registered exactly once on the new instance");
		assert.deepEqual(registrations[0].args, ["ctx-1", previousTrack]);

		connection.unregisterTrackObserver("ctx-1");
	});

	test("delivers live session updates, not just the hydration snapshot", async () => {
		// Every key and dial repaints off `sessionChanged`. If only the connect-time
		// hydration emit reached listeners, the plugin would look healthy and then
		// freeze: scene switches, layer toggles and mutes would never show up.
		const updates: unknown[] = [];
		const off = connection.on("sessionChanged", (session) => updates.push(session));

		// Mute a track rather than switching to the already-current scene: the
		// snapshot must be observed changing, not merely re-asserting what it said.
		const track = Object.entries(server.session.items).find(([, item]) => item.type === "track")?.[0];
		assert.ok(track, "the scenario should contain a track");
		const mutedBefore = (connection.session?.items[track] as { muted: boolean }).muted;
		assert.equal(mutedBefore, false, "the track starts unmuted");

		server.setMuted(track, true);
		await sleep(120);

		off();
		assert.equal(updates.length, 1, "a session change in Meld must reach listeners");
		assert.equal(
			(connection.session?.items[track] as { muted: boolean }).muted,
			true,
			"the connection's snapshot must carry the new value, not the hydration one",
		);
	});

	test("delivers recording updates from the current instance", async () => {
		const recordings: boolean[] = [];
		const off = connection.on("recordingChanged", (recording) => recordings.push(recording));

		server.setRecording(true);
		await sleep(100);

		off();
		assert.deepEqual(recordings, [true]);
		assert.equal(connection.meld?.isRecording, true);
	});

	test("survives repeated instance churn without leaking timers or sockets", async () => {
		// `_getActiveHandles` does not report timers at all, so it cannot see the
		// leak that matters here; `getActiveResourcesInfo` does.
		const resources = (): string[] => process.getActiveResourcesInfo().filter((r) => r !== "TTYWrap");

		// Churn once first so any one-off resources exist before the baseline.
		await dropInstance();
		await startInstance(tinyScenario("warmup").scenario);
		const before = resources();

		for (let i = 0; i < 6; i++) {
			const { scenario, trackId } = tinyScenario(`churn${i}`);
			await dropInstance();
			await startInstance(scenario);
			assert.ok(connection.session?.items[trackId], `cycle ${i} should expose its own session`);
		}

		const after = resources();
		assert.ok(
			after.length <= before.length,
			`active resources grew from ${before.length} (${before.join(",")}) to ${after.length} (${after.join(",")})`,
		);
	});

	test("abandons and retries a peer that never completes the handshake", async () => {
		await dropInstance();

		// A peer that accepts the socket, never answers init and never closes is the
		// case `onclose` cannot rescue: only the watchdog can. Proving recovery means
		// showing a SECOND connection arrives at that same still-listening peer.
		const stalled = new FakeMeld(tinyScenario("stalled").scenario, { stallHandshake: true });
		await stalled.listen(port);

		try {
			// Long enough for the watchdog (300ms) to fire and a retry to be dialled.
			await sleep(1_200);
			assert.equal(connection.ready, false, "a stalled handshake must never report ready");
			assert.ok(
				stalled.acceptedConnections >= 2,
				`the watchdog should have abandoned and redialled; the stalled peer saw ${stalled.acceptedConnections} connection(s)`,
			);
			// Abandoning means closing: leaving the dead sockets open would pile up a
			// connection per retry against a peer that never answers.
			assert.ok(
				stalled.clientCount <= 1,
				`abandoned sockets must be closed; ${stalled.clientCount} were still open`,
			);
		} finally {
			// Release the port even when an assertion fails, so one failure does not
			// cascade into every test that follows.
			await stalled.close();
		}

		const { scenario, trackId } = tinyScenario("afterStall");
		await startInstance(scenario);
		assert.ok(connection.session?.items[trackId], "the plugin must recover once a real Meld takes the port");
	});

	test("abandons and retries a peer that exposes no meld object", async () => {
		await dropInstance();

		// A peer that completes the handshake but exposes no `meld` object must be
		// rejected by that branch specifically. This connection's watchdog is set
		// far beyond the test window so it cannot rescue the case and disguise a
		// missing retry.
		const wrongPeer = new FakeMeld(tinyScenario("wrong").scenario, { omitMeldObject: true });
		const wrongPort = await wrongPeer.listen(0);
		const probe = new MeldConnection({ port: wrongPort, handshakeTimeoutMs: 60_000, reconnectMinMs: 100 });

		try {
			probe.connect();
			await sleep(1_200);
			assert.equal(probe.ready, false, "a peer without a meld object must never report ready");
			assert.ok(
				wrongPeer.acceptedConnections >= 2,
				`the wrong peer should have been redialled; it saw ${wrongPeer.acceptedConnections} connection(s)`,
			);
		} finally {
			probe.dispose();
			await wrongPeer.close();
		}

		await startInstance(tinyScenario("afterWrongPeer").scenario);
		assert.equal(connection.ready, true);
	});

	test("dispose leaves no connection reported as ready", async () => {
		// A disposed connection that still reports ready would hand actions a dead
		// transport, and would disarm the watchdog on a later connect().
		const throwaway = new MeldConnection({ port, handshakeTimeoutMs: 300, reconnectMinMs: 100 });
		const ready = once(throwaway, "ready");
		throwaway.connect();
		await ready;
		assert.equal(throwaway.ready, true);

		throwaway.dispose();
		assert.equal(throwaway.ready, false, "dispose must clear the ready flag");
		assert.equal(throwaway.meld, undefined, "dispose must drop the meld object");
	});

	test("degrades without throwing when the build lacks the observer API", async () => {
		const { scenario, trackId } = tinyScenario("oldBuild", 0.8);
		await dropInstance();
		await startInstance(scenario, { omitObserverApi: true });

		assert.equal(connection.ready, true, "an older build must still connect");
		assert.equal(connection.meld?.gainUpdated, undefined);
		// Must not throw despite the methods being absent.
		connection.registerTrackObserver("ctx-2", trackId);
		connection.unregisterTrackObserver("ctx-2");
		assert.equal(connection.session?.items[trackId]?.type, "track");
	});
});
