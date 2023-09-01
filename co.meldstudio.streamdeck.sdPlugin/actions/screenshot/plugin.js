class Screenshot extends MeldStudioPlugin {
  sceneRequested = null;

  constructor() {
    super("co.meldstudio.streamdeck.screenshot");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      if ($MS.meld?.sendEvent) $MS.meld.sendEvent("screenshot");
    });
  }
}

const screenshot = new Screenshot();
