// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

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
