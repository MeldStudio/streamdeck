// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class ToggleStreaming extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.toggle-stream");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      if ($MS.meld?.toggleStream) $MS.meld.toggleStream();
    });

    $MS.on("isStreamingChanged", (streaming) => {
      const state = streaming ? 1 : 0;
      this.forAllContexts((context) => {
        $SD.setState(context, state);
      });
    });
  }
}

const toggleStreaming = new ToggleStreaming();
