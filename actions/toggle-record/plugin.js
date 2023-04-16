class ToggleRecording extends MeldStudioPlugin {
  constructor() {
    super("co.meldstudio.streamdeck.toggle-record");

    this.action.onKeyUp(({ action, context, device, event, payload }) => {
      if ($MS.meld?.toggleRecord) $MS.meld.toggleRecord();
    });

    $MS.on("isRecordingChanged", (recording) => {
      const state = recording ? 1 : 0;
      this.forAllContexts((context) => {
        $SD.setState(context, state);
      });
    });
  }
}

const toggleRecord = new ToggleRecording();
