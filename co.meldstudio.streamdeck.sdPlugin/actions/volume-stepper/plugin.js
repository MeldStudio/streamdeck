function toDb(gain) {
  let dB = 20. * Math.log10(gain);
  if (!isFinite(dB)) {
    dB = -60.;
  }
  return dB;
}

function toGain(dB) {
  if (!isFinite(dB) || dB < -60.) dB = -60.;
  let gain = Math.pow(10., dB / 20.);
  
  gain = gain <= 0.001 ? 0 : gain;
  gain = gain > 1 ? 1 : gain;
  return gain;
}


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
      const { track, stepsize: stepString, metertype } = this.getSettings(context);
      let use_percent = (metertype === "percent");

      const stepsize = parseFloat(stepString);
      const info = this.trackInfo[track];

      if (!track) return;

      let offset = +stepsize * payload.ticks
      let gain = (info?.gain ?? 0.0);

      if (use_percent) {
        gain += 0.01 * offset; // scale to percent...
      } else {
        let dB = toDb(gain);
        dB += offset;
        gain = toGain(dB);
      }

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
        if ($MS.meld?.toggleMonitor) $MS.meld.toggleMonitor(track);
      }
    });

    this.action.onWillAppear(({context, payload}) => {
      $SD.setFeedback(context, {
        icon: "assets/Audio Track/Mute_Unmute Audio Track/Action Icons/audioTrack",
        title: "",
        value: "",
        indicator: {
          value: 0,
          enabled: true,
          bar_bg_c: "0:#666666,1:#666666",
        },
      });
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

        this.setGainAndMute(context, payload.settings.metertype, {
          gain: 0.0,
          muted: true,
          monitoring: false,
        });
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, { track, metertype }) => {
        if (!track) return;
        if (!session?.items) return;
        if (!session?.items[track]) return;

        const { name, muted, monitoring } = session.items[track];

        this.trackInfo[track] = { ...this.trackInfo[track], name, muted, monitoring };

        this.setGainAndMute(context, metertype, this.trackInfo[track]);
      });
    });

    $MS.on("gainChanged", ({ trackId, gain, muted }) => {
      let info = this.trackInfo[trackId];
      info = { ...info, gain, muted };
      this.trackInfo[trackId] = info;

      this.forAllContexts((context, { track, metertype }) => {
        if (!track || trackId != track) return;
        this.setGainAndMute(context, metertype, info);
      });
    });

    $MS.on("closed", () => {
      // reset all registrations.
      this.unregisterCallbacks = {};
    });
  }

  setGainAndMute(context, metertype, { gain, muted, name, monitoring }) {
    // meter colors -
    //   green:   #6DDE92
    //   orange:  #FB923C
    //   red:     #F04A4A
    
    let use_percent = (metertype === "percent");
    let volume;
    let bar_colors;
    let bar_value;
    
    if (use_percent) {
      volume = `${parseInt(gain * 100)}%`;
      bar_value = gain * 100;
    } else {
      const dB = toDb(gain);
      volume = (dB === -60.) ? "-∞ dB" : `${parseInt(dB)} dB`;
      bar_value = (dB + 60.) / 60.;
    }

    const info = (() => {
      if (!muted) {
        if (gain > 0.4) return { icon: "assets/Audio Track/Mute_Unmute Audio Track/Action Icons/audioTrack" };
        if (gain > 0.0) return { icon: "assets/Audio Track/Mute_Unmute Audio Track/Action Icons/audioUnmuted40" };
      }
      return { icon: "assets/Audio Track/Mute_Unmute Audio Track/Action Icons/audioMute" };
    })();

    $SD.setFeedback(context, {
      ...info,
      title: name ?? "Adjust Volume",
      value: volume,
      indicator: {
        value: bar_value * 100.,
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

  getNameForTrack(track) {
    const defaultName = "Adjust Volume";
    if (!$MS?.meld?.session?.items) return defaultName;

    const name = $MS.meld.session.items[track]?.name;
    return name ? name : defaultName;
  }

  connectGain(context, metertype, track) {
    this.trackInfo[track] = {
      gain: 0.0,
      muted: false,
      name: this.getNameForTrack(track),
    };

    this.setGainAndMute(context, metertype, this.trackInfo[track]);
    this.register(context, track);

    this.action.onWillDisappear(({ context }) => {
      this.maybeUnregister(context);
    });
  }

  onReady(context, { track, metertype }) {
    console.assert($MS.ready);
    if (this.isEncoder(context)) this.connectGain(context, metertype, track);
  }
}

const volumeStepper = new VolumeStepper();
