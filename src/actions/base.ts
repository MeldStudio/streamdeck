// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import streamDeck, {
	type DialAction,
	type DidReceiveSettingsEvent,
	type KeyAction,
	type KeyDownEvent,
	SingletonAction,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import { meld, type MeldConnection, MeldSession } from "../meld/index.js";

/** Why {@link MeldAction.render} was invoked. */
export type RenderReason =
	| "willAppear"
	| "didReceiveSettings"
	| "sessionChanged"
	| "streamingChanged"
	| "recordingChanged"
	| "ready"
	| "closed";

/** A visible action instance — either a key or a dial. */
export type MeldActionInstance<T extends JsonObject> = DialAction<T> | KeyAction<T>;

/** Everything an action needs to render one context deterministically. */
export type RenderArgs<T extends JsonObject> = {
	/** The action instance to update. */
	action: MeldActionInstance<T>;
	/** The action instance's current settings. */
	settings: T;
	/** A read-only view of the latest authoritative Meld session. */
	session: MeldSession;
	/** Why the render was triggered. */
	reason: RenderReason;
};

/**
 * Base class for every Meld action.
 *
 * It collapses the old, race-prone `onWillAppear` → `getSettings` →
 * `onDidReceiveSettings` → `hydrateAll` → `onHydrate` chain into a single
 * declarative {@link render} method that the framework calls whenever anything
 * relevant changes: the action appears, its settings change, the session
 * changes, streaming/recording toggles, or the connection (re)connects.
 *
 * Subclasses implement {@link render} and, if needed, the small optional hooks.
 * They never wire up reconnect handling themselves — the shared
 * {@link MeldConnection} owns that.
 */
export abstract class MeldAction<T extends JsonObject = JsonObject> extends SingletonAction<T> {
	/** The shared, process-wide Meld connection. */
	protected readonly meld: MeldConnection;

	/** Latest known settings per visible context id. */
	readonly #settings = new Map<string, T>();

	/** Last state/image pushed per context, used to suppress redundant messages. */
	readonly #lastState = new Map<string, number>();
	readonly #lastImage = new Map<string, string | undefined>();

	/**
	 * @param connection Meld connection to bind to. Defaults to the process-wide
	 * singleton; tests pass one pointed at a fake Meld.
	 */
	constructor(connection: MeldConnection = meld) {
		super();
		this.meld = connection;
		// One subscription set per action instance (a singleton). The connection
		// re-emits a full snapshot on every (re)connect, so these cover hydration.
		this.meld.on("ready", () => void this.renderAll("ready"));
		this.meld.on("closed", () => void this.renderAll("closed"));
		this.meld.on("sessionChanged", () => void this.renderAll("sessionChanged"));
		this.meld.on("streamingChanged", () => void this.renderAll("streamingChanged"));
		this.meld.on("recordingChanged", () => void this.renderAll("recordingChanged"));
	}

	/** Whether Meld is currently streaming (authoritative). */
	protected get isStreaming(): boolean {
		return !!this.meld.meld?.isStreaming;
	}

	/** Whether Meld is currently recording (authoritative). */
	protected get isRecording(): boolean {
		return !!this.meld.meld?.isRecording;
	}

	/**
	 * Renders a single context from authoritative state. Implemented by each action.
	 * @param args Action, settings, session snapshot, and the trigger reason.
	 */
	protected abstract render(args: RenderArgs<T>): void | Promise<void>;

	/**
	 * Optional hook invoked once when an action becomes visible, before its first
	 * {@link render}. Use for one-time setup such as initial dial feedback.
	 * @param args Render arguments for the appearing context.
	 */
	protected onAppear?(args: RenderArgs<T>): void | Promise<void>;

	/**
	 * Optional hook invoked when an action becomes invisible. Use for cleanup such
	 * as unregistering a track observer.
	 * @param context The disappearing context id.
	 * @param settings The context's last known settings, if any.
	 */
	protected onDisappear?(context: string, settings: T | undefined): void | Promise<void>;

	/**
	 * Optional hook invoked when settings change, before {@link render}.
	 * @param args Render arguments plus the previous settings.
	 */
	protected onSettingsChanged?(args: RenderArgs<T> & { previous: T | undefined }): void | Promise<void>;

	/** @inheritdoc */
	override async onWillAppear(ev: WillAppearEvent<T>): Promise<void> {
		this.#settings.set(ev.action.id, ev.payload.settings);
		const args: RenderArgs<T> = {
			action: ev.action,
			settings: ev.payload.settings,
			session: this.session(),
			reason: "willAppear",
		};
		await this.onAppear?.(args);
		await this.render(args);
	}

	/** @inheritdoc */
	override async onWillDisappear(ev: WillDisappearEvent<T>): Promise<void> {
		const settings = this.#settings.get(ev.action.id);
		this.#settings.delete(ev.action.id);
		this.#lastState.delete(ev.action.id);
		this.#lastImage.delete(ev.action.id);
		await this.onDisappear?.(ev.action.id, settings);
	}

	/** @inheritdoc */
	override onKeyDown(ev: KeyDownEvent<T>): void {
		// The Stream Deck app may repaint a key on press (multi-actions, or any
		// state the manifest doesn't cover), so the displayed state can no longer be
		// assumed to match what we last sent. Forget it so the next setKeyState /
		// setKeyImage always reasserts the authoritative visuals.
		this.#lastState.delete(ev.action.id);
		this.#lastImage.delete(ev.action.id);
	}

	/** @inheritdoc */
	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<T>): Promise<void> {
		const previous = this.#settings.get(ev.action.id);
		this.#settings.set(ev.action.id, ev.payload.settings);
		const args: RenderArgs<T> = {
			action: ev.action,
			settings: ev.payload.settings,
			session: this.session(),
			reason: "didReceiveSettings",
		};
		await this.onSettingsChanged?.({ ...args, previous });
		await this.render(args);
	}

	/** A read-only view over the latest authoritative session snapshot. */
	protected session(): MeldSession {
		return new MeldSession(this.meld.session);
	}

	/** The cached settings for a context, if known. */
	protected settingsFor(context: string): T | undefined {
		return this.#settings.get(context);
	}

	/**
	 * Re-renders every visible instance of this action from the current session.
	 * @param reason Why the re-render was triggered.
	 */
	protected async renderAll(reason: RenderReason): Promise<void> {
		const session = this.session();
		for (const action of this.actions) {
			// Contain per-context failures: renderAll is invoked fire-and-forget from
			// connection events, and one bad context must not skip the others or
			// surface as an unhandled rejection.
			try {
				let settings = this.#settings.get(action.id);
				if (settings === undefined) {
					settings = await action.getSettings<T>();
					this.#settings.set(action.id, settings);
				}
				await this.render({ action, settings, session, reason });
			} catch (err) {
				streamDeck.logger.error(`Failed to render ${action.id} (${reason})`, err);
			}
		}
	}

	/**
	 * Sets a key's state, suppressing the message when the state is unchanged.
	 * @param action Key action instance.
	 * @param state State to display (0 or 1).
	 */
	protected async setKeyState(action: MeldActionInstance<T>, state: 0 | 1): Promise<void> {
		if (this.#lastState.get(action.id) === state) {
			return;
		}
		// Cache only after a successful send so a failure is retried on the next
		// render; several call sites are fire-and-forget, so contain the error here.
		try {
			await this.asKey(action).setState(state);
			this.#lastState.set(action.id, state);
		} catch (err) {
			streamDeck.logger.error(`Failed to set state for ${action.id}`, err);
		}
	}

	/**
	 * Sets a key's image, suppressing the message when the image is unchanged.
	 * @param action Key action instance.
	 * @param image Image path/data, or `undefined` to fall back to the manifest.
	 */
	protected async setKeyImage(action: MeldActionInstance<T>, image: string | undefined): Promise<void> {
		if (this.#lastImage.get(action.id) === image) {
			return;
		}
		try {
			await this.asKey(action).setImage(image);
			this.#lastImage.set(action.id, image);
		} catch (err) {
			streamDeck.logger.error(`Failed to set image for ${action.id}`, err);
		}
	}

	/** Narrows an instance to a {@link KeyAction}; only valid for keypad actions. */
	protected asKey(action: MeldActionInstance<T>): KeyAction<T> {
		return action as KeyAction<T>;
	}

	/** Narrows an instance to a {@link DialAction}; only valid for encoder actions. */
	protected asDial(action: MeldActionInstance<T>): DialAction<T> {
		return action as DialAction<T>;
	}
}
