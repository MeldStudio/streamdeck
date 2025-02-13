// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class ToggleMonitor extends MeldStudioPlugin {
  cueState = {};

  setLocalState(context, cued) {
    const state = cued ? 1 : 0;
    $SD.setState(context, state);
  }

  constructor() {
    super("co.meldstudio.streamdeck.toggle-monitor");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { track, action: toggle_action } = this.getSettings(context);
      if (!track) return;

      if (!toggle_action || toggle_action === "toggle") {
        if ($MS.meld?.toggleMonitor) $MS.meld.toggleMonitor(track);
      } else {
        const action_cue = toggle_action === "cue";
        const state_cue = this.cueState[context];

        // cue | state | action
        // 1   | 0     | 1
        // 0   | 1     | 1
        // 1   | 1     | 0
        // 0   | 0     | 0

        if ($MS.meld?.setProperty) {
          $MS.meld.setProperty(track, "monitoring", action_cue);
          this.setLocalState(context, action_cue);
        } else {
          const shouldToggle = action_cue ^ state_cue;
          if (!shouldToggle) this.setLocalState(context, state_cue);
          if (shouldToggle && $MS.meld?.toggleMonitor)
            $MS.meld.toggleMonitor(track);
        }
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { track, action } = settings;
        if (!track) return;
        if (!session.items[track]) return $SD.setState(context, 0);

        const cued = session.items[track].monitoring;
        this.cueState[context] = cued;

        this.setLocalState(context, cued);
      });
    });
  }
}

const toggleMonitor = new ToggleMonitor();
