class ShowScene extends MeldStudioPlugin {
  errorState = [
    {
      image: "assets/sceneOn",
      title: "",
    },
  ];

  constructor() {
    super("co.meldstudio.streamdeck.show-scene");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { scene } = this.getSettings(context);
      if (!scene) return;

      if ($MS.meld?.showScene) $MS.meld.showScene(scene);
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { scene } = settings;
        if (!scene) return;

        if (!session.items[scene])
          return $SD.setState(context, 0);

        const state = session.items[scene].current ? 1 : 0;

        $SD.setState(context, state);
      });
    });
  }
}

const showScene = new ShowScene();
