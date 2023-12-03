class Screenshot extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.screenshot");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      if ($MS.meld?.sendEvent)
        $MS.meld.sendEvent("co.meldstudio.events.screenshot");
    });
  }
}

const screenshot = new Screenshot();
