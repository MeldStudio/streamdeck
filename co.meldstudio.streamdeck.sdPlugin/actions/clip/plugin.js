// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class Screenshot extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.clip");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      if ($MS.meld?.sendCommand)
        $MS.meld.sendCommand("meld.recordClip");
    });
  }
}

const screenshot = new Screenshot();
