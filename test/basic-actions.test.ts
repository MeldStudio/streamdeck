// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Clip } from "../src/actions/clip.ts";
import { Screenshot } from "../src/actions/screenshot.ts";
import { ToggleMonitor } from "../src/actions/toggle-monitor.ts";
import { ToggleRecord } from "../src/actions/toggle-record.ts";
import { ToggleStream } from "../src/actions/toggle-stream.ts";
import { WidgetControl } from "../src/actions/widget-control.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { FakeActionInstance, mount, press, willAppear } from "./helpers/fake-stream-deck.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";
import { SessionBuilder } from "./helpers/session-builder.ts";

describe("basic Meld actions", () => {
	let server: MockWebChannel;
	let connection: MeldConnection;
	let trackId: string;

	before(async () => {
		const builder = new SessionBuilder("basic-actions");
		builder.scene("Main", { current: true });
		trackId = builder.track("Microphone", { monitoring: false });
		server = new MockWebChannel(builder.build("basic-actions", "basic action commands"));
		const port = await server.listen(0);
		connection = new MeldConnection({ port, openWebChannel: openMockWebChannel });
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

	test("clip and screenshot dispatch their documented commands", async () => {
		const clip = new Clip(connection);
		const screenshot = new Screenshot(connection);
		const clipKey = new FakeActionInstance("clip", {});
		const screenshotKey = new FakeActionInstance("screenshot", {});
		mount(clip, [clipKey]);
		mount(screenshot, [screenshotKey]);

		await press(clip, clipKey, {});
		await press(screenshot, screenshotKey, {});

		assert.deepEqual(
			server.methods.sendCommand.mock.calls.map((call) => call.arguments),
			[["meld.recordClip"], ["meld.screenshot"]],
		);
	});

	test("recording and streaming keys follow the result signals", async () => {
		const record = new ToggleRecord(connection);
		const stream = new ToggleStream(connection);
		const recordKey = new FakeActionInstance("record", {});
		const streamKey = new FakeActionInstance("stream", {});
		mount(record, [recordKey]);
		mount(stream, [streamKey]);
		await record.onWillAppear(willAppear(recordKey, {}) as never);
		await stream.onWillAppear(willAppear(streamKey, {}) as never);
		assert.equal(recordKey.state, 0);
		assert.equal(streamKey.state, 0);

		await press(record, recordKey, {});
		await press(stream, streamKey, {});
		await sleep(0);

		assert.equal(server.methods.toggleRecord.mock.callCount(), 1);
		assert.equal(server.methods.toggleStream.mock.callCount(), 1);
		assert.equal(recordKey.state, 1);
		assert.equal(streamKey.state, 1);
	});

	test("monitor and widget settings reach the direct mocked API", async () => {
		const monitor = new ToggleMonitor(connection);
		const monitorSettings = { track: trackId, action: "cue" };
		const monitorKey = new FakeActionInstance("monitor", monitorSettings);
		mount(monitor, [monitorKey]);
		await monitor.onWillAppear(willAppear(monitorKey, monitorSettings) as never);
		await press(monitor, monitorKey, monitorSettings);

		const widget = new WidgetControl(connection);
		const widgetSettings = {
			widget: "SUBATHONTIMER",
			event: "SUBATHONTIMER_ADDTIME",
			amount: "90",
		};
		const widgetKey = new FakeActionInstance("widget", widgetSettings);
		mount(widget, [widgetKey]);
		await widget.onWillAppear(willAppear(widgetKey, widgetSettings) as never);
		await press(widget, widgetKey, widgetSettings);

		assert.deepEqual(server.methods.setProperty.mock.calls.at(-1)?.arguments, [trackId, "monitoring", true]);
		assert.deepEqual(server.methods.sendStreamEvent.mock.calls.at(-1)?.arguments, [
			"SUBATHONTIMER_ADDTIME",
			{ amount: 90 },
		]);
	});

	test("a widget press uses canonical migrated settings before the SDK echo", async () => {
		const widget = new WidgetControl(connection);
		const legacySettings = { event: "SUBATHONTIMER_ADDTIME" };
		const widgetKey = new FakeActionInstance("widget-pre-echo", legacySettings);
		mount(widget, [widgetKey]);
		await widget.onWillAppear(willAppear(widgetKey, legacySettings) as never);

		await press(widget, widgetKey, legacySettings);

		assert.deepEqual(server.methods.sendStreamEvent.mock.calls.at(-1)?.arguments, [
			"SUBATHONTIMER_ADDTIME",
			{ amount: 60 },
		]);
	});
});
