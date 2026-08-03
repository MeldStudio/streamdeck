// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import streamDeck, { action, type DialDownEvent, type DialRotateEvent, type TouchTapEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { MeldSession } from "../meld/index.js";
import { MeldAction, type MeldActionInstance, type RenderArgs } from "./base.js";
import { OptimisticStore } from "./optimistic.js";

const TRANSITION_ICON = "assets/Scene Transition Control/Action Icon/sceneTransition";

/** The staged selection is shared by every visible dial, so one store key suffices. */
const STAGED_KEY = "staged";

/** A selectable staging scene. `index` is Meld's scene index, used for anchoring. */
type StagingScene = { id: string; name: string; index: number };

/**
 * Stream Deck+ dial that cycles through the available staging scenes and, on
 * push, transitions Meld to the selected staged scene.
 *
 * The list of scenes and the staged selection are both derived from the
 * authoritative session, with two refinements mirroring the volume dial:
 *  - an {@link OptimisticStore} keeps the user's newest selection on screen while
 *    Meld echoes of older `setStagedScene` calls are still in flight, so quick
 *    rotations don't snap backwards; and
 *  - after a transition (when no selectable scene is staged) rotation continues
 *    from the just-transitioned scene's neighborhood instead of resetting to the
 *    top of the list, matching the legacy stepper.
 */
@action({ UUID: "co.meldstudio.streamdeck.transition-stepper" })
export class TransitionStepper extends MeldAction<JsonObject> {
	/** Selectable scenes (non-current, non-linked), ordered by scene index. */
	#scenes: StagingScene[] = [];

	/** Index into {@link #scenes} of the staged scene, or -1 when none. */
	#stagedIndex = -1;

	/** Scene id rotation continues from when nothing is staged. */
	#anchorId: string | undefined;

	/** The anchor scene's last-known Meld index, for when it leaves the list. */
	#anchorIndex = -1;

	/**
	 * The user's in-flight staged selection (scene id), kept until Meld confirms
	 * it. If it expires unconfirmed, repaint from authoritative state.
	 */
	readonly #optimisticStaged = new OptimisticStore<string>(undefined, () => void this.renderAll("sessionChanged"));

	/** @inheritdoc */
	override onDialRotate(ev: DialRotateEvent<JsonObject>): void {
		const length = this.#scenes.length;
		// Rotating while disconnected would fake a selection Meld never receives.
		if (length === 0 || !this.meld.ready) {
			return;
		}
		const ticks = ev.payload.ticks;

		let position: number;
		if (this.#stagedIndex !== -1) {
			position = this.#stagedIndex + ticks;
		} else {
			// Nothing selectable is staged. If the anchor scene is still in the list
			// (staging was cancelled), rotate relative to it like a normal selection.
			const anchorPosition = this.#scenes.findIndex((scene) => scene.id === this.#anchorId);
			if (anchorPosition !== -1) {
				position = anchorPosition + ticks;
			} else {
				// The anchor scene left the list (typically it became current after a
				// transition). Continue from its neighborhood: `base` is the last list
				// position at or before the anchor, so +1 lands on the scene after the
				// gap and -1 on the one before it.
				let base = -1;
				for (let i = 0; i < length; i++) {
					if (this.#scenes[i].index <= this.#anchorIndex) {
						base = i;
					}
				}
				position = base + (ticks > 0 ? 0 : 1) + ticks;
			}
		}
		position = ((position % length) + length) % length;

		const scene = this.#scenes[position];
		this.#stagedIndex = position;
		this.#anchorId = scene.id;
		this.#anchorIndex = scene.index;
		this.#optimisticStaged.set(STAGED_KEY, scene.id);
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
	protected async render({ action, session, reason }: RenderArgs<JsonObject>): Promise<void> {
		if (reason === "closed") {
			// Keep the last painted state rather than flashing on a blip; the
			// authoritative snapshot on "ready" restores everything after reconnect.
			return;
		}
		if (!session.isPresent) {
			// No snapshot (mid-blip renders: an optimistic expiry, willAppear, or a
			// settings change while disconnected). Rebuilding now would wipe the
			// cached scene list the "closed" guard just preserved; only paint a
			// freshly appearing dial so it isn't blank.
			if (reason === "willAppear") {
				await this.#paint(action, this.#scenes[this.#stagedIndex]?.name);
			}
			return;
		}
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

	/** Rebuilds the scene list and staged selection from a session snapshot. */
	#rebuild(session: MeldSession): void {
		// Vertical-canvas twins are excluded: Meld resolves `setStagedScene` through
		// the horizontal scene model only (unlike `showScene`), so staging one is a
		// silent no-op and the dial would appear to select a scene it cannot reach.
		// The `vertical` flag is the whole test — the old plugin matched a "(linked)"
		// name suffix, which Meld deliberately stopped appending, so keeping that
		// would only drop scenes a user happened to name that way.
		const scenes = session
			.scenes()
			.filter((scene) => !scene.vertical)
			.sort((a, b) => a.index - b.index);
		this.#scenes = scenes
			.filter((scene) => !scene.current)
			.map((scene) => ({ id: scene.id, name: scene.name, index: scene.index }));

		// Right after a transition the staged flag can sit on the current scene;
		// nothing selectable is staged then, but it still moves the rotation anchor.
		const stagedAny = scenes.find((scene) => scene.staged);

		if (stagedAny) {
			this.#anchorId = stagedAny.id;
			this.#anchorIndex = stagedAny.index;
		} else {
			// Keep the anchor's index in step with Meld-side scene reorders so the
			// neighborhood fallback stays accurate after the anchor leaves the list.
			const anchorScene = scenes.find((scene) => scene.id === this.#anchorId);
			if (anchorScene) {
				this.#anchorIndex = anchorScene.index;
			} else if (this.#anchorId !== undefined) {
				// The anchor scene no longer exists at all (a different Meld instance
				// or project): start fresh rather than anchoring to a foreign index.
				this.#anchorId = undefined;
				this.#anchorIndex = -1;
			}
		}

		const authoritative = stagedAny && !stagedAny.current ? stagedAny : undefined;
		let selectedId = authoritative?.id;

		const optimistic = this.#optimisticStaged.get(STAGED_KEY);
		if (optimistic !== undefined) {
			if (authoritative?.id === optimistic) {
				// Meld confirmed the user's selection; authoritative takes over.
				this.#optimisticStaged.clear(STAGED_KEY);
			} else if (this.#scenes.some((scene) => scene.id === optimistic)) {
				// This update predates our latest setStagedScene (an echo of an older
				// one, or an unrelated change). Keep showing the newer selection; a
				// genuinely different authoritative value wins once the TTL expires.
				selectedId = optimistic;
			} else {
				// The optimistically selected scene vanished; fall back.
				this.#optimisticStaged.clear(STAGED_KEY);
			}
		}

		this.#stagedIndex = selectedId ? this.#scenes.findIndex((scene) => scene.id === selectedId) : -1;
		if (this.#stagedIndex !== -1) {
			this.#anchorId = this.#scenes[this.#stagedIndex].id;
			this.#anchorIndex = this.#scenes[this.#stagedIndex].index;
		}
	}

	/** Paints the staged scene name onto a single dial. */
	#paint(action: MeldActionInstance<JsonObject>, name: string | undefined): Promise<void> {
		return this.asDial(action)
			.setFeedback({
				icon: TRANSITION_ICON,
				title: name ?? "Nothing Staged",
			})
			.catch((err) => {
				streamDeck.logger.error(`Failed to set feedback for ${action.id}`, err);
			});
	}

	/** Paints the staged scene name onto every visible dial. */
	async #paintAll(name: string | undefined): Promise<void> {
		for (const action of this.actions) {
			await this.#paint(action, name);
		}
	}
}
