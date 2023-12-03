class ToggleMute extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.toggle-mute");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { track, action: mute_action } = this.getSettings(context);
      if (!track) return;

      if (mute_action !== "monitor") {
        if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
      } else {
        if ($MS.meld?.toggleMonitor) $MS.meld.toggleMonitor(track);
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { track, action } = settings;
        if (!track) return;
        if (!session.items[track]) return $SD.setState(context, 1);

        if (action !== "monitor") {
          const state = session.items[track].muted ? 0 : 1;
          $SD.setState(context, state);
        } else {
          const state = session.items[track].monitoring ? 3 : 2;
          $SD.setState(context, state);
        }
      });
    });
  }
}

const toggleMate = new ToggleMute();
