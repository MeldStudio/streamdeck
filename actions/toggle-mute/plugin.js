class ToggleMute extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.toggle-mute");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { track } = this.getSettings(context);
      if (!track) return;

      if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { track } = settings;
        if (!track) return;
        if (!session.items[track]) return $SD.setState(context, 1);

        const state = session.items[track].muted ? 0 : 1;
        $SD.setState(context, state);
      });
    });
  }
}

const toggleMate = new ToggleMute();
