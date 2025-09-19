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
  monitoring = false

  setLocalState (context, action) {
    let path

    if (['toggle', 'mute', 'unmute'].includes(action)) {
      const muted = this.replayState?.muted ?? true
      if (action === 'mute') {
        path = 'assets/ReplayMute/replay-clip-muted'
      } else if (action === 'unmute') {
        path = 'assets/ReplayMute/replay-clip-unmuted'
      } else {
        // toggle action shows current state
        path = muted
          ? 'assets/ReplayMute/replay-clip-muted'
          : 'assets/ReplayMute/replay-clip-unmuted'
      }
    } else if (['toggle_cue', 'cue', 'uncue'].includes(action)) {
      const monitoring = this.replayState?.monitoring ?? false
      if (action === 'cue') {
        path = 'assets/ReplayCUE/on'
      } else if (action === 'uncue') {
        path = 'assets/ReplayCUE/off'
      } else {
        // toggle_cue action shows current state
        path = monitoring
          ? 'assets/ReplayCUE/on'
          : 'assets/ReplayCUE/off'
      }
    } else if (action === 'volume_up') {
      path = 'assets/ReplayVolume/replay-clip-volumeUp'
    } else if (action === 'volume_down') {
      path = 'assets/ReplayVolume/replay-clip-volumeDown'
    } else if (action === 'dismiss') {
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
    if (this.replayState?.layerId) return
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
      this.replayState.muted = true
    }
  }

  replayUnmute () {
    if (!this.replayState?.trackId) return
    if ($MS.meld?.setMuted) {
      $MS.meld.setMuted(this.replayState.trackId, false)
      this.replayState.muted = false
    }
  }

  replayToggleCue () {
    if (!this.replayState?.trackId) return
    if ($MS.meld?.toggleMonitor)
      $MS.meld.toggleMonitor(this.replayState.trackId)
  }

  replayCue () {
    if (!this.replayState?.trackId) return
    if ($MS.meld?.setProperty) {
      $MS.meld.setProperty(this.replayState.trackId, 'monitoring', true)
      this.replayState.monitoring = false
    }
  }

  replayUncue () {
    if (!this.replayState?.trackId) return
    if ($MS.meld?.setProperty) {
      $MS.meld.setProperty(this.replayState.trackId, 'monitoring', false)
      this.replayState.monitoring = false
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
      toggle_cue: () => this.replayToggleCue(),
      cue: () => this.replayCue(),
      uncue: () => this.replayUncue(),
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
      this.replayState = {
        muted: true,
        monitoring: false
      }
      return
    }

    const { layerId, trackId, trackItem } = replayTrack
    this.replayState = {
      layerId,
      trackId,
      muted: trackItem.muted,
      monitoring: trackItem.monitoring,
      gain: trackItem.gain ?? 0.0
    }

    this.forAllContexts((context, settings) => {
      this.setLocalState(context, settings.action)
    })
  }
}

const replay = new Replay()
