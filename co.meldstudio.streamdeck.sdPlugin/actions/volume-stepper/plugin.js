class VolumeStepper extends MeldStudioPlugin {
  trackInfo = {};

  constructor() {
    super("co.meldstudio.streamdeck.volume-stepper");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { track } = this.getSettings(context);
      if (!track) return;

      if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
    });

    this.action.onDialRotate(({ context, payload }) => {
      const { track, stepsize: stepString } = this.getSettings(context);
      const stepsize = 0.01 * parseFloat(stepString);
      const info = this.trackInfo[track];

      if (!track) return;

      let gain = +stepsize * payload.ticks + info.gain;
      gain = gain < 0 ? 0 : gain;
      gain = gain > 1 ? 1 : gain;

      // Store the new gain until the callback fires.
      this.trackInfo[track] = { ...info, gain };

      if ($MS.meld?.setGain) $MS.meld?.setGain(track, gain);
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

        const info = this.trackInfo[track];
        const gain = (tapPos[0] - 80) / 100;

        // Store the new gain until the callback fires.
        this.trackInfo[track] = { ...info, gain };

        if ($MS.meld?.setGain) $MS.meld?.setGain(track, gain);
      } else {
        if ($MS.meld?.toggleMute) $MS.meld.toggleMute(track);
      }
    });

    this.action.onDidReceiveSettings(({ context, payload }) => {
      this.setSettings(context, payload?.settings ?? {});

      if ($MS.ready) {
        this.onReady(context, payload?.settings);
      }

      // If we lose connection, we may need to reinitialize.
      $MS.on("ready", () => {
        this.onReady(context, payload?.settings);
      });
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, { track }) => {
        if (!track) return;
        if (!session.items[track]) return $SD.setState(context, 1);

        const { name, muted } = session.items[track];
        const state = muted ? 0 : 1;

        this.trackInfo[track] = { ...this.trackInfo[track], name, muted };

        $SD.setState(context, state);
      });
    });

    $MS.on("gainChanged", (trackId, gain, muted) => {
      this.forAllContexts((context, { track }) => {
        if (!track || trackId != track) return;

        let info = this.trackInfo[track];
        info = { ...info, gain, muted };

        this.setGainAndMute(context, info);
        this.trackInfo[track] = info;
      });
    });
  }

  setGainAndMute(context, { gain, muted, name }) {
    $SD.setFeedback(context, {
      title: name ?? "Adjust Volume",
      icon: muted ? "assets/audioMute.svg" : "assets/iconAudioTrack.svg",
      value: `${parseInt(gain * 100)}%`,
      indicator: { value: gain * 100, enabled: true },
    });
  }

  connectGain(context, track) {
    this.trackInfo[track] = { gain: 0.0, muted: false, name: "Adjust Volume" };
    $MS.meld.registerTrackObserver(context, track);

    $MS.meld.gainUpdated.connect((track, gain, muted) => {
      const info = this.trackInfo[track];
      this.trackInfo[track] = { ...info, gain, muted };

      this.setGainAndMute(context, this.trackInfo[track]);
    });

    this.action.onWillDisappear(() => {
      $MS.meld.unregisterTrackObserver(context, track);
    });
  }

  onReady(context, { track }) {
    console.assert($MS.ready);
    if (this.isEncoder(context)) this.connectGain(context, track);
  }
}

const volumeStepper = new VolumeStepper();
