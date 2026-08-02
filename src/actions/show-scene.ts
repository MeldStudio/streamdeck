// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { MeldAction, type RenderArgs } from "./base.js";
import { OptimisticStore } from "./optimistic.js";

/** Settings for {@link ShowScene}. */
type ShowSceneSettings = {
	scene?: string;
};

/** Switches to a configured scene; the key lights up when that scene is live. */
@action({ UUID: "co.meldstudio.streamdeck.show-scene" })
export class ShowScene extends MeldAction<ShowSceneSettings> {
	/** Scene id optimistically requested per context, until Meld confirms it. */
	readonly #requested = new OptimisticStore<string>();

	/** @inheritdoc */
	override onKeyUp(ev: KeyUpEvent<ShowSceneSettings>): void {
		const scene = ev.payload.settings.scene;
		if (!scene) {
			return;
		}
		// Optimistically light the key; the next session update confirms it.
		this.#requested.set(ev.action.id, scene);
		void this.setKeyState(ev.action, 1);
		this.meld.meld?.showScene?.(scene);
	}

	/** @inheritdoc */
	protected async render({ action, settings, session, reason }: RenderArgs<ShowSceneSettings>): Promise<void> {
		// Authoritative session state supersedes any optimistic request.
		if (reason === "sessionChanged" || reason === "ready" || reason === "closed") {
			this.#requested.clear(action.id);
		}

		const scene = settings.scene;
		if (!scene) {
			return void this.setKeyState(action, 0);
		}
		// No snapshot yet: leave the current visual untouched to avoid a flash.
		if (!session.isPresent) {
			return;
		}
		if (!session.has(scene)) {
			return void this.setKeyState(action, 0);
		}
		if (this.#requested.get(action.id) === scene) {
			return void this.setKeyState(action, 1);
		}
		await this.setKeyState(action, session.getScene(scene)?.current ? 1 : 0);
	}
}
