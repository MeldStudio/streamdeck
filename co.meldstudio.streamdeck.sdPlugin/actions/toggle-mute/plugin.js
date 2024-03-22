class ToggleMute extends MeldStudioPlugin {
  muteState = {}

  constructor() {
    super("co.meldstudio.streamdeck.toggle-mute");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { track, action: toggle_action } = this.getSettings(context);
      if (!track) return;

      if (toggle_action === "toggle") {
        if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
      } else {
        // maybe mute
        const action_mute = toggle_action === "mute";
        const state_mute = this.muteState[context];

        // mute | state | action
        // 1    | 0     | 1
        // 0    | 1     | 1
        // 1    | 1     | 0
        // 0    | 0     | 0
        if (action_mute ^ state_mute && $MS.meld?.toggleMute) $MS.meld.toggleMute(track);
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { track, action } = settings;
        if (!track) return;
        if (!session.items[track]) return $SD.setState(context, 1);

        const muted = session.items[track].muted;
        this.muteState[context] = muted;

        const state = muted ? 0 : 1;
        $SD.setState(context, state);
      });
    });
  }
}

const toggleMate = new ToggleMute();
