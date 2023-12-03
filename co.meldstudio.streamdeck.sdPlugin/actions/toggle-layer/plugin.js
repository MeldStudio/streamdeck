class ToggleLayer extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.toggle-layer");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { scene, layer } = this.getSettings(context);
      if (!scene || !layer) return;

      if ($MS.meld?.toggleLayer) $MS.meld.toggleLayer(scene, layer);
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { layer } = settings;
        if (!layer) return;
        if (!session?.items || !session?.items[layer])
          return $SD.setState(context, 0);

        const state = session.items[layer].visible ? 1 : 0;
        $SD.setState(context, state);
      });
    });
  }
}

const toggleLayer = new ToggleLayer();
