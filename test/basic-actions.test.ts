// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Clip } from "../src/actions/clip.ts";
import { Screenshot } from "../src/actions/screenshot.ts";
import { ToggleMonitor } from "../src/actions/toggle-monitor.ts";
import { ToggleMute } from "../src/actions/toggle-mute.ts";
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
		// 42 is deliberately not one of the inspector presets: the combo remains
		// manually editable and must forward custom values too.
		const clipSettings = { clipDuration: "42" };
		const clipKey = new FakeActionInstance("clip", clipSettings);
		const screenshotKey = new FakeActionInstance("screenshot", {});
		mount(clip, [clipKey]);
		mount(screenshot, [screenshotKey]);

		await clip.onWillAppear(willAppear(clipKey, clipSettings) as never);
		await press(clip, clipKey, clipSettings);
		await press(screenshot, screenshotKey, {});

		assert.deepEqual(server.methods.sendCommandWithArgs.mock.calls[0].arguments, ["meld.recordClip", [42]]);
		assert.deepEqual(server.methods.sendCommand.mock.calls.map((call) => call.arguments), [["meld.screenshot"]]);
	});

	test("clip uses its migrated default before the Stream Deck settings echo", async () => {
		const clip = new Clip(connection);
		const clipKey = new FakeActionInstance("clip-default", {});
		mount(clip, [clipKey]);
		await clip.onWillAppear(willAppear(clipKey, {}) as never);

		await press(clip, clipKey, {});

		assert.deepEqual(clipKey.settingsWrites, [{ clipDuration: "90" }]);
		assert.deepEqual(server.methods.sendCommandWithArgs.mock.calls.at(-1)?.arguments, ["meld.recordClip", [90]]);
	});

	test("clip falls back to the maximum-duration command on older Meld builds", async () => {
		const clip = new Clip(connection);
		const settings = { clipDuration: "15" };
		const clipKey = new FakeActionInstance("clip-old-meld", settings);
		mount(clip, [clipKey]);
		const sendCommandWithArgs = server.meld.sendCommandWithArgs;
		server.meld.sendCommandWithArgs = undefined;
		try {
			await press(clip, clipKey, settings);
		} finally {
			server.meld.sendCommandWithArgs = sendCommandWithArgs;
		}

		assert.deepEqual(server.methods.sendCommand.mock.calls.at(-1)?.arguments, ["meld.recordClip"]);
	});

	test("screenshot falls back to the legacy event on older Meld builds", async () => {
		const screenshot = new Screenshot(connection);
		const key = new FakeActionInstance("screenshot-old-meld", {});
		mount(screenshot, [key]);
		const sendCommand = server.meld.sendCommand;
		server.meld.sendCommand = undefined;
		try {
			await press(screenshot, key, {});
		} finally {
			server.meld.sendCommand = sendCommand;
		}

		assert.deepEqual(server.methods.sendEvent.mock.calls.at(-1)?.arguments, [
			"co.meldstudio.events.screenshot",
		]);
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

	test("mute and monitor implement every selectable press mode", async () => {
		const mute = new ToggleMute(connection);
		const muteKey = new FakeActionInstance("mute-modes", { track: trackId, action: "toggle" });
		mount(mute, [muteKey]);
		await mute.onWillAppear(willAppear(muteKey, { track: trackId, action: "toggle" }) as never);

		await press(mute, muteKey, { track: trackId, action: "toggle" });
		await press(mute, muteKey, { track: trackId, action: "mute" });
		await press(mute, muteKey, { track: trackId, action: "unmute" });

		assert.deepEqual(server.methods.toggleMute.mock.calls.at(-1)?.arguments, [trackId]);
		assert.deepEqual(
			server.methods.setMuted.mock.calls.slice(-2).map((call) => call.arguments),
			[[trackId, true], [trackId, false]],
		);
		assert.equal(muteKey.state, 1, "the unmute mode paints the unmuted state");

		const monitor = new ToggleMonitor(connection);
		const monitorKey = new FakeActionInstance("monitor-modes", { track: trackId, action: "toggle" });
		mount(monitor, [monitorKey]);
		await monitor.onWillAppear(willAppear(monitorKey, { track: trackId, action: "toggle" }) as never);

		await press(monitor, monitorKey, { track: trackId, action: "toggle" });
		await press(monitor, monitorKey, { track: trackId, action: "cue" });
		await press(monitor, monitorKey, { track: trackId, action: "uncue" });

		assert.deepEqual(server.methods.toggleMonitor.mock.calls.at(-1)?.arguments, [trackId]);
		assert.deepEqual(
			server.methods.setProperty.mock.calls.slice(-2).map((call) => call.arguments),
			[[trackId, "monitoring", true], [trackId, "monitoring", false]],
		);
		assert.equal(monitorKey.state, 0, "the uncue mode paints the unmonitored state");
	});

	test("every widget event dispatches with its matching icon and payload shape", async () => {
		const cases = [
			["STOPWATCH", "STOPWATCH_RESET", "widget-stopwatch-reset"],
			["STOPWATCH", "STOPWATCH_PAUSE", "widget-stopwatch-pause"],
			["STOPWATCH", "STOPWATCH_RESUME", "widget-stopwatch-resume"],
			["COUNTDOWN", "COUNTDOWN_RESET", "widget-countdown-reset"],
			["COUNTDOWN", "COUNTDOWN_PAUSE", "widget-countdown-pause"],
			["COUNTDOWN", "COUNTDOWN_RESUME", "widget-countdown-resume"],
			["CONFETTIFALL", "CONFETTIFALL_TRIGGER", "widget-confettifall-trigger"],
			["CONFETTIPOP", "CONFETTIPOP_TRIGGER", "widget-confettipop-trigger"],
			["SUBATHONTIMER", "SUBATHONTIMER_RESET", "widget-subathontimer-reset"],
			["SUBATHONTIMER", "SUBATHONTIMER_PAUSE", "widget-subathontimer-pause"],
			["SUBATHONTIMER", "SUBATHONTIMER_RESUME", "widget-subathontimer-resume"],
			["SUBATHONTIMER", "SUBATHONTIMER_ADDTIME", "widget-subathontimer-addtime"],
			["WHEELSPIN", "WHEELSPIN_SPIN", "widget-wheelspin-spin"],
			["COUNTER", "COUNTER_INCREMENT", "widget-counter-increment"],
			["COUNTER", "COUNTER_DECREMENT", "widget-counter-decrement"],
		] as const;

		for (const [widget, event, icon] of cases) {
			const settings = { widget, event, amount: "12.6" };
			const action = new WidgetControl(connection);
			const key = new FakeActionInstance(`widget-${event}`, settings);
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, settings) as never);
			await press(action, key, settings);

			assert.ok(key.image?.includes(icon), `${event} should paint ${icon}, got ${key.image}`);
			assert.deepEqual(server.methods.sendStreamEvent.mock.calls.at(-1)?.arguments, [
				event,
				event === "SUBATHONTIMER_ADDTIME" ? { amount: 13 } : false,
			]);
		}
	});

	test("widget add-time clamps invalid and negative amounts", async () => {
		const action = new WidgetControl(connection);
		for (const [id, amount] of [["negative", "-5"], ["invalid", "not-a-number"]] as const) {
			const settings = { widget: "SUBATHONTIMER", event: "SUBATHONTIMER_ADDTIME", amount };
			const key = new FakeActionInstance(`widget-${id}`, settings);
			mount(action, [key]);
			await action.onWillAppear(willAppear(key, settings) as never);
			await press(action, key, settings);
			assert.deepEqual(server.methods.sendStreamEvent.mock.calls.at(-1)?.arguments, [
				"SUBATHONTIMER_ADDTIME",
				{ amount: 0 },
			]);
		}
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
