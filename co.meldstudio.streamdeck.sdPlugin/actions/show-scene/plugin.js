// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class ShowScene extends MeldStudioPlugin {
  sceneRequested = {}
  sceneState = {}

  constructor () {
    super('co.meldstudio.streamdeck.show-scene')

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { scene } = this.getSettings(context)
      if (!scene) return

      this.sceneRequested[context] = scene
      this.setSceneState(context, 1)

      if ($MS.meld?.showScene) $MS.meld.showScene(scene)
    })
  }

  onSessionChanged (session) {
    this.sceneRequested = {}
  }

  onHydrate (context, session, settings, reason) {
    this.updateState(context, session)
  }

  updateState (context, session) {
    const { scene } = this.getSettings(context)

    const state = (() => {
      if (!scene) return 0
      if (!session || !session?.items) return null

      const item = session.items[scene]

      if (!item) return 0
      if (scene == this.sceneRequested[context]) return 1
      return item.current ? 1 : 0
    })()

    if (state === null) return
    this.setSceneState(context, state)
  }

  setSceneState (context, state) {
    if (this.sceneState[context] === state) return

    this.sceneState[context] = state
    $SD.setState(context, state)
  }
}

const showScene = new ShowScene()
