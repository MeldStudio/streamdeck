// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import type { JsonObject } from "@elgato/utils";

import type { MeldAction } from "../src/actions/base.ts";
import { Media } from "../src/actions/media.ts";
import { Replay } from "../src/actions/replay.ts";
import { ToggleEffect } from "../src/actions/toggle-effect.ts";
import { ToggleLayer } from "../src/actions/toggle-layer.ts";
import { ToggleMute } from "../src/actions/toggle-mute.ts";
import { VolumeStepper } from "../src/actions/volume-stepper.ts";
import { WidgetControl } from "../src/actions/widget-control.ts";
import { MeldConnection } from "../src/meld/connection.ts";
import { didReceiveSettings, FakeActionInstance, mount, willAppear } from "./helpers/fake-stream-deck.ts";
import { MockWebChannel, openMockWebChannel } from "./helpers/mock-web-channel.ts";
import { indexedEffectId, type Scenario, SessionBuilder } from "./helpers/session-builder.ts";

type Built = { scenario: Scenario; ids: Record<string, string> };

function build(): Built {
	const b = new SessionBuilder("settings-migration");
	const sceneA = b.scene("A", { current: true });
	const sceneB = b.scene("B");
	const layerA = b.layer(sceneA, "Camera", { mediaSource: "file:///clip.mp4", isPlaying: true });
	const layerB = b.layer(sceneB, "Slides");
	const effectA = b.effect(layerA, "Blur");
	const track = b.track("Microphone", { gain: 0.7 });
	return {
		scenario: b.build("settings-migration", "origin/main settings compatibility"),
		ids: { sceneA, sceneB, layerA, layerB, effectA, track },
	};
}

type MigrationCase = {
	name: string;
	create(connection: MeldConnection): MeldAction<JsonObject>;
	input(ids: Record<string, string>): JsonObject;
	expected(ids: Record<string, string>): JsonObject;
	controller?: "Keypad" | "Encoder";
};

class DelayedSettingsInstance extends FakeActionInstance<JsonObject> {
	readonly writeStarted: Promise<void>;
	readonly releaseWrite: () => void;
	readonly #writeGate: Promise<void>;
	#markStarted: () => void;

	constructor(id: string, settings: JsonObject) {
		super(id, settings);
		let markStarted = (): void => {};
		let releaseWrite = (): void => {};
		this.writeStarted = new Promise((resolve) => {
			markStarted = resolve;
		});
		this.#writeGate = new Promise((resolve) => {
			releaseWrite = resolve;
		});
		this.#markStarted = markStarted;
		this.releaseWrite = releaseWrite;
	}

	override async setSettings<U extends JsonObject = JsonObject>(settings: U): Promise<void> {
		this.#markStarted();
		await this.#writeGate;
		await super.setSettings(settings);
	}
}

describe("durable settings migrations", () => {
	let server: MockWebChannel;
	let connection: MeldConnection;
	let ids: Record<string, string>;
	let port: number;

	before(async () => {
		const built = build();
		ids = built.ids;
		server = new MockWebChannel(built.scenario);
		port = await server.listen(0);
		connection = new MeldConnection({ port, reconnectMinMs: 20, openWebChannel: openMockWebChannel });
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

	const future = { keep: true };
	const cases: MigrationCase[] = [
		{
			name: "toggle-layer derives the scene from the selected layer",
			create: (c) => new ToggleLayer(c) as unknown as MeldAction<JsonObject>,
			input: (x) => ({ layer: x.layerA, future }),
			expected: (x) => ({ scene: x.sceneA, layer: x.layerA, action: "toggle", future }),
		},
		{
			name: "toggle-effect derives both parents from a stable effect id",
			create: (c) => new ToggleEffect(c) as unknown as MeldAction<JsonObject>,
			input: (x) => ({ effect: x.effectA, future }),
			expected: (x) => ({ scene: x.sceneA, layer: x.layerA, effect: x.effectA, action: "toggle", future }),
		},
		{
			name: "toggle-effect replaces an indexed setting with the stable mapper id",
			create: (c) => new ToggleEffect(c) as unknown as MeldAction<JsonObject>,
			input: (x) => ({ scene: x.sceneB, layer: x.layerB, effect: indexedEffectId(x.layerA, 0), future }),
			expected: (x) => ({ scene: x.sceneA, layer: x.layerA, effect: x.effectA, action: "toggle", future }),
		},
		{
			name: "media derives the scene and records its implicit toggle mode",
			create: (c) => new Media(c) as unknown as MeldAction<JsonObject>,
			input: (x) => ({ layer: x.layerA, future }),
			expected: (x) => ({ scene: x.sceneA, layer: x.layerA, action: "toggle", future }),
		},
		{
			name: "track toggles record their implicit toggle mode",
			create: (c) => new ToggleMute(c) as unknown as MeldAction<JsonObject>,
			input: (x) => ({ track: x.track, future }),
			expected: (x) => ({ track: x.track, action: "toggle", future }),
		},
		{
			name: "replay records its implicit replay mode",
			create: (c) => new Replay(c) as unknown as MeldAction<JsonObject>,
			input: () => ({ future }),
			expected: () => ({ action: "replay", future }),
		},
		{
			name: "volume records the inspector defaults",
			create: (c) => new VolumeStepper(c) as unknown as MeldAction<JsonObject>,
			// Stream Deck settings are JSON, so a damaged/hand-edited profile can
			// contain explicit nulls as well as omitted keys. Both mean "missing".
			input: (x) => ({ track: x.track, stepsize: null, metertype: null, future }),
			expected: (x) => ({ track: x.track, stepsize: "1", metertype: "db", future }),
			controller: "Encoder",
		},
		{
			name: "widget derives its owner from the event and records amount",
			create: (c) => new WidgetControl(c) as unknown as MeldAction<JsonObject>,
			input: () => ({ event: "COUNTDOWN_PAUSE", future }),
			expected: () => ({ event: "COUNTDOWN_PAUSE", widget: "COUNTDOWN", amount: "60", future }),
		},
		{
			name: "widget-only settings select that widget's canonical event",
			create: (c) => new WidgetControl(c) as unknown as MeldAction<JsonObject>,
			input: () => ({ widget: "COUNTDOWN", future }),
			expected: () => ({ widget: "COUNTDOWN", event: "COUNTDOWN_RESET", amount: "60", future }),
		},
		{
			name: "widget settings repair an event owned by another widget",
			create: (c) => new WidgetControl(c) as unknown as MeldAction<JsonObject>,
			input: () => ({ widget: "COUNTDOWN", event: "STOPWATCH_PAUSE", amount: "60", future }),
			expected: () => ({ widget: "COUNTDOWN", event: "COUNTDOWN_RESET", amount: "60", future }),
		},
		{
			name: "widget settings derive from a valid event when the stored widget is unknown",
			create: (c) => new WidgetControl(c) as unknown as MeldAction<JsonObject>,
			input: () => ({ widget: "BOGUS", event: "COUNTDOWN_PAUSE", future }),
			expected: () => ({ widget: "COUNTDOWN", event: "COUNTDOWN_PAUSE", amount: "60", future }),
		},
	];

	for (const migration of cases) {
		test(migration.name, async () => {
			const input = migration.input(ids);
			const expected = migration.expected(ids);
			const action = migration.create(connection);
			const instance = new FakeActionInstance<JsonObject>(`migration-${migration.name}`, input);
			mount(action, [instance]);

			await action.onWillAppear(willAppear(instance, input, migration.controller) as never);

			assert.deepEqual(instance.settingsWrites, [expected], "the old profile should be persisted once");
			assert.deepEqual(await instance.getSettings(), expected, "the action instance should hold canonical settings");

			// Stream Deck echoes a successful setSettings through didReceiveSettings.
			// Reprocessing the canonical object must settle, not start a write loop.
			await action.onDidReceiveSettings(didReceiveSettings(instance, expected) as never);
			assert.equal(instance.settingsWrites.length, 1, "the canonical echo must not be rewritten");
		});
	}

	test("overlapping lifecycle callbacks join one canonical settings write", async () => {
		const action = new Replay(connection) as unknown as MeldAction<JsonObject>;
		const instance = new DelayedSettingsInstance("migration-overlap", { future: { keep: true } });
		mount(action, [instance]);

		const appear = action.onWillAppear(willAppear(instance, { future: { keep: true } }) as never);
		await instance.writeStarted;
		const echoBeforeWriteSettles = action.onDidReceiveSettings(
			didReceiveSettings(instance, { future: { keep: true } }) as never,
		);
		instance.releaseWrite();
		await Promise.all([appear, echoBeforeWriteSettles]);

		assert.deepEqual(instance.settingsWrites, [{ future: { keep: true }, action: "replay" }]);
	});

	test("a stored non-default volume step is already canonical", async () => {
		const settings = { track: ids.track, stepsize: "3", metertype: "db" };
		const action = new VolumeStepper(connection);
		const instance = new FakeActionInstance("migration-volume-preserve", settings);
		mount(action, [instance]);

		await action.onWillAppear(willAppear(instance, settings, "Encoder") as never);

		assert.deepEqual(instance.settingsWrites, []);
		assert.deepEqual(await instance.getSettings(), settings);
	});

	test("a canonical migration is not rewritten when Meld restarts", async () => {
		const settings = { scene: ids.sceneB, layer: ids.layerB, effect: ids.effectA };
		const expected = {
			scene: ids.sceneA,
			layer: ids.layerA,
			effect: ids.effectA,
			action: "toggle",
		};
		const action = new ToggleEffect(connection);
		const instance = new FakeActionInstance("migration-restart", settings);
		mount(action, [instance]);
		await action.onWillAppear(willAppear(instance, settings) as never);
		assert.deepEqual(instance.settingsWrites, [expected]);

		const closed = new Promise<void>((resolve) => {
			const off = connection.on("closed", () => {
				off();
				resolve();
			});
		});
		await server.close();
		await closed;

		const ready = new Promise<void>((resolve) => {
			const off = connection.on("ready", () => {
				off();
				resolve();
			});
		});
		server = new MockWebChannel(build().scenario);
		await server.listen(port);
		await ready;

		assert.deepEqual(instance.settingsWrites, [expected], "restart hydration must not rewrite canonical settings");
	});
});
