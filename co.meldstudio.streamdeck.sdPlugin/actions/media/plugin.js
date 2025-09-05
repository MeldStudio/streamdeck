// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class Media extends MeldStudioPlugin {
  mediaState = {}

  setLocalState (context, action, isPlaying) {
    let path = isPlaying
      ? 'assets/Media/Key Icon/media-controls-pause'
      : 'assets/Media/Key Icon/media-controls-play'

    if (action === 'restart') {
      path = 'assets/Media/Key Icon/media-controls-skip-back'
    } else if (action === 'play') {
      path = 'assets/Media/Key Icon/media-controls-play'
    } else if (action === 'pause') {
      path = 'assets/Media/Key Icon/media-controls-pause'
    }

    console.log(context, path, 0)
    $SD.setImage(context, path, 0)
  }

  findMediaLayer (context, session) {
    if (!session?.items) return null

    const settings = this.getSettings(context)
    const { scene: sceneId, layer: layerId } = settings

    // If no scene/layer selected, return null
    if (!sceneId || !layerId) return null

    const layerItem = session.items[layerId]

    // Verify the layer exists, belongs to the selected scene, and has mediaSource
    if (
      !layerItem ||
      layerItem.type !== 'layer' ||
      layerItem.parent !== sceneId ||
      !layerItem.mediaSource
    ) {
      return null
    }

    return {
      layerId,
      layerItem
    }
  }

  mediaPlay (context, mediaAction, mediaInfo) {
    this.setLocalState(context, mediaAction, true)
    if (!mediaInfo?.layerId) return
    if ($MS.meld?.callFunction) {
      $MS.meld.callFunction(mediaInfo.layerId, 'play')
    }
  }

  mediaPause (context, mediaAction, mediaInfo) {
    this.setLocalState(context, mediaAction, false)
    if (!mediaInfo?.layerId) return
    if ($MS.meld?.callFunction) {
      $MS.meld.callFunction(mediaInfo.layerId, 'pause')
    }
  }

  mediaRestart (context, mediaAction, mediaInfo) {
    this.setLocalState(context, mediaAction, false)
    if (!mediaInfo?.layerId) return
    if ($MS.meld?.callFunctionWithArgs) {
      $MS.meld.callFunctionWithArgs(mediaInfo.layerId, 'seekTo', [0])
    }
  }

  mediaToggle (context, mediaAction, mediaInfo) {
    if (!mediaInfo?.layerId) return
    const isPlaying = mediaInfo.layerItem?.isPlaying
    if (isPlaying) {
      this.mediaPause(context, mediaAction, mediaInfo)
    } else {
      this.mediaPlay(context, mediaAction, mediaInfo)
    }
  }

  constructor () {
    super('co.meldstudio.streamdeck.media')

    const actionHandlers = {
      play: (context, mediaAction, mediaInfo) =>
        this.mediaPlay(context, mediaAction, mediaInfo),
      pause: (context, mediaAction, mediaInfo) =>
        this.mediaPause(context, mediaAction, mediaInfo),
      restart: (context, mediaAction, mediaInfo) =>
        this.mediaRestart(context, mediaAction, mediaInfo),
      toggle: (context, mediaAction, mediaInfo) =>
        this.mediaToggle(context, mediaAction, mediaInfo)
    }

    this.action.onKeyUp(({ context }) => {
      const { action: mediaAction } = this.getSettings(context)
      const mediaInfo = this.mediaState[context]

      const action = mediaAction || 'toggle'
      const handler = actionHandlers[action]
      if (handler) {
        handler(context, mediaAction, mediaInfo)
      }
    })

    this.action.onKeyDown(() => {})
  }

  onSessionChanged (session) {
    this.forAllContexts(context => {
      const mediaLayer = this.findMediaLayer(context, session)
      const { action: mediaAction } = this.getSettings(context)

      if (!mediaLayer) {
        this.mediaState[context] = null
        return this.setLocalState(context, mediaAction, false)
      }

      const { layerId, layerItem } = mediaLayer
      this.mediaState[context] = {
        layerId,
        layerItem
      }

      this.setLocalState(context, mediaAction, layerItem.isPlaying)
    })
  }

  onReceivedSettings (context, newSettings, oldSettings) {
    const { action: mediaAction } = newSettings
    if (mediaAction !== oldSettings.action) {
      this.setLocalState(
        context,
        mediaAction,
        this.mediaState[context]?.layerItem?.isPlaying ?? false
      )
    }
  }
}

const media = new Media()
