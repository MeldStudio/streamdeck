// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class Media extends MeldStudioPlugin {
  mediaState = {}

  setLocalState (context, isPlaying) {
    const state = isPlaying ? 1 : 0
    $SD.setState(context, state)
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

  mediaPlay (context, mediaInfo) {
    if (!mediaInfo?.layerId) return
    if ($MS.meld?.callFunction) {
      $MS.meld.callFunction(mediaInfo.layerId, 'play')
    }
  }

  mediaPause (context, mediaInfo) {
    if (!mediaInfo?.layerId) return
    if ($MS.meld?.callFunction) {
      $MS.meld.callFunction(mediaInfo.layerId, 'pause')
    }
  }

  mediaRestart (context, mediaInfo) {
    if (!mediaInfo?.layerId) return
    if ($MS.meld?.callFunctionWithArgs) {
      $MS.meld.callFunctionWithArgs(mediaInfo.layerId, 'skipTo', [0])
    }
  }

  mediaToggle (context, mediaInfo) {
    if (!mediaInfo?.layerId) return
    const isPlaying = mediaInfo.layerItem?.isPlaying
    if (isPlaying) {
      this.mediaPause(context, mediaInfo)
    } else {
      this.mediaPlay(context, mediaInfo)
    }
  }

  constructor () {
    super('co.meldstudio.streamdeck.media')

    const actionHandlers = {
      play: (context, mediaInfo) => this.mediaPlay(context, mediaInfo),
      pause: (context, mediaInfo) => this.mediaPause(context, mediaInfo),
      restart: (context, mediaInfo) => this.mediaRestart(context, mediaInfo),
      toggle: (context, mediaInfo) => this.mediaToggle(context, mediaInfo)
    }

    this.action.onKeyUp(({ context }) => {
      const { action: media_action } = this.getSettings(context)
      const mediaInfo = this.mediaState[context]

      const action = media_action || 'toggle'
      const handler = actionHandlers[action]

      if (handler) {
        handler(context, mediaInfo)
      }
    })

  }

  onSessionChanged (session) {
    this.forAllContexts(context => {
      const mediaLayer = this.findMediaLayer(context, session)
      if (!mediaLayer) {
        this.mediaState[context] = null
        return $SD.setState(context, 0)
      }

      const { layerId, layerItem } = mediaLayer
      this.mediaState[context] = {
        layerId,
        layerItem
      }

      this.setLocalState(context, layerItem.isPlaying)
    })
  }
}

const media = new Media()
