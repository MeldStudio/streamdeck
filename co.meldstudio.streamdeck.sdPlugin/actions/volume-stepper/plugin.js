class VolumeStepper extends MeldStudioPlugin {
  trackInfo = {};
  unregisterCallbacks = {};

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

      let gain = +stepsize * payload.ticks + (info?.gain ?? 0.0);
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
      } else {
        // If we lose connection, we may need to reinitialize.
        $MS.on("ready", () => {
          this.onReady(context, payload?.settings);
        });

        this.setGainAndMute(context, {
          gain: 0.0,
          muted: true,
        });
      }
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

    $MS.on("gainChanged", ({ trackId, gain, muted }) => {
      let info = this.trackInfo[trackId];
      info = { ...info, gain, muted };
      this.trackInfo[trackId] = info;

      this.forAllContexts((context, { track }) => {
        if (!track || trackId != track) return;
        this.setGainAndMute(context, info);
      });
    });
  }

  setGainAndMute(context, { gain, muted, name }) {
    // meter colors -
    //   green:   #6DDE92
    //   orange:  #FB923C
    //   red:     #F04A4A

    const info = (() => {
      if (!muted) {
        if (gain > 0.4) return { icon: "assets/iconAudioTrack" };
        if (gain > 0.0) return { icon: "assets/audioUnmuted40" };
      }
      return { icon: "assets/audioMute" };
    })();

    $SD.setFeedback(context, {
      ...info,
      title: name ?? "Adjust Volume",
      value: `${parseInt(gain * 100)}%`,
      indicator: {
        value: gain * 100,
        enabled: true,
        bar_bg_c: muted ? "0:#666666,1:#666666" : "0:#6DDE92,1:#6DDE92",
      },
    });
  }

  register(context, track) {
    console.assert($MS.meld);

    const callbackInfo = this.unregisterCallbacks[context];
    // Only register once.
    if (callbackInfo?.track === track) return;

    this.maybeUnregister(context, track);
    $MS.meld.registerTrackObserver(context, track);

    this.unregisterCallbacks[context] = {
      callback: () => {
        if ($MS.meld) $MS.meld.unregisterTrackObserver(context, track);
      },
      track,
    };
  }

  maybeUnregister(context) {
    const callbackInfo = this.unregisterCallbacks[context];
    if (!callbackInfo) return;

    callbackInfo.callback();
    this.unregisterCallbacks[context] = undefined;
  }

  connectGain(context, track) {
    this.trackInfo[track] = {
      gain: 0.0,
      muted: false,
      name: $MS.meld ? $MS.meld.session.items[track]?.name  : "Adjust Volume"
    };

    this.setGainAndMute(context, this.trackInfo[track]);
    this.register(context, track);

    this.action.onWillDisappear(({ context }) => {
      this.maybeUnregister(context);
    });
  }

  onReady(context, { track }) {
    console.assert($MS.ready);
    if (this.isEncoder(context)) this.connectGain(context, track);
  }
}

const volumeStepper = new VolumeStepper();
