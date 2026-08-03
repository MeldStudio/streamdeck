// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Enough of a DOM and of Stream Deck's property-inspector socket to run the real
// ui/lib/meld-pi.js under Node.
//
// The `<select>` semantics are the part that matters. meld-pi.js relies on the
// browser rule that assigning a value no option carries leaves `selectedIndex`
// at -1 — that is how it detects a stored id that is no longer valid — and on
// the first appended option being selected automatically. Both are reproduced
// here; a looser fake would hide exactly the bugs these tests exist to catch.

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

/** An `<option>`. */
export class FakeOption {
	textContent = "";
	value = "";
	selected = false;
}

/** Base element with event listeners and a style object. */
class FakeElement {
	readonly style: { display: string } = { display: "" };
	disabled = false;
	readonly #listeners = new Map<string, ((event: unknown) => void)[]>();

	/**
	 * Registers a listener, as the DOM would.
	 * @param type Event name.
	 * @param handler Callback.
	 */
	addEventListener(type: string, handler: (event: unknown) => void): void {
		const existing = this.#listeners.get(type) ?? [];
		existing.push(handler);
		this.#listeners.set(type, existing);
	}

	/**
	 * Fires an event at this element, as a user interaction would.
	 * @param type Event name.
	 */
	dispatch(type: string): void {
		for (const handler of this.#listeners.get(type) ?? []) {
			handler({ target: this });
		}
	}
}

/** A `<select>` with the browser's selection rules. */
export class FakeSelect extends FakeElement {
	readonly options: FakeOption[] = [];
	selectedIndex = -1;

	/** Clearing `innerHTML` removes every option, as it does in a browser. */
	set innerHTML(html: string) {
		if (html === "") {
			this.options.length = 0;
			this.selectedIndex = -1;
		}
	}

	get innerHTML(): string {
		return this.options.map((o) => `<option value="${o.value}">${o.textContent}</option>`).join("");
	}

	/**
	 * Appends an option. The first option in an empty select becomes selected
	 * automatically; an option marked `selected` takes the selection.
	 * @param option The option to append.
	 */
	appendChild(option: FakeOption): FakeOption {
		this.options.push(option);
		if (option.selected) {
			this.selectedIndex = this.options.length - 1;
		} else if (this.options.length === 1) {
			this.selectedIndex = 0;
		}
		return option;
	}

	/** The selected option's value, or `""` when nothing is selected. */
	get value(): string {
		return this.selectedIndex >= 0 ? (this.options[this.selectedIndex]?.value ?? "") : "";
	}

	/** Selects the option carrying this value; deselects everything if none does. */
	set value(next: string) {
		const index = this.options.findIndex((option) => option.value === next);
		this.selectedIndex = index;
	}

	/** The visible text of each option, in order. */
	get labels(): string[] {
		return this.options.map((option) => option.textContent);
	}

	/** The value of each option, in order. */
	get values(): string[] {
		return this.options.map((option) => option.value);
	}

	/** Simulates the user picking an option by its value. */
	choose(value: string): void {
		this.value = value;
		this.dispatch("change");
	}
}

/** An `<input>`: its value is a plain string. */
export class FakeInput extends FakeElement {
	value = "";

	/** Simulates the user typing a value and committing it. */
	enter(value: string): void {
		this.value = value;
		this.dispatch("change");
	}
}

/** A frame the property inspector sent to Stream Deck. */
export type SentFrame = { event: string; context?: string; action?: string; payload?: unknown };

/** Stand-in for the property inspector's Stream Deck socket. */
export class FakePiSocket {
	static latest: FakePiSocket | undefined;

	readonly sent: SentFrame[] = [];
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;

	constructor() {
		FakePiSocket.latest = this;
	}

	/** Records an outbound frame. */
	send(data: string): void {
		this.sent.push(JSON.parse(data) as SentFrame);
	}

	/** Completes the connection, as the app does once the socket is up. */
	open(): void {
		this.onopen?.();
	}

	/**
	 * Delivers an inbound frame.
	 * @param message The message Stream Deck would send.
	 */
	receive(message: unknown): void {
		this.onmessage?.({ data: JSON.stringify(message) });
	}

	/** Every frame sent with the given event name. */
	framesFor(event: string): SentFrame[] {
		return this.sent.filter((frame) => frame.event === event);
	}
}

/** The property-inspector runtime plus the fakes backing it. */
export type PropertyInspector = {
	/** The `MeldPI` object the inspectors call. */
	MeldPI: Record<string, (...args: never[]) => unknown> & {
		bindSessionSelects(ids: string[], keepFilter?: (type: string, item: unknown) => boolean): void;
		bindField(id: string, fallback?: string): void;
		watchConnection(loadingId: string): void;
		getSettings(): Record<string, unknown>;
		patchSettings(patch: Record<string, unknown>): void;
		onSession(fn: (session: unknown) => void): void;
	};
	/** The socket the runtime opened. */
	socket: FakePiSocket;
	/** Registers an element under an id, as the inspector's markup would. */
	element<T extends FakeSelect | FakeInput>(id: string, element: T): T;
	/** Pushes a session snapshot, as the plugin's ui-bridge does. */
	pushSession(items: Record<string, unknown>, connected?: boolean): void;
	/** Delivers `didReceiveSettings`, as Stream Deck does after a write. */
	pushSettings(settings: Record<string, unknown>): void;
};

const MELD_PI_PATH = new URL("../../co.meldstudio.streamdeck.sdPlugin/ui/lib/meld-pi.js", import.meta.url);

/**
 * Loads the real property-inspector runtime against fake DOM and socket, and
 * completes its Stream Deck registration handshake.
 * @param settings Settings the action is configured with.
 * @param actionUuid The action's manifest UUID.
 */
export function loadPropertyInspector(
	settings: Record<string, unknown> = {},
	actionUuid = "co.meldstudio.streamdeck.toggle-layer",
): PropertyInspector {
	const elements = new Map<string, FakeSelect | FakeInput>();
	const window: Record<string, unknown> = {};
	const document = {
		getElementById: (id: string) => elements.get(id) ?? null,
		createElement: (tag: string) => (tag === "option" ? new FakeOption() : new FakeSelect()),
	};

	const context = createContext({ window, document, WebSocket: FakePiSocket, console });
	runInContext(readFileSync(MELD_PI_PATH, "utf8"), context, { filename: "meld-pi.js" });

	const connect = window.connectElgatoStreamDeckSocket as (
		port: number,
		uuid: string,
		registerEvent: string,
		info: string,
		actionInfo: string,
	) => void;
	connect(0, "ctx-1", "registerPropertyInspector", "{}", JSON.stringify({ action: actionUuid, payload: { settings } }));

	const socket = FakePiSocket.latest as FakePiSocket;

	return {
		MeldPI: window.MeldPI as PropertyInspector["MeldPI"],
		socket,
		element(id, element) {
			elements.set(id, element);
			return element;
		},
		pushSession(items, connected = true) {
			socket.receive({
				event: "sendToPropertyInspector",
				payload: { event: "meld.session", items, connected },
			});
		},
		pushSettings(next) {
			socket.receive({ event: "didReceiveSettings", payload: { settings: next } });
		},
	};
}
