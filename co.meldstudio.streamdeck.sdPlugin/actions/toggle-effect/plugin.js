// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class ToggleEffect extends MeldStudioPlugin {
  effectState = {};

  setLocalState(context, shown) {
    const state = shown ? 1 : 0;
    $SD.setState(context, state);
  }

  constructor() {
    super("co.meldstudio.streamdeck.toggle-effect");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      const { scene, layer, effect, action: toggle_action } = this.getSettings(
        context
      );
      if (!scene || !layer || !effect) return;

      if (!toggle_action || toggle_action === "toggle") {
        if ($MS.meld?.toggleEffect) $MS.meld.toggleEffect(scene, layer, effect);
      } else {
        const action_show = toggle_action === "show";
        const state_show = this.effectState[context];

        // show | state | action
        // 1    | 0     | 1
        // 0    | 1     | 1
        // 1    | 1     | 0
        // 0    | 0     | 0

        const shouldToggle = action_show ^ state_show;
        if (!shouldToggle) this.setLocalState(context, state_show);
        if (shouldToggle && $MS.meld?.toggleEffect)
          $MS.meld.toggleEffect(scene, layer, effect);
      }
    });

    $MS.on("sessionChanged", (session) => {
      this.forAllContexts((context, settings) => {
        const { effect } = settings;
        if (!effect) return;
        if (!session.items[effect]) return $SD.setState(context, 0);

        const enabled = session.items[effect].enabled;
        this.effectState[context] = enabled;

        const state = enabled ? 1 : 0;
        $SD.setState(context, state);
      });
    });
  }
}

const toggleEffect = new ToggleEffect();
