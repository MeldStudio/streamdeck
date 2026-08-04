// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Drives the real connection lifecycle against the initialized `meld` object
// shape from WebChannelAPI.md, without coupling functional tests to Qt's wire
// protocol or opening localhost sockets.
//
// The plugin is one long-lived process that outlives many Meld instances, so the
// invariant under test is that every reconnect re-derives state from the NEW
// instance rather than carrying anything over from the old one.
//
// Virtual ports isolate instances without disturbing (or being disturbed by)
// a Meld Studio or Stream Deck plugin running on the same machine.

import assert from "node:assert/strict";
import { after, before, describe, mock, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
	MeldConnection,
	type OpenWebChannel,
	type WebChannelCallbacks,
	type WebChannelHandle,
} from "../src/meld/connection.ts";
import type { MeldObject, MeldSignal } from "../src/meld/types.ts";
import {
	MockWebChannel,
	type MockWebChannelOptions,
	openMockWebChannel,
} from "./helpers/mock-web-channel.ts";
import { type Scenario, SessionBuilder } from "./helpers/session-builder.ts";

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

type ManualAttempt = WebChannelHandle & {
	callbacks: WebChannelCallbacks;
	closeCount: number;
};

/** Captures lifecycle callbacks so tests can deliver hostile/stale orderings. */
function manualWebChannels(): { attempts: ManualAttempt[]; openWebChannel: OpenWebChannel } {
	const attempts: ManualAttempt[] = [];
	return {
		attempts,
		openWebChannel: (_url, callbacks) => {
			let closed = false;
			const attempt: ManualAttempt = {
				callbacks,
				closeCount: 0,
				close(): void {
					if (closed) return;
					closed = true;
					attempt.closeCount++;
				},
			};
			attempts.push(attempt);
			return attempt;
		},
	};
}

function inertSignal<Args extends unknown[]>(): MeldSignal<Args> {
	return { connect: () => {}, disconnect: () => {} };
}

/** Minimal documented API result for lifecycle-only tests. */
function manualMeld(): MeldObject {
	return {
		version: 3,
		session: { items: {} },
		isStreaming: false,
		isRecording: false,
		sessionChanged: inertSignal(),
		isStreamingChanged: inertSignal(),
		isRecordingChanged: inertSignal(),
		showScene: () => {},
		setStagedScene: () => {},
		showStagedScene: () => {},
		toggleMute: () => {},
		toggleMonitor: () => {},
		toggleLayer: () => {},
		toggleEffect: () => {},
		toggleRecord: () => {},
		toggleStream: () => {},
		setGain: () => {},
	};
}

describe("MeldConnection", () => {
	let connection: MeldConnection;
	let server: MockWebChannel;
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
	async function startInstance(scenario: Scenario, options?: MockWebChannelOptions): Promise<void> {
		server = new MockWebChannel(scenario, options);
		const ready = once(connection, "ready", 20_000);
		await server.listen(port);
		await ready;
		await sleep(50);
	}

	before(async () => {
		// Allocate an isolated virtual endpoint, then point the connection at it.
		const first = tinyScenario("A");
		firstTrackId = first.trackId;
		server = new MockWebChannel(first.scenario);
		port = await server.listen(0);
		// Compressed timings so the watchdog is genuinely exercised rather than
		// waiting out the production 10s bound.
		connection = new MeldConnection({ port, handshakeTimeoutMs: 300, reconnectMinMs: 100, openWebChannel: openMockWebChannel });

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
		assert.equal(connection.meld?.version, 3, "the mock advertises the same API version as Meld");
		assert.ok(connection.session?.items[firstTrackId], "the instance's track should be present");
	});

	test("connect is idempotent while an instance is already connected", async () => {
		const accepted = server.acceptedConnections;
		const meldObject = connection.meld;

		connection.connect();
		connection.connect();
		await sleep(250);

		assert.equal(server.acceptedConnections, accepted, "repeated startup calls must not open another channel");
		assert.equal(connection.meld, meldObject, "the healthy instance must not be torn down and replaced");
		assert.equal(connection.ready, true);
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
		const oldInstance = server;
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

		const staleRecordings: boolean[] = [];
		const off = connection.on("recordingChanged", (recording) => staleRecordings.push(recording));
		oldInstance.setRecording(true);
		await sleep(0);
		off();
		assert.deepEqual(staleRecordings, [], "signals queued by the stopped instance must be ignored");
		const recordingOf = (candidate: MeldConnection): boolean | undefined => candidate.meld?.isRecording;
		assert.equal(recordingOf(connection), false, "stale signals must not mutate the new instance");
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
		assert.equal(server.methods.registerTrackObserver.mock.callCount(), 1);

		const previousTrack = server.methods.registerTrackObserver.mock.calls[0].arguments[1];
		await dropInstance();
		await startInstance(tinyScenario("D").scenario);

		const registrations = server.methods.registerTrackObserver.mock.calls;
		assert.equal(registrations.length, 1, "the observer should be re-registered exactly once on the new instance");
		assert.deepEqual(registrations[0].arguments, ["ctx-1", previousTrack]);

		connection.registerTrackObserver("ctx-1", previousTrack as string);
		assert.equal(
			server.methods.registerTrackObserver.mock.callCount(),
			1,
			"a render after reconnect must not duplicate the registration",
		);

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
		await sleep(800);

		off();
		assert.equal(updates.length, 1, "a session change in Meld must reach listeners");
		assert.equal(
			(connection.session?.items[track] as { muted: boolean }).muted,
			true,
			"the connection's snapshot must carry the new value, not the hydration one",
		);
	});

	test("delivers independent session, streaming, and recording results published together", async () => {
		// The functional boundary receives initialized properties and their signals.
		// Publishing several results in one turn must not let one handler strand the
		// others at an older value.
		const streaming: boolean[] = [];
		const recording: boolean[] = [];
		const offStreaming = connection.on("streamingChanged", (value) => streaming.push(value));
		const offRecording = connection.on("recordingChanged", (value) => recording.push(value));

		// Three result changes in one turn (no debounce, so the session arrives too).
		const builder = new SessionBuilder("busy");
		builder.scene("Scene busy", { current: true });
		const busyTrack = builder.track("Track busy", { gain: 0.5 });
		server.setSessionDebounce(0);
		server.loadScenario(builder.build("busy", "busy", { streaming: true, recording: true }));
		await sleep(400);
		server.setSessionDebounce(undefined);

		offStreaming();
		offRecording();
		assert.ok(streaming.includes(true), `streamingChanged must not be dropped; saw ${JSON.stringify(streaming)}`);
		assert.ok(recording.includes(true), `recordingChanged must not be dropped; saw ${JSON.stringify(recording)}`);
		assert.equal(connection.meld?.isStreaming, true);
		assert.equal(connection.meld?.isRecording, true);
		assert.ok(connection.session?.items[busyTrack], "and the session itself still arrived");
	});

	test("delivers recording updates from the current instance", async () => {
		// Drive a real transition in both directions: asserting `true` while the
		// value is already true would hold without the plugin reporting anything,
		// and would never check that the reported boolean matches.
		server.setRecording(false);
		await sleep(100);
		assert.equal(connection.meld?.isRecording, false, "start from a known-false state");

		const recordings: boolean[] = [];
		const off = connection.on("recordingChanged", (recording) => recordings.push(recording));

		server.setRecording(true);
		await sleep(100);
		assert.equal(connection.meld?.isRecording, true);

		server.setRecording(false);
		await sleep(100);
		off();

		assert.deepEqual(recordings, [true, false], "each transition must be reported with its own value");
		assert.equal(connection.meld?.isRecording, false);
	});

	test("survives repeated instance churn without leaking timers or handles", async () => {
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

		// A peer that accepts a channel attempt, never produces an initialized object,
		// and never closes is the case `closed` cannot rescue: only the watchdog can.
		// Proving recovery means showing a second attempt reaches the same peer.
		const stalled = new MockWebChannel(tinyScenario("stalled").scenario, { stallHandshake: true });
		await stalled.listen(port);

		try {
			// Long enough for the watchdog (300ms) to fire and a retry to be dialled.
			await sleep(1_200);
			assert.equal(connection.ready, false, "a stalled handshake must never report ready");
			assert.ok(
				stalled.acceptedConnections >= 2,
				`the watchdog should have abandoned and redialled; the stalled peer saw ${stalled.acceptedConnections} connection(s)`,
			);
			// Abandoning means closing: leaving dead attempts open would pile up a
			// connection per retry against a peer that never answers.
			assert.ok(
				stalled.clientCount <= 1,
				`abandoned attempts must be closed; ${stalled.clientCount} were still open`,
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
		const wrongPeer = new MockWebChannel(tinyScenario("wrong").scenario, { omitMeldObject: true });
		const wrongPort = await wrongPeer.listen(0);
		const probe = new MeldConnection({ port: wrongPort, handshakeTimeoutMs: 60_000, reconnectMinMs: 100, openWebChannel: openMockWebChannel });

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
		const throwaway = new MeldConnection({ port, handshakeTimeoutMs: 300, reconnectMinMs: 100, openWebChannel: openMockWebChannel });
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

describe("MeldConnection attempt lifecycle", () => {
	test("retries when an asynchronous ready result has a malformed signal", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const manual = manualWebChannels();
			const connection = new MeldConnection({ reconnectMinMs: 100, openWebChannel: manual.openWebChannel });
			let readyCount = 0;
			let closedCount = 0;
			connection.on("ready", () => readyCount++);
			connection.on("closed", () => closedCount++);

			connection.connect();
			const malformed = manualMeld();
			malformed.sessionChanged = {
				connect: () => {
					throw new Error("malformed session signal");
				},
				disconnect: () => {},
			};
			manual.attempts[0].callbacks.ready(malformed);

			assert.equal(connection.ready, false);
			assert.equal(connection.meld, undefined);
			assert.equal(manual.attempts[0].closeCount, 1);
			assert.equal(readyCount, 0);
			assert.equal(closedCount, 0, "a rejected handshake must not emit an unmatched closed event");
			mock.timers.tick(99);
			assert.equal(manual.attempts.length, 1);
			mock.timers.tick(1);
			assert.equal(manual.attempts.length, 2, "the malformed result should be retried");
			connection.dispose();
		} finally {
			mock.timers.reset();
		}
	});

	test("retries when observer restoration throws during ready", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const manual = manualWebChannels();
			const connection = new MeldConnection({ reconnectMinMs: 100, openWebChannel: manual.openWebChannel });
			connection.registerTrackObserver("ctx", "track");
			connection.connect();
			const rejecting = manualMeld();
			rejecting.registerTrackObserver = () => {
				throw new Error("observer rejected");
			};

			manual.attempts[0].callbacks.ready(rejecting);
			assert.equal(connection.ready, false);
			assert.equal(connection.meld, undefined);
			assert.equal(manual.attempts[0].closeCount, 1);
			mock.timers.tick(100);
			assert.equal(manual.attempts.length, 2);
			connection.dispose();
		} finally {
			mock.timers.reset();
		}
	});

	test("stops old-instance hydration when a ready listener disposes", () => {
		const manual = manualWebChannels();
		const connection = new MeldConnection({ openWebChannel: manual.openWebChannel });
		const events: string[] = [];
		connection.on("ready", () => {
			events.push("ready");
			connection.dispose();
		});
		connection.on("closed", () => events.push("closed"));
		connection.on("sessionChanged", () => events.push("session"));
		connection.on("streamingChanged", () => events.push("streaming"));
		connection.on("recordingChanged", () => events.push("recording"));

		connection.connect();
		manual.attempts[0].callbacks.ready(manualMeld());

		assert.deepEqual(events, ["ready", "closed"]);
		assert.equal(connection.ready, false);
		assert.equal(connection.meld, undefined);
	});

	test("ignores late readiness after a handshake timeout and during reconnect backoff", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const manual = manualWebChannels();
			const connection = new MeldConnection({
				handshakeTimeoutMs: 100,
				reconnectMinMs: 1_000,
				openWebChannel: manual.openWebChannel,
			});
			let readyCount = 0;
			connection.on("ready", () => readyCount++);

			connection.connect();
			connection.connect();
			connection.connect();
			assert.equal(manual.attempts.length, 1, "connect must be idempotent while the handshake is pending");

			mock.timers.tick(100);
			assert.equal(manual.attempts[0].closeCount, 1, "the timed-out attempt must be closed once");

			// A result already queued by the abandoned adapter must not revive it.
			manual.attempts[0].callbacks.ready(manualMeld());
			assert.equal(connection.ready, false);
			assert.equal(connection.meld, undefined);
			assert.equal(readyCount, 0);

			connection.connect();
			connection.connect();
			mock.timers.tick(999);
			assert.equal(manual.attempts.length, 1, "repeated connect must not bypass reconnect backoff");
			mock.timers.tick(1);
			assert.equal(manual.attempts.length, 2, "the one scheduled retry should open exactly once");

			connection.connect();
			assert.equal(manual.attempts.length, 2, "connect must remain idempotent during the retry handshake");
			connection.dispose();
		} finally {
			mock.timers.reset();
		}
	});

	test("keeps ready and closed exact-once across reconnect and dispose", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const manual = manualWebChannels();
			const connection = new MeldConnection({
				handshakeTimeoutMs: 10_000,
				reconnectMinMs: 100,
				openWebChannel: manual.openWebChannel,
			});
			let readyCount = 0;
			let closedCount = 0;
			let reconnectOnClose = true;
			connection.on("ready", () => readyCount++);
			connection.on("closed", () => {
				closedCount++;
				if (reconnectOnClose) {
					// Models another startup owner reacting synchronously to the drop.
					connection.connect();
					connection.connect();
				}
			});

			connection.connect();
			manual.attempts[0].callbacks.ready(manualMeld());
			manual.attempts[0].callbacks.ready(manualMeld());
			assert.equal(readyCount, 1, "duplicate adapter readiness must be ignored");

			manual.attempts[0].callbacks.closed();
			manual.attempts[0].callbacks.closed();
			assert.equal(closedCount, 1, "duplicate close callbacks must be ignored");
			assert.equal(manual.attempts.length, 2, "the closed listener's repeated connect opens one attempt");
			mock.timers.tick(1_000);
			assert.equal(manual.attempts.length, 2, "the old close path must not leave a replacement timer armed");

			manual.attempts[1].callbacks.ready(manualMeld());
			manual.attempts[1].callbacks.ready(manualMeld());
			assert.equal(readyCount, 2);

			// dispose emits closed, but connect() from that listener cannot defeat the
			// in-progress teardown. A later explicit connect is still allowed.
			connection.dispose();
			connection.dispose();
			assert.equal(closedCount, 2);
			assert.equal(manual.attempts.length, 2);
			assert.equal(connection.ready, false);

			reconnectOnClose = false;
			connection.connect();
			assert.equal(manual.attempts.length, 3);
			manual.attempts[2].callbacks.ready(manualMeld());
			assert.equal(readyCount, 3);
			connection.dispose();
			assert.equal(closedCount, 3);
		} finally {
			mock.timers.reset();
		}
	});

	test("ignores a ready callback retained past dispose", () => {
		const manual = manualWebChannels();
		const connection = new MeldConnection({ openWebChannel: manual.openWebChannel });
		let readyCount = 0;
		connection.on("ready", () => readyCount++);

		connection.connect();
		connection.dispose();
		manual.attempts[0].callbacks.ready(manualMeld());

		assert.equal(connection.ready, false);
		assert.equal(connection.meld, undefined);
		assert.equal(readyCount, 0);
		assert.equal(manual.attempts[0].closeCount, 1);
	});

	test("an explicit dispose-connect cycle resets accumulated reconnect backoff", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		try {
			const manual = manualWebChannels();
			const connection = new MeldConnection({
				handshakeTimeoutMs: 10_000,
				reconnectMinMs: 100,
				openWebChannel: manual.openWebChannel,
			});

			connection.connect();
			manual.attempts[0].callbacks.closed();
			mock.timers.tick(100);
			manual.attempts[1].callbacks.closed();
			mock.timers.tick(150);
			manual.attempts[2].callbacks.closed(); // next automatic delay has grown to 225ms

			connection.dispose(); // cancel that retry and begin an explicit lifecycle
			connection.connect();
			manual.attempts[3].callbacks.closed();
			mock.timers.tick(99);
			assert.equal(manual.attempts.length, 4);
			mock.timers.tick(1);
			assert.equal(manual.attempts.length, 5, "the new lifecycle should retry at the 100ms minimum");
			connection.dispose();
		} finally {
			mock.timers.reset();
		}
	});
});
