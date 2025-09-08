// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

function toDb (gain) {
  let dB = 20 * Math.log10(gain)
  if (!isFinite(dB)) {
    dB = -60
  }
  return dB
}

function toGain (dB) {
  if (!isFinite(dB) || dB < -60) dB = -60
  let gain = Math.pow(10, dB / 20)

  gain = gain <= 0.001 ? 0 : gain
  gain = gain > 1 ? 1 : gain
  return gain
}

class Replay extends MeldStudioPlugin {
  replayState = {}
  muted = true

  setLocalState (context, action) {
    let path;
    if (action === 'dismiss') {
      path = 'assets/Replay/Key Icon/dismiss-clip-controls'
    } else {
      path = 'assets/Replay/Key Icon/replay-clip-controls'
    }

    $SD.setImage(context, path, 0)
  }

  findReplayTrack (session) {
    if (!session?.items) return null

    // Convert items object to array with id property
    const replayTracks = Object.entries(session.items)
      .filter(
        ([, item]) => item.name === 'Replay Clip' && item.type === 'track'
      )
      .map(([id, item]) => ({
        id,
        ...item
      }))

    if (replayTracks.length === 0) return null

    const replayTrack = replayTracks[0]

    return replayTrack
      ? {
          layerId: replayTrack.parent,
          trackId: replayTrack.id,
          trackItem: replayTrack
        }
      : null
  }

  replayShow () {
    if (this.replayState) return
    if ($MS.meld?.sendCommand) $MS.meld.sendCommand('meld.replay.show')
  }

  replayDismiss () {
    if ($MS.meld?.sendCommand) $MS.meld.sendCommand('meld.replay.dismiss')
  }

  replayToggleMute () {
    if (!this.replayState?.trackId) return
    if ($MS.meld?.toggleMute) $MS.meld.toggleMute(this.replayState.trackId)
  }

  replayMute () {
    if (!this.replayState?.trackId) return
    if ($MS.meld?.setMuted) {
      $MS.meld.setMuted(this.replayState.trackId, true)
      this.muted = true
    }
  }

  replayUnmute () {
    if (!this.replayState?.trackId) return
    if ($MS.meld?.setMuted) {
      $MS.meld.setMuted(this.replayState.trackId, false)
      this.muted = false
    }
  }

  replayVolumeUp () {
    if (!this.replayState?.trackId) return
    const stepsize = 3.0 // 3dB step
    let gain = this.replayState.gain ?? 0.0

    let dB = toDb(gain)
    dB += stepsize
    gain = toGain(dB)

    if ($MS.meld?.setGain) $MS.meld.setGain(this.replayState.trackId, gain)
  }

  replayVolumeDown () {
    if (!this.replayState?.trackId) return
    const stepsize = -3.0 // -3dB step
    let gain = this.replayState.gain ?? 0.0

    let dB = toDb(gain)
    dB += stepsize
    gain = toGain(dB)

    if ($MS.meld?.setGain) $MS.meld.setGain(this.replayState.trackId, gain)
  }

  constructor () {
    super('co.meldstudio.streamdeck.replay')

    const actionHandlers = {
      replay: () => this.replayShow(),
      dismiss: () => this.replayDismiss(),
      toggle: () => this.replayToggleMute(),
      mute: () => this.replayMute(),
      unmute: () => this.replayUnmute(),
      volume_up: () => this.replayVolumeUp(),
      volume_down: () => this.replayVolumeDown()
    }

    this.action.onKeyUp(({ context }) => {
      const { action: replay_action } = this.getSettings(context)

      const action = replay_action || 'replay'
      const handler = actionHandlers[action]

      if (handler) handler()
    })
  }

  onReceivedSettings (context, newSettings, oldSettings) {
    const { action: replay_action } = newSettings
    this.setLocalState(context, replay_action)
  }

  onSessionChanged (session) {
    const replayTrack = this.findReplayTrack(session)
    if (!replayTrack) {
      this.replayState = null
      this.muted = true
      return
    }

    const { layerId, trackId, trackItem } = replayTrack
    this.replayState = {
      layerId,
      trackId,
      muted: trackItem.muted,
      gain: trackItem.gain ?? 0.0
    }
  }
}

const replay = new Replay()
