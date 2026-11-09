// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// The Chapter Marker action against the result-level Meld mock. The press is a
// plain command; what the tests guard is the key's relationship to the
// recording flag, which is the only thing that tells a streamer whether the
// marker they just asked for could land.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { CHAPTER_MARKER_COMMAND, ChapterMarker } from "../src/actions/chapter-marker.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeActionInstance, mount, press, willAppear } from "./helpers/fake-stream-deck.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";
import { SessionBuilder } from "./helpers/session-builder.ts";

function build(namespace: string, recording: boolean) {
	const b = new SessionBuilder(namespace);
	b.scene("Main", { current: true });
	return b.build(namespace, "chapter markers", { recording });
}

describe("chapter marker", () => {
	let server: MockWebChannel;
	let connection: MeldConnection;
	let port = 0;

	before(async () => {
		server = new MockWebChannel(build("chapter", false));
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

	test("the command name matches Meld's registered command", () => {
		assert.equal(CHAPTER_MARKER_COMMAND, "meld.insertRecordingChapterMarker");
	});

	test("the key follows the recording state and every press sends the command", async () => {
		const action = new ChapterMarker(connection);
		const key = new FakeActionInstance("chapter", {});
		mount(action, [key]);
		await action.onWillAppear(willAppear(key, {}) as never);
		assert.equal(key.state, 1, "nothing is recording, so no marker can be added");

		// Meld decides whether a marker lands: the command is a no-op there while
		// not recording, so the press is forwarded in either state rather than
		// second-guessed from a flag that may lag the real recording.
		await press(action, key, {});
		assert.deepEqual(server.methods.sendCommand.mock.calls.at(-1)?.arguments, [CHAPTER_MARKER_COMMAND]);

		server.setRecording(true);
		await sleep(0);
		assert.equal(key.state, 0, "a recording in progress lights the key");

		await press(action, key, {});
		assert.equal(server.methods.sendCommand.mock.calls.length, 2);

		server.setRecording(false);
		await sleep(0);
		assert.equal(key.state, 1);
	});

	test("a Meld build without sendCommand is left alone", async () => {
		const action = new ChapterMarker(connection);
		const key = new FakeActionInstance("chapter-old", {});
		mount(action, [key]);
		const sendCommand = server.meld.sendCommand;
		server.meld.sendCommand = undefined;
		try {
			await press(action, key, {});
		} finally {
			server.meld.sendCommand = sendCommand;
		}
		assert.equal(server.methods.sendCommand.mock.callCount(), 2, "no further command was sent");
		assert.equal(server.methods.sendEvent.mock.callCount(), 0, "there is no legacy event to fall back to");
	});

	test("the key keeps its last state while Meld is away and follows the next instance", async () => {
		const action = new ChapterMarker(connection);
		const key = new FakeActionInstance("chapter-restart", {});
		mount(action, [key]);
		server.setRecording(true);
		await action.onWillAppear(willAppear(key, {}) as never);
		assert.equal(key.state, 0);
		key.reset();

		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;
		assert.equal(key.state, undefined, "a disconnect must not flash the key to 'not recording'");
		// A press with Meld gone has nowhere to go and must not throw.
		await press(action, key, {});

		// A new Meld process that is not recording takes over.
		server = new MockWebChannel(build("chapter", false));
		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		await server.listen(port);
		await ready;
		await sleep(60);
		assert.equal(key.state, 1, "the restarted instance's recording flag is authoritative");
	});
});
