// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

function toDb(gain) {
  let dB = 20 * Math.log10(gain);
  if (!isFinite(dB)) {
    dB = -60;
  }
  return dB;
}

function toGain(dB) {
  if (!isFinite(dB) || dB < -60) dB = -60;
  let gain = Math.pow(10, dB / 20);

  gain = gain <= 0.001 ? 0 : gain;
  gain = gain > 1 ? 1 : gain;
  return gain;
}

class Replay extends MeldStudioPlugin {
  replayState = {}

  setLocalState(context, muted) {
    const state = muted ? 0 : 1;
    $SD.setState(context, state);
  }

  findReplayTrack(session) {
    if (!session?.items) return null;
    
    // Find "Replay Clip" layer(s) in current scene
    const replayLayers = Object.entries(session.items)
      .filter(([, item]) => item.type === "layer" && item.name === "Replay Clip")
      .sort(([a], [b]) => parseInt(a) - parseInt(b)); // Sort by ID (lowest index first)
    
    if (replayLayers.length === 0) return null;
    
    const [replayLayerId] = replayLayers[0];
    
    // Find audio track with parent matching the replay layer
    const replayTrack = Object.entries(session.items)
      .find(([, item]) => item.type === "track" && item.parentId === replayLayerId);
    
    return replayTrack ? {
      layerId: replayLayerId,
      trackId: replayTrack[0],
      trackItem: replayTrack[1]
    } : null;
  }

  replayShow(context, replayInfo) {
    if ($MS.meld?.sendCommand) $MS.meld.sendCommand("meld.replay.show");
  }

  replayDismiss(context, replayInfo) {
    if ($MS.meld?.sendCommand) $MS.meld.sendCommand("meld.replay.dismiss");
  }

  replayToggleMute(context, replayInfo) {
    if (!replayInfo?.trackId) return;
    if ($MS.meld?.toggleMute) $MS.meld.toggleMute(replayInfo.trackId);
  }

  replayMute(context, replayInfo) {
    if (!replayInfo?.trackId) return;
    if ($MS.meld?.setMuted) {
      $MS.meld.setMuted(replayInfo.trackId, true);
      this.setLocalState(context, true);
    }
  }

  replayUnmute(context, replayInfo) {
    if (!replayInfo?.trackId) return;
    if ($MS.meld?.setMuted) {
      $MS.meld.setMuted(replayInfo.trackId, false);
      this.setLocalState(context, false);
    }
  }

  replayVolumeUp(context, replayInfo) {
    if (!replayInfo?.trackId) return;
    const stepsize = 3.0; // 3dB step
    let gain = replayInfo.gain ?? 0.0;
    
    let dB = toDb(gain);
    dB += stepsize;
    gain = toGain(dB);
    
    if ($MS.meld?.setGain) $MS.meld.setGain(replayInfo.trackId, gain);
  }

  replayVolumeDown(context, replayInfo) {
    if (!replayInfo?.trackId) return;
    const stepsize = -3.0; // -3dB step
    let gain = replayInfo.gain ?? 0.0;
    
    let dB = toDb(gain);
    dB += stepsize;
    gain = toGain(dB);
    
    if ($MS.meld?.setGain) $MS.meld.setGain(replayInfo.trackId, gain);
  }

  constructor() {
    super("co.meldstudio.streamdeck.replay");

    const actionHandlers = {
      replay: (context, replayInfo) => this.replayShow(context, replayInfo),
      dismiss: (context, replayInfo) => this.replayDismiss(context, replayInfo),
      toggle: (context, replayInfo) => this.replayToggleMute(context, replayInfo),
      mute: (context, replayInfo) => this.replayMute(context, replayInfo),
      unmute: (context, replayInfo) => this.replayUnmute(context, replayInfo),
      volume_up: (context, replayInfo) => this.replayVolumeUp(context, replayInfo),
      volume_down: (context, replayInfo) => this.replayVolumeDown(context, replayInfo)
    };

    this.action.onKeyUp(({ context }) => {
      const { action: replay_action } = this.getSettings(context);
      const replayInfo = this.replayState[context];
      
      const action = replay_action || "replay";
      const handler = actionHandlers[action];
      
      if (handler) {
        handler(context, replayInfo);
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context) => {
        const replayTrack = this.findReplayTrack(session);
        if (!replayTrack) {
          this.replayState[context] = null;
          return $SD.setState(context, 0);
        }

        const { layerId, trackId, trackItem } = replayTrack;
        this.replayState[context] = {
          layerId,
          trackId,
          muted: trackItem.muted,
          gain: trackItem.gain ?? 0.0
        };

        this.setLocalState(context, trackItem.muted);
      });
    });
  }
}

const replay = new Replay();
