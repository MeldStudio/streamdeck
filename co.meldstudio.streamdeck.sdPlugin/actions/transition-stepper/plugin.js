class TransitionStepper extends MeldStudioPlugin {
  stagedScene = -1;
  availableScenes = [];

  constructor() {
    super("co.meldstudio.streamdeck.transition-stepper");

    this.action.onDialRotate(({ context, payload }) => {
      if (this.availableScenes.length === 0)
        return;

      const nextScene = () => {
        this.stagedScene = (this.stagedScene + payload.ticks) % this.availableScenes.length;
        if (this.stagedScene < 0) this.stagedScene += this.availableScenes.length;
        return this.availableScenes[this.stagedScene];
      };

      let item = nextScene();
      if (!item)
        item = nextScene();

      if ($MS.meld?.setStagedScene) $MS.meld?.setStagedScene(item.id);
    });

    this.action.onDialPress(({ action, context, device, event, payload }) => {
      if (!payload.pressed) return;
      if (this.stagedScene === -1) return;
      if ($MS.meld?.showStagedScene) $MS.meld.showStagedScene();
    });

    this.action.onTouchTap(({ action, context, device, event, payload }) => {
      if (!payload.hold) return;
      if (this.stagedScene === -1) return;
      if ($MS.meld?.showStagedScene) $MS.meld.showStagedScene();
    });

    $MS.on("sessionChanged", (session) => {
      this.availableScenes = [];

      for(let key in session?.items) {
        const item = session?.items[key];

        if (item?.type !== "scene") continue;

        if (item?.staged)
          this.stagedScene = item.index;

        if (!item?.current)
          this.availableScenes[item.index] = { name: item.name, id: key };
      }

      if (this.stagedScene !== -1) {
        const item = this.availableScenes[this.stagedScene];
        this.forAllContexts((context) => this.setSceneName(context, item?.name));
      }
    });
  }

  setSceneName(context, name) {
    $SD.setFeedback(context, {
      icon: "assets/audioUnmuted40",
      title: name ?? "Nothing Staged",
    });
  }

  getNameForScene(sceneId) {
    const defaultName = "No Selection";
    if (!$MS?.meld?.session?.items) return defaultName;

    const name = $MS.meld.session.items[sceneId]?.name;
    return name ? name : defaultName;
  }
}

const transitionStepper = new TransitionStepper();
