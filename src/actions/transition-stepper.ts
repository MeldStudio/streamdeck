// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type DialDownEvent, type DialRotateEvent, type TouchTapEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { MeldSession } from "../meld/index.js";
import { MeldAction, type MeldActionInstance, type RenderArgs } from "./base.js";

const TRANSITION_ICON = "assets/Scene Transition Control/Action Icon/sceneTransition";

/** A selectable staging scene. */
type StagingScene = { id: string; name: string };

/**
 * Stream Deck+ dial that cycles through the available staging scenes and, on
 * push, transitions Meld to the selected staged scene.
 *
 * The list of scenes and the staged selection are both derived from the
 * authoritative session, so a scene added/removed/renamed in Meld is reflected
 * without any local bookkeeping drifting out of sync.
 */
@action({ UUID: "co.meldstudio.streamdeck.transition-stepper" })
export class TransitionStepper extends MeldAction<JsonObject> {
	/** Selectable scenes (non-current, non-linked), ordered by scene index. */
	#scenes: StagingScene[] = [];

	/** Index into {@link #scenes} of the staged scene, or -1 when none. */
	#stagedIndex = -1;

	/** @inheritdoc */
	override onDialRotate(ev: DialRotateEvent<JsonObject>): void {
		if (this.#scenes.length === 0) {
			return;
		}
		const length = this.#scenes.length;
		this.#stagedIndex = (((this.#stagedIndex + ev.payload.ticks) % length) + length) % length;

		const scene = this.#scenes[this.#stagedIndex];
		this.meld.meld?.setStagedScene?.(scene.id);
		void this.#paintAll(scene.name);
	}

	/** @inheritdoc */
	override onDialDown(_ev: DialDownEvent<JsonObject>): void {
		this.#showStaged();
	}

	/** @inheritdoc */
	override onTouchTap(ev: TouchTapEvent<JsonObject>): void {
		if (ev.payload.hold) {
			this.#showStaged();
		}
	}

	/** @inheritdoc */
	protected async render({ action, session }: RenderArgs<JsonObject>): Promise<void> {
		this.#rebuild(session);
		await this.#paint(action, this.#scenes[this.#stagedIndex]?.name);
	}

	/** Transitions Meld to the currently staged scene, if one is selected. */
	#showStaged(): void {
		if (this.#stagedIndex === -1) {
			return;
		}
		this.meld.meld?.showStagedScene?.();
	}

	/** Rebuilds the scene list and staged index from a session snapshot. */
	#rebuild(session: MeldSession): void {
		this.#scenes = session
			.scenes()
			.filter((scene) => !scene.current && !scene.name.includes("(linked)"))
			.sort((a, b) => a.index - b.index)
			.map((scene) => ({ id: scene.id, name: scene.name }));

		const staged = session
			.scenes()
			.find((scene) => scene.staged && !scene.current && !scene.name.includes("(linked)"));
		this.#stagedIndex = staged ? this.#scenes.findIndex((scene) => scene.id === staged.id) : -1;
	}

	/** Paints the staged scene name onto a single dial. */
	#paint(action: MeldActionInstance<JsonObject>, name: string | undefined): Promise<void> {
		return this.asDial(action).setFeedback({
			icon: TRANSITION_ICON,
			title: name ?? "Nothing Staged",
		});
	}

	/** Paints the staged scene name onto every visible dial. */
	async #paintAll(name: string | undefined): Promise<void> {
		for (const action of this.actions) {
			await this.#paint(action, name);
		}
	}
}
