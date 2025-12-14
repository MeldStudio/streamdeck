// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

const ADD_TIME_EVENT = 'SUBATHONTIMER_ADDTIME'
const DEFAULT_EVENT = 'STOPWATCH_RESET'

const WIDGET_EVENT_ICONS = {
  STOPWATCH_RESET: 'assets/Widget/Key Icon/widget-stopwatch-reset',
  STOPWATCH_PAUSE: 'assets/Widget/Key Icon/widget-stopwatch-pause',
  STOPWATCH_RESUME: 'assets/Widget/Key Icon/widget-stopwatch-resume',
  COUNTDOWN_RESET: 'assets/Widget/Key Icon/widget-countdown-reset',
  COUNTDOWN_PAUSE: 'assets/Widget/Key Icon/widget-countdown-pause',
  COUNTDOWN_RESUME: 'assets/Widget/Key Icon/widget-countdown-resume',
  CONFETTIFALL_TRIGGER: 'assets/Widget/Key Icon/widget-confettifall-trigger',
  CONFETTIPOP_TRIGGER: 'assets/Widget/Key Icon/widget-confettipop-trigger',
  SUBATHONTIMER_RESET: 'assets/Widget/Key Icon/widget-subathontimer-reset',
  SUBATHONTIMER_PAUSE: 'assets/Widget/Key Icon/widget-subathontimer-pause',
  SUBATHONTIMER_RESUME: 'assets/Widget/Key Icon/widget-subathontimer-resume',
  SUBATHONTIMER_ADDTIME: 'assets/Widget/Key Icon/widget-subathontimer-addtime',
  COUNTER_INCREMENT: 'assets/Widget/Key Icon/widget-counter-increment',
  COUNTER_DECREMENT: 'assets/Widget/Key Icon/widget-counter-decrement'
}

class WidgetControl extends MeldStudioPlugin {
  constructor () {
    super('co.meldstudio.streamdeck.widget-control')

    this.action.onWillAppear(({ context }) => {
      const { event: eventType } = this.getSettings(context)
      this.setKeyImage(context, eventType)
    })

    this.action.onKeyUp(({ context }) => {
      const { event: eventTypeSetting, amount } = this.getSettings(context)
      const eventType = eventTypeSetting || DEFAULT_EVENT
      console.log(eventType)

      const payload = this.buildPayload(eventType, amount)

      if ($MS.meld?.sendStreamEvent) {
        if (payload === undefined) {
          $MS.meld.sendStreamEvent(eventType, false)
        } else {
          $MS.meld.sendStreamEvent(eventType, payload)
        }
      }
    })
  }

  onReceivedSettings (context, newSettings) {
    this.setKeyImage(context, newSettings?.event)
  }

  setKeyImage (context, eventType) {
    const selectedEvent = eventType || DEFAULT_EVENT
    const imagePath =
      WIDGET_EVENT_ICONS[selectedEvent] ||
      WIDGET_EVENT_ICONS[DEFAULT_EVENT] ||
      'assets/Widget/Key Icon/widget-controls-pause'

    $SD.setImage(context, imagePath, 0)
  }

  buildPayload (eventType, amountSetting) {
    if (eventType !== ADD_TIME_EVENT) return undefined

    const parsedAmount = Number(amountSetting)
    const amount = Number.isFinite(parsedAmount)
      ? Math.max(0, Math.round(parsedAmount))
      : 0

    return { amount }
  }
}

const widgetControl = new WidgetControl()
