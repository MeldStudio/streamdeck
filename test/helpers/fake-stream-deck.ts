// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// A stand-in for the Stream Deck side of an action: fake key and dial instances
// that record what the plugin painted, plus a `mount` helper that attaches them
// to a real action so its render lifecycle can be driven directly.
//
// This deliberately fakes only what MeldAction touches. Everything below the
// action — the Meld connection, QWebChannel, the session — is the real code
// running against the fake Meld in tools/fake-meld.

import type { JsonObject } from "@elgato/utils";

import type { MeldAction } from "../../src/actions/base.ts";

/** Feedback payload passed to a dial's touchscreen. */
export type Feedback = {
	icon?: string;
	title?: string;
	value?: string;
	indicator?: { value: number; enabled: boolean; bar_bg_c: string };
};

/**
 * A fake visible action instance. Stands in for the SDK's `KeyAction` /
 * `DialAction`, recording every paint so tests can assert on what the user
 * would see.
 */
export class FakeActionInstance<T extends JsonObject = JsonObject> {
	readonly id: string;

	/** Every state pushed, in order. */
	readonly states: (0 | 1)[] = [];
	/** Every image pushed, in order. */
	readonly images: (string | undefined)[] = [];
	/** Every dial feedback pushed, in order. */
	readonly feedbacks: Feedback[] = [];

	#settings: T;

	constructor(id: string, settings: T) {
		this.id = id;
		this.#settings = settings;
	}

	/** The most recent state pushed, or `undefined` if none. */
	get state(): 0 | 1 | undefined {
		return this.states.at(-1);
	}

	/** The most recent image pushed, or `undefined` if none. */
	get image(): string | undefined {
		return this.images.at(-1);
	}

	/** The most recent dial feedback pushed, or `undefined` if none. */
	get feedback(): Feedback | undefined {
		return this.feedbacks.at(-1);
	}

	/** Replaces the settings the SDK would report for this instance. */
	setLocalSettings(settings: T): void {
		this.#settings = settings;
	}

	// --- The surface MeldAction uses -----------------------------------------

	/** @returns The instance's current settings, as the SDK would. */
	async getSettings<U extends JsonObject = T>(): Promise<U> {
		return this.#settings as unknown as U;
	}

	/** Records a key state push. */
	async setState(state: 0 | 1): Promise<void> {
		this.states.push(state);
	}

	/** Records a key image push. */
	async setImage(image: string | undefined): Promise<void> {
		this.images.push(image);
	}

	/** Records a dial feedback push. */
	async setFeedback(feedback: Feedback): Promise<void> {
		this.feedbacks.push(feedback);
	}

	/** Discards every recorded paint, so a test can assert on what follows. */
	reset(): void {
		this.states.length = 0;
		this.images.length = 0;
		this.feedbacks.length = 0;
	}
}

/**
 * Attaches fake instances to an action, replacing the SDK-backed `actions`
 * getter that enumerates visible contexts.
 * @param action The action under test.
 * @param instances The visible instances it should see.
 */
export function mount<T extends JsonObject>(
	action: MeldAction<T>,
	instances: FakeActionInstance<T>[],
): void {
	Object.defineProperty(action, "actions", {
		configurable: true,
		get: () => instances[Symbol.iterator](),
	});
}

/**
 * Builds a `willAppear` event for a fake instance.
 * @param instance The appearing instance.
 * @param settings Settings the SDK reports with the event.
 * @param controller Whether the instance is a key or an encoder.
 */
export function willAppear<T extends JsonObject>(
	instance: FakeActionInstance<T>,
	settings: T,
	controller: "Keypad" | "Encoder" = "Keypad",
): { action: unknown; payload: { settings: T; controller: string } } {
	instance.setLocalSettings(settings);
	return { action: instance, payload: { settings, controller } };
}

/**
 * Builds a `didReceiveSettings` event for a fake instance.
 * @param instance The instance whose settings changed.
 * @param settings The new settings.
 */
export function didReceiveSettings<T extends JsonObject>(
	instance: FakeActionInstance<T>,
	settings: T,
): { action: unknown; payload: { settings: T } } {
	instance.setLocalSettings(settings);
	return { action: instance, payload: { settings } };
}

/**
 * Builds a key-press event for a fake instance.
 * @param instance The pressed instance.
 * @param settings Settings the SDK reports with the event.
 */
export function keyEvent<T extends JsonObject>(
	instance: FakeActionInstance<T>,
	settings: T,
): { action: unknown; payload: { settings: T } } {
	return { action: instance, payload: { settings } };
}

/**
 * Builds a dial-rotate event for a fake instance.
 * @param instance The rotated instance.
 * @param settings Settings the SDK reports with the event.
 * @param ticks Detents turned; negative is counter-clockwise.
 */
export function dialRotate<T extends JsonObject>(
	instance: FakeActionInstance<T>,
	settings: T,
	ticks: number,
): { action: unknown; payload: { settings: T; ticks: number } } {
	return { action: instance, payload: { settings, ticks } };
}
