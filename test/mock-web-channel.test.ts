// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { createWebChannelOpener } from "../src/meld/connection.ts";
import type { MeldObject } from "../src/meld/types.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";
import { SessionBuilder } from "./helpers/session-builder.ts";

function layerScenario(): { scenario: ReturnType<SessionBuilder["build"]>; scene: string; layer: string } {
	const builder = new SessionBuilder("mock-boundary");
	const scene = builder.scene("Main", { current: true });
	const layer = builder.layer(scene, "Camera", { visible: true });
	return { scenario: builder.build("mock-boundary", "fixture contract"), scene, layer };
}

test("Meld methods are direct mocks and publish a copied session only after the result signal", async () => {
	const { scenario, scene, layer } = layerScenario();
	const channel = new MockWebChannel(scenario, { sessionDebounceMs: 80 });
	const publishedBefore = channel.meld.session;

	channel.meld.toggleLayer(scene, layer);

	assert.deepEqual(channel.methods.toggleLayer.mock.calls[0].arguments, [scene, layer]);
	assert.equal(channel.session.items[layer].type, "layer");
	assert.equal(channel.session.items[layer].type === "layer" && channel.session.items[layer].visible, false);
	assert.equal(
		publishedBefore?.items[layer].type === "layer" && publishedBefore.items[layer].visible,
		true,
		"the plugin-facing snapshot must remain stale until Meld publishes a result",
	);
	assert.equal(channel.meld.session, publishedBefore, "the unpublished mutable state must not leak by reference");

	await sleep(100);
	assert.notEqual(channel.meld.session, publishedBefore);
	assert.equal(channel.meld.session?.items[layer].type === "layer" && channel.meld.session.items[layer].visible, false);
	await channel.close();
});

test("an offline attempt closes and cannot attach when Meld later starts", async () => {
	const { scenario } = layerScenario();
	const allocator = new MockWebChannel(scenario);
	const port = await allocator.listen(0);
	await allocator.close();

	const events: string[] = [];
	openMockWebChannel(`ws://127.0.0.1:${port}`, {
		ready: () => events.push("ready"),
		error: () => events.push("error"),
		closed: () => events.push("closed"),
	});
	await sleep(0);
	assert.deepEqual(events, ["error", "closed"]);

	const later = new MockWebChannel(scenario);
	await later.listen(port);
	await sleep(0);
	assert.deepEqual(events, ["error", "closed"], "a refused WebSocket attempt must stay dead");
	assert.equal(later.acceptedConnections, 0);
	await later.close();
});

test("caller teardown cancels pending ready and queued remote-close callbacks", async () => {
	const { scenario } = layerScenario();
	const channel = new MockWebChannel(scenario);
	const port = await channel.listen(0);
	const ready = mock.fn();
	const closed = mock.fn();
	const handle = openMockWebChannel(`ws://127.0.0.1:${port}`, { ready, error: mock.fn(), closed });

	// Readiness is queued to match a real WebSocket/WebChannel handshake.
	handle.close();
	await sleep(0);
	assert.equal(ready.mock.callCount(), 0);

	const remoteClosed = mock.fn();
	const remote = openMockWebChannel(`ws://127.0.0.1:${port}`, {
		ready: mock.fn(),
		error: mock.fn(),
		closed: remoteClosed,
	});
	await sleep(0);
	const closing = channel.close();
	remote.close();
	await closing;
	await sleep(0);
	assert.equal(remoteClosed.mock.callCount(), 0, "caller close should silence an already queued remote drop");
	assert.equal(closed.mock.callCount(), 0);
});

test("a remote drop is delivered exactly once when caller teardown does not intervene", async () => {
	const { scenario } = layerScenario();
	const channel = new MockWebChannel(scenario);
	const port = await channel.listen(0);
	const closed = mock.fn();
	openMockWebChannel(`ws://127.0.0.1:${port}`, { ready: mock.fn(), error: mock.fn(), closed });
	await sleep(0);

	await channel.close();
	await sleep(0);

	assert.equal(closed.mock.callCount(), 1);
});

test("session builder indexes layers per scene and fixture state cannot be mutated by readers", async () => {
	const builder = new SessionBuilder("fixture-isolation");
	const sceneA = builder.scene("A");
	const sceneB = builder.scene("B");
	const layerA = builder.layer(sceneA, "A layer");
	const layerB = builder.layer(sceneB, "B layer");
	const channel = new MockWebChannel(builder.build("fixture-isolation", "fixture isolation"));

	assert.equal(channel.session.items[layerA].type === "layer" && channel.session.items[layerA].index, 0);
	assert.equal(channel.session.items[layerB].type === "layer" && channel.session.items[layerB].index, 0);
	const exposed = channel.session;
	delete exposed.items[layerA];
	assert.ok(channel.session.items[layerA], "the fixture's private state must not leak through its assertion view");
	await channel.close();
});

test("the production adapter maps WebSocket results and makes caller close silent", async () => {
	class SocketResult {
		onopen: (() => void) | null = null;
		onclose: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onmessage: (() => void) | null = null;
		closeCount = 0;

		close(): void {
			this.closeCount++;
			// Browser WebSocket.close eventually raises close. The adapter must detach
			// that handler first so caller teardown is not mistaken for a remote drop.
			this.onclose?.();
		}
	}

	const { scenario } = layerScenario();
	const channel = new MockWebChannel(scenario);
	const sockets: SocketResult[] = [];
	const initialize = mock.fn((_socket: WebSocket, ready: (meld: MeldObject | undefined) => void) => ready(channel.meld));
	const opener = createWebChannelOpener(
		() => {
			const socket = new SocketResult();
			sockets.push(socket);
			return socket as unknown as WebSocket;
		},
		initialize,
	);
	const ready = mock.fn();
	const error = mock.fn();
	const closed = mock.fn();
	const handle = opener("ws://127.0.0.1:13376", { ready, error, closed });

	sockets[0].onopen?.();
	assert.equal(initialize.mock.callCount(), 1);
	assert.deepEqual(ready.mock.calls[0].arguments, [channel.meld]);
	sockets[0].onerror?.();
	sockets[0].onclose?.();
	assert.equal(error.mock.callCount(), 1);
	assert.equal(closed.mock.callCount(), 1);

	// Use a fresh attempt to isolate caller teardown from the remote-close case.
	const silentClosed = mock.fn();
	const silent = opener("ws://127.0.0.1:13376", { ready: mock.fn(), error: mock.fn(), closed: silentClosed });
	silent.close();
	assert.equal(sockets[1].closeCount, 1);
	assert.equal(silentClosed.mock.callCount(), 0);
	assert.equal(sockets[1].onopen, null);
	assert.equal(sockets[1].onmessage, null);

	// Closing an already-remotely-closed handle is harmless as well.
	handle.close();
	await channel.close();
});
