// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import { action, type KeyUpEvent } from "@elgato/streamdeck";

import { MeldAction, type RenderArgs } from "./base.js";

/** Settings for {@link WidgetControl}. */
type WidgetControlSettings = {
	widget?: string;
	event?: string;
	amount?: string | number;
};

const ADD_TIME_EVENT = "SUBATHONTIMER_ADDTIME";
const DEFAULT_EVENT = "STOPWATCH_RESET";
const DEFAULT_WIDGET = "STOPWATCH";
const DEFAULT_AMOUNT = "60";

const EVENT_WIDGET: Record<string, string> = {
	STOPWATCH_RESET: "STOPWATCH",
	STOPWATCH_PAUSE: "STOPWATCH",
	STOPWATCH_RESUME: "STOPWATCH",
	COUNTDOWN_RESET: "COUNTDOWN",
	COUNTDOWN_PAUSE: "COUNTDOWN",
	COUNTDOWN_RESUME: "COUNTDOWN",
	CONFETTIFALL_TRIGGER: "CONFETTIFALL",
	CONFETTIPOP_TRIGGER: "CONFETTIPOP",
	SUBATHONTIMER_RESET: "SUBATHONTIMER",
	SUBATHONTIMER_PAUSE: "SUBATHONTIMER",
	SUBATHONTIMER_RESUME: "SUBATHONTIMER",
	SUBATHONTIMER_ADDTIME: "SUBATHONTIMER",
	WHEELSPIN_SPIN: "WHEELSPIN",
	COUNTER_INCREMENT: "COUNTER",
	COUNTER_DECREMENT: "COUNTER",
};

const DEFAULT_EVENT_BY_WIDGET: Record<string, string> = {
	STOPWATCH: "STOPWATCH_RESET",
	COUNTDOWN: "COUNTDOWN_RESET",
	CONFETTIFALL: "CONFETTIFALL_TRIGGER",
	CONFETTIPOP: "CONFETTIPOP_TRIGGER",
	SUBATHONTIMER: "SUBATHONTIMER_RESET",
	WHEELSPIN: "WHEELSPIN_SPIN",
	COUNTER: "COUNTER_INCREMENT",
};

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
	WHEELSPIN_SPIN: "assets/Widget/Key Icon/widget-wheelspin-spin",
};

/** Dispatches widget stream events (stopwatch, countdown, confetti, etc.). */
@action({ UUID: "co.meldstudio.streamdeck.widget-control" })
export class WidgetControl extends MeldAction<WidgetControlSettings> {
	protected override migrateSettings(settings: WidgetControlSettings): WidgetControlSettings {
		const requestedEvent = settings.event ?? DEFAULT_EVENT;
		const widget =
			(settings.widget && DEFAULT_EVENT_BY_WIDGET[settings.widget] ? settings.widget : undefined) ??
			EVENT_WIDGET[requestedEvent] ??
			DEFAULT_WIDGET;
		const event = EVENT_WIDGET[requestedEvent] === widget ? requestedEvent : DEFAULT_EVENT_BY_WIDGET[widget];
		const amount = settings.amount ?? DEFAULT_AMOUNT;
		if (settings.event === event && settings.widget === widget && settings.amount != null) {
			return settings;
		}
		return { ...settings, widget, event, amount };
	}

	/** Shows the icon for the configured event. Independent of session state. */
	protected render({ action, settings }: RenderArgs<WidgetControlSettings>): Promise<void> {
		return this.setKeyImage(action, this.#iconFor(settings.event));
	}

	/** @inheritdoc */
	override onKeyUp(ev: KeyUpEvent<WidgetControlSettings>): void {
		// A migrated setSettings echo can arrive after the user's first press. The
		// canonical cache is already populated, so use it instead of dispatching the
		// stale event payload during that window.
		const settings = this.settingsFor(ev.action.id) ?? ev.payload.settings;
		const eventType = settings.event || DEFAULT_EVENT;
		const payload = this.#buildPayload(eventType, settings.amount);

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
