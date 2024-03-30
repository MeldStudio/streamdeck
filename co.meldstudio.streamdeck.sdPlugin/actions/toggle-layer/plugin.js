class ToggleLayer extends MeldStudioPlugin {
  layerState = {};

  setLocalState(context, shown) {
    const state = shown ? 1 : 0;
    $SD.setState(context, state);
  }

  constructor() {
    super("co.meldstudio.streamdeck.toggle-layer");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { scene, layer, action: toggle_action } = this.getSettings(context);
      if (!scene || !layer) return;

      if (!toggle_action || toggle_action === "toggle") {
        if ($MS.meld?.toggleLayer) $MS.meld.toggleLayer(scene, layer);
      } else {
        const action_show = toggle_action === "show";
        const state_show = this.layerState[context];

        // show | state | action
        // 1    | 0     | 1
        // 0    | 1     | 1
        // 1    | 1     | 0
        // 0    | 0     | 0

        const shouldToggle = action_show ^ state_show;
        if (!shouldToggle) this.setLocalState(context, state_show);
        if (shouldToggle && $MS.meld?.toggleLayer)
          $MS.meld.toggleLayer(scene, layer);
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { layer } = settings;
        if (!layer) return;
        if (!session?.items || !session?.items[layer])
          return $SD.setState(context, 0);

        const visible = session.items[layer].visible;
        this.layerState[context] = visible;

        this.setLocalState(context, visible);
      });
    });
  }
}

const toggleLayer = new ToggleLayer();
