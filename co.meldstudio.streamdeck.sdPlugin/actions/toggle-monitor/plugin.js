class ToggleMonitor extends MeldStudioPlugin {
  cueState = {}

  constructor() {
    super("co.meldstudio.streamdeck.toggle-monitor");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { track, action: mute_action } = this.getSettings(context);
      if (!track) return;

      if (toggle_action === "toggle") {
        if ($MS.meld?.toggleMonitor) $MS.meld.toggleMonitor(track);
      } else {
        const action_cue = toggle_action === "cue";
        const state_cue = cueState[context];

        // cue | state | action
        // 1   | 0     | 1
        // 0   | 1     | 1
        // 1   | 1     | 0
        // 0   | 0     | 0
        if (action_cue ^ state_cue && $MS.meld?.toggleMonitor) $MS.meld.toggleMonitor(track);
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { track, action } = settings;
        if (!track) return;
        if (!session.items[track]) return $SD.setState(context, 1);

        const cued = session.items[track].monitoring;
        cueState[context] = cued;

        const state = cued ? 0 : 1;
        $SD.setState(context, state);
      });
    });
  }
}

const toggleMate = new ToggleMonitor();
