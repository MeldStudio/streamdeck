// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { MeldAction, type RenderArgs } from "./base.js";
import { OptimisticStore } from "./optimistic.js";

/** Settings for {@link ShowScene}. */
type ShowSceneSettings = {
	scene?: string;
};

/**
 * How long the key stays optimistically lit while waiting for Meld to confirm.
 *
 * Unlike a gain change — which Meld reports immediately over `gainUpdated` — a
 * scene switch is only visible once the session snapshot is republished, and
 * that rides a 600 ms retriggerable autosave: any other session edit in the
 * meantime restarts the timer. The default optimistic TTL leaves almost no
 * headroom over that, so the key would blink dark before the confirmation
 * arrived. This gives the echo room while still self-correcting a press that
 * genuinely never took effect.
 */
const SCENE_CONFIRM_TTL_MS = 3_000;

/** Switches to a configured scene; the key lights up when that scene is live. */
@action({ UUID: "co.meldstudio.streamdeck.show-scene" })
export class ShowScene extends MeldAction<ShowSceneSettings> {
	/**
	 * Scene id optimistically requested per context, until Meld confirms it. If it
	 * expires unconfirmed (the request never took effect), repaint from
	 * authoritative state so the key doesn't stay lit for a scene that isn't live.
	 */
	readonly #requested = new OptimisticStore<string>(SCENE_CONFIRM_TTL_MS, (context) =>
		void this.#repaint(context),
	);

	/** @inheritdoc */
	override onKeyUp(ev: KeyUpEvent<ShowSceneSettings>): void {
		const scene = ev.payload.settings.scene;
		// Only act (and light the key) when the request can actually reach Meld and
		// name a scene it still has: `showScene` for an id from a previous instance
		// is a silent no-op that is never echoed, so lighting the key here would
		// fake a confirmation the session never gives back.
		if (!scene || !this.meld.ready || !this.session().has(scene)) {
			return;
		}
		// Optimistically light the key; the next session update confirms it.
		this.#requested.set(ev.action.id, scene);
		void this.setKeyState(ev.action, 0);
		this.meld.meld?.showScene?.(scene);
	}

	/**
	 * Repaints one context from authoritative state after its own request expired.
	 *
	 * Only that context: `renderAll` would clear every other key's still-pending
	 * request too, so one key's expiry would darken another key's in-flight press.
	 * @param context The context whose request expired.
	 */
	async #repaint(context: string): Promise<void> {
		for (const action of this.actions) {
			if (action.id !== context) {
				continue;
			}
			const settings = this.settingsFor(action.id);
			if (settings) {
				await this.render({ action, settings, session: this.session(), reason: "sessionChanged" });
			}
			return;
		}
	}

	/** @inheritdoc */
	protected async render({ action, settings, session, reason }: RenderArgs<ShowSceneSettings>): Promise<void> {
		// Authoritative session state supersedes any optimistic request.
		if (reason === "sessionChanged" || reason === "ready" || reason === "closed") {
			this.#requested.clear(action.id);
		}

		const scene = settings.scene;
		if (!scene) {
			return void this.setKeyState(action, 1);
		}
		// No snapshot yet: leave the current visual untouched to avoid a flash.
		if (!session.isPresent) {
			return;
		}
		if (!session.has(scene)) {
			return void this.setKeyState(action, 1);
		}
		if (this.#requested.get(action.id) === scene) {
			return void this.setKeyState(action, 0);
		}
		await this.setKeyState(action, session.getScene(scene)?.current ? 0 : 1);
	}
}
