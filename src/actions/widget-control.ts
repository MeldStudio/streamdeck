// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { MeldAction, type RenderArgs } from "./base.js";

/** Settings for {@link WidgetControl}. */
type WidgetControlSettings = {
	event?: string;
	amount?: string | number;
};

const ADD_TIME_EVENT = "SUBATHONTIMER_ADDTIME";
const DEFAULT_EVENT = "STOPWATCH_RESET";

/** Maps each widget stream event to its key icon. */
const WIDGET_EVENT_ICONS: Record<string, string> = {
	STOPWATCH_RESET: "assets/Widget/Key Icon/widget-stopwatch-reset",
	STOPWATCH_PAUSE: "assets/Widget/Key Icon/widget-stopwatch-pause",
	STOPWATCH_RESUME: "assets/Widget/Key Icon/widget-stopwatch-resume",
	COUNTDOWN_RESET: "assets/Widget/Key Icon/widget-countdown-reset",
	COUNTDOWN_PAUSE: "assets/Widget/Key Icon/widget-countdown-pause",
	COUNTDOWN_RESUME: "assets/Widget/Key Icon/widget-countdown-resume",
	CONFETTIFALL_TRIGGER: "assets/Widget/Key Icon/widget-confettifall-trigger",
	CONFETTIPOP_TRIGGER: "assets/Widget/Key Icon/widget-confettipop-trigger",
	SUBATHONTIMER_RESET: "assets/Widget/Key Icon/widget-subathontimer-reset",
	SUBATHONTIMER_PAUSE: "assets/Widget/Key Icon/widget-subathontimer-pause",
	SUBATHONTIMER_RESUME: "assets/Widget/Key Icon/widget-subathontimer-resume",
	SUBATHONTIMER_ADDTIME: "assets/Widget/Key Icon/widget-subathontimer-addtime",
	COUNTER_INCREMENT: "assets/Widget/Key Icon/widget-counter-increment",
	COUNTER_DECREMENT: "assets/Widget/Key Icon/widget-counter-decrement",
};

/** Dispatches widget stream events (stopwatch, countdown, confetti, etc.). */
@action({ UUID: "co.meldstudio.streamdeck.widget-control" })
export class WidgetControl extends MeldAction<WidgetControlSettings> {
	/** Shows the icon for the configured event. Independent of session state. */
	protected render({ action, settings }: RenderArgs<WidgetControlSettings>): Promise<void> {
		return this.setKeyImage(action, this.#iconFor(settings.event));
	}

	/** @inheritdoc */
	override onKeyUp(ev: KeyUpEvent<WidgetControlSettings>): void {
		const eventType = ev.payload.settings.event || DEFAULT_EVENT;
		const payload = this.#buildPayload(eventType, ev.payload.settings.amount);

		const meld = this.meld.meld;
		if (!meld?.sendStreamEvent) {
			return;
		}
		// Events without data are sent with `false`, mirroring the original plugin.
		meld.sendStreamEvent(eventType, payload ?? false);
	}

	/** The icon for an event, falling back to the default event's icon. */
	#iconFor(event: string | undefined): string {
		const selected = event || DEFAULT_EVENT;
		return WIDGET_EVENT_ICONS[selected] ?? WIDGET_EVENT_ICONS[DEFAULT_EVENT];
	}

	/** Builds the optional payload; only the add-time event carries data. */
	#buildPayload(eventType: string, amountSetting: string | number | undefined): { amount: number } | undefined {
		if (eventType !== ADD_TIME_EVENT) {
			return undefined;
		}
		const parsed = Number(amountSetting);
		const amount = Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
		return { amount };
	}
}
