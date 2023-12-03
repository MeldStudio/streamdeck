class ToggleEffect extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.toggle-effect");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { scene, layer, effect } = this.getSettings(context);
      if (!scene || !layer || !effect) return;

      if ($MS.meld?.toggleLayer) $MS.meld.toggleEffect(scene, layer, effect);
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { effect } = settings;
        if (!effect) return;
        if (!session.items[effect]) return $SD.setState(context, 0);

        const state = session.items[effect].enabled ? 1 : 0;
        $SD.setState(context, state);
      });
    });
  }
}

const toggleEffect = new ToggleEffect();
