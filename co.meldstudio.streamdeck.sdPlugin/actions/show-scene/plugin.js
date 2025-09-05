// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class ShowScene extends MeldStudioPlugin {
  sceneRequested = null

  constructor () {
    super('co.meldstudio.streamdeck.show-scene')

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { scene } = this.getSettings(context)
      console.log('Show scene', scene)
      if (!scene) return

      this.sceneRequested = scene
      this.updateState(context)

      if ($MS.meld?.showScene) $MS.meld.showScene(scene)
    })
  }

  onSessionChanged (session) {
    this.sceneRequested = null

    this.forAllContexts((context, settings) => {
      this.updateState(context)
    })
  }

  updateState (context) {
    const { scene } = this.getSettings(context)
    const session = $MS?.meld?.session

    const state = (() => {
      if (!scene) return 0
      if (!session || !session?.items) return 0

      const item = session.items[scene]

      if (!item) return 0
      if (scene == this.sceneRequested) return 1
      return item.current ? 1 : 0
    })()

    $SD.setState(context, state)
  }
}

const showScene = new ShowScene()
