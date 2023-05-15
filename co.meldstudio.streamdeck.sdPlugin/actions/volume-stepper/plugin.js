class ToggleMute extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.volume-stepper");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { track } = this.getSettings(context);
      if (!track) return;

      if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
    });

    this.action.onDialRotate(({ action, context, device, event, payload }) => {
      const { track, stepsize: stepString } = this.getSettings(context);
      const stepsize = parseFloat(stepString);

      if (!track) return;

      const newdB = +stepsize * payload.ticks;

      if ($MS.meld?.setVolume) $MS.meld.setVolume(track, newdB);
    });

    this.action.onDialPress(({ action, context, device, event, payload }) => {
      if (!payload.pressed) return;

      const { track } = this.getSettings(context);
      if (!track) return;

      if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
    });

    this.action.onTouchTap(({ action, context, device, event, payload }) => {
      if (payload.hold) return;

      const { tapPos } = payload;
      const { track } = this.getSettings(context);
      if (!track) return;

      // Indicator starts at x=76 and is 108 pixels wide.
      if (tapPos[0] > 80) {
        if (tapPos[0] > 180) return;

        const ratio = (tapPos[0] - 80) / 100;
        const dB = (1 - ratio) * -60;

        if ($MS.meld?.setVolume) $MS.meld.setVolume(track, dB);
      } else {
        if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
      }
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

    $MS.on("gainChanged", (trackId, gain) => {
      this.forAllContexts((context, settings) => {
        const { track } = settings;
        if (!track || trackId != track) return;

        $SD.setState(context, { gain });
      });
    });
  }
}

const toggleMate = new ToggleMute();
