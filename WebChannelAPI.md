# Meld Studio's WebChannel API Documentation

## Overview

Meld Studio's WebChannel API enables JavaScript clients to interact with various components of Meld Studio. It allows for the management of `scenes`, `audio tracks`, `effects`, and other `session` states, providing an RPC-like link between the web clients and the application's backend.

### Qt's WebChannel Protocol

Meld Studio's WebSocket API is managed by a `QWebChannel` protocol server. This is used to provide a Qt-like API in Javascript, including Qt's concept of `signals` and `slots` (see below for a brief description).

The supported Javascript `QWebChannel` client protocol implementation can be found at [https://packages.streamwithmeld.com/qt6.8/qwebchannel.min.js](<[unminified](https://packages.streamwithmeld.com/qt6.8/qwebchannel.js)>).

See [Qt's Documentation](https://doc.qt.io/qt-6/qtwebchannel-javascript.html) for more details.

#### Signals and Slots

Qt's concept of `signals` and `slots` can be likened to JavaScript's event handling mechanisms but with a few key differences. We've provided a quick description below, but more information can be found in [Qt's Signals and Slots Documentation](https://doc.qt.io/qt-6/signalsandslots.html).

##### Signals

In Qt, a `signal` is akin to an `event` being dispatched in JavaScript. It acts as a notifier that something significant has occurred within the object. For example, if a data model changes, a `signal` might be emitted to indicate this change, similar to firing a custom `event` in JavaScript.

##### Slots

`Slots` in Qt are similar to `event` listeners in JavaScript. They are functions that respond to a specific `signal`. When a `signal` is emitted, all _connected_ `slots` are called automatically. Adding a `slot` is a listener is called _connecting_ to the `signal`. These `connections` last for the lifetime of the objects and can be _disconnected_ when notification is no longer desired.

### Quickstart Code Sample

This code block will get you up and communicating with Meld Studio in a web browser:

```js
function connect() {
  // Currently, Meld Studio will always listen on this address:port.
  // This may be configurable in the future.
  const address = "127.0.0.1";
  const port = 13376;

  var socket = new WebSocket(`ws://${address}:${port}`);

  socket.onopen = function () {
    // Store this somewhere so that it doesn't get GC'd.
    const channel = new QWebChannel(socket, function (channel) {
      // Optionally store `meld` for direct access to the Meld Studio API.
      const meld = channel.objects.meld;

      // -------------------------
      // Example Property Read:
      // This dumps an object containing all Scenes, Layers, Effects, and Audio
      // keyed by ID.

      console.log(meld.session.items);

      // Status properties.

      console.log(meld.isStreaming);
      console.log(meld.isRecording);

      // -------------------------
      // Example Listener:
      // Subscribing to receive notifications when the Session property changes.

      meld.sessionChanged.connect(() => {
        console.log("sessionChanged()");
      });

      // -------------------------
      // Example Call:
      // Will tell Meld Studio to toggle the recording state.

      meld.toggleRecord();
    });
  };

  socket.onclose = function () {
    console.log("Closed");
  };

  socket.onerror = function (error) {
    console.log("Error: ", error);
  };
}
```

## WebChannel Properties, Signals, and Slots

### Properties

| property    | type     | description                                                                                                                                             |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| isStreaming | `bool`   | Indicates active streaming status.                                                                                                                      |
| isRecording | `bool`   | Indicates active recording status.                                                                                                                      |
| session     | `object` | Represents the current session state with a structured JSON object detailing scenes, tracks, layers, and effects. [See Session Schema](#session-schema) |

#### Session Schema

The `session` property is an object with a single key of `items`. `items` is an object that contains all scenes, tracks, layers, and effects in the current Meld Studio session and their relevant properties. Each item is stored in the `items` object by its identifier: `/^[ 0-9A-F ]{ 32 }$/`. These are guaranteed to be unique within a given session.

**Example:**
```json
{
  "items": {
    "1DA03C46454676F85DD8CCB1EF3CBF83": {
      "current": true,
      "index": 0,
      "name": "Playing",
      "staged": false,
      "type": "scene"
    },
    "3B8EFA69F29E81C290B5BD09CC2EA48E": {
      "enabled": true,
      "name": "Corner Pin",
      "parent": "DD8FD6181E7560B45D75B79F005B0299",
      "type": "effect"
    },
    "DD8FD6181E7560B45D75B79F005B0299": {
      "index": 0,
      "name": "Fortnite",
      "parent": "1DA03C46454676F85DD8CCB1EF3CBF83",
      "type": "layer",
      "visible": true
    },
    "F1BA59F85C196B9088A06445BE6E5E20": {
      "monitoring": false,
      "muted": false,
      "name": "Fortnite",
      "parent": "DD8FD6181E7560B45D75B79F005B0299",
      "type": "track"
    },
    "F32F720ACA7B902079E748A33D0113F8": {
      "monitoring": false,
      "muted": false,
      "name": "Track 1",
      "type": "track"
    }
  }
}
```

##### Session Properties

###### Scene:

| property | type     | description                                     |
| -------- | -------- | ----------------------------------------------- |
| type     | `string` | `scene`                                         |
| index    | `int`    | Position of the Scene in the Scene list.        |
| name     | `string` | User specified name of the scene.               |
| current  | `bool`   | Whether the scene is currently being displayed. |
| staged   | `bool`   | Whether the scene is staged to be presented.    |

```json
{
  "current": true,
  "index": 0,
  "name": "Intro",
  "staged": false,
  "type": "scene"
}
```

###### Audio Track:

| property   | type     | description                                                                                                  |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| type       | `string` | `track`                                                                                                      |
| parent     | `string` | `<optional>` Scene Identifier; if not present, the track is a global track.                                  |
| name       | `string` | If `parent` is set, this mirrors the name of the parent `Layer`. If not set, this has the name of the track. |
| monitoring | `bool`   | Whether the track is currently cued.                                                                         |
| muted      | `bool`   | Whether the track is currently muted.                                                                        |

####### Global Track:

```json
{
  "type": "track",
  "name": "Track 1",
  "monitoring": false,
  "muted": false
}
```

####### Layer Track:

```json
{
  "type": "track",
  "parent": "7C64F74757BCADDEF5C2E2F65B467783",
  "name": "Fortnite",
  "monitoring": false,
  "muted": false
}
```

###### Layer:

| property | type     | description                                    |
| -------- | -------- | ---------------------------------------------- |
| type     | `string` | `layer`                                        |
| parent   | `strign` | Reference Identifier for the parent scene.     |
| index    | `int`    | Position of the Layer in the Layer list.       |
| name     | `string` | User specified name of the                     |
| visible  | `bool`   | Whether the layer is currently being rendered. |

```json
{
  "parent": "7C64F74757BCADDEF5C2E2F65B467783",
  "index": 4,
  "name": "Fortnite",
  "type": "layer",
  "visible": true
}
```

###### Effect:

| property | type     | description                              |
| -------- | -------- | ---------------------------------------- |
| type     | `string` | `effect`                                 |
| parent   | `string` | Layer Identifier                         |
| name     | `string` | The effect name.                         |
| enabled  | `bool`   | Whether the effect is currently applied. |

```json
{
  "enabled": true,
  "name": "CCToner",
  "parent": "DECD0C69E669AB0D495F4A466CEA9BDD",
  "type": "effect"
}
```


### Signals

Signals provide methods for registering `listeners`.

```js
// Connect a signal callback.
const ref = meld.signalName.connect((parameter: type) => {
  // Do something with the information.
});

// Disconnect the signal callback.
meld.signalName.disconnect(ref);
```

#### **`gainUpdated(trackId: string, gain: Number, muted: bool)`**

Called by Meld Studio to notify callbacks when the gain or mute status of a track changes.
These are significantly faster than waiting for the session to update and are ideal for real time volume controls.

**Parameters**:

| property | type     | description                     |
| -------- | -------- | ------------------------------- |
| trackid  | `string` | Identifier for the audio track. |
| gain     | `Number` | Current gain level.             |
| muted    | `bool`   | Mute status.                    |

```js
meld.gainUpdated.connect((trackId: string, gain: Number, muted: boolean) => {
  // ... handle callback ...
});
```

#### **`sessionChanged`**

Triggered any time the contents of `session` change.

```js
meld.sessionChanged.connect(() => {
  const session = meld.session.items;
  // ... handle callback ...
});
```

#### **`isStreamingChanged`**

Triggered any time the value of `isStreaming` changes.

```js
meld.isStreamingChanged.connect(() => {
  const isStreaming = meld.isStreaming;
  // ... handle callback ...
});
```

#### **`isRecordingChanged`**

Triggered any time the value of `isRecording` changes.

```js
meld.isRecordingChanged.connect(() => {
  const isRecording = meld.isRecording;
  // ... handle callback ...
});
```

### Functions

These functions can be invoked from JavaScript to interact with Meld Studio.

#### **`showScene(sceneId: string)`**

Switches to the specified scene.

**Parameters**:

| property | type     | description                            |
| -------- | -------- | -------------------------------------- |
| sceneId  | `string` | Scene Identifier of the scene to show. |

```js
const sceneId = /* desired scene id */;
meld.showScene(sceneId);
```

#### **`toggleMute(trackId: string)`**

Toggles mute status of an audio track.

_Side Effects_: This will result in a `session` update (see `sessionChanged`) and possibly a call to `gainUpdated` if the `trackId` has been registered with `registerTrackObserver(...)`.

**Parameters**:

| property | type     | description                            |
| -------- | -------- | -------------------------------------- |
| trackId  | `string` | Track Identifier of the track to mute. |

```js
const trackId = /* desired track id */;
meld.toggleMute(trackId);
```

#### **`toggleMonitor (trackId: string)`**

Toggles monitoring status of an audio track.

_Side Effects_: This will result in a `session` update. See signal `sessionChanged`.

**Parameters**:

| property | type     | description                               |
| -------- | -------- | ----------------------------------------- |
| trackId  | `string` | Track Identifier of the track to monitor. |

```js
const trackId = /* desired track id */;
meld.toggleMonitor(trackId);
```

#### **`toggleLayer(sceneId: string, layerId: string)`**

Toggles visibility of a layer within a scene.

_Side Effects_: This will result in a `session` update. See signal `sessionChanged`.

**Parameters**:

| property | type     | description                                          |
| -------- | -------- | ---------------------------------------------------- |
| sceneId  | `string` | Scene Identifier that contains the layer             |
| layerId  | `string` | Layer Identifier of the desired layer to manipulate. |

```js
const sceneId = /* desired scene id */;
const layerId = /* desired layer id */;
meld.toggleLayer(sceneId, layerId);
```

#### **`toggleEffect(sceneId: string, layerId: string, effectId: string)`**

Toggles the enabled status of an effect within a layer.

_Side Effects_: This will result in a `session` update. See signal `sessionChanged`.

**Parameters**:

| property | type     | description                                           |
| -------- | -------- | ----------------------------------------------------- |
| sceneId  | `string` | Scene Identifier that contains the layer              |
| layerId  | `string` | Layer Identifier that has the effect                  |
| effectId | `string` | Effect Identifier of the desired effect to manipulate |

```js
const sceneId = /* desired scene id */;
const layerId = /* desired layer id */;
const effectId = /* desired effect id */;
meld.toggleEffect(sceneId, layerId, effectId);
```

#### **`toggleRecord()`**

Toggles the recording status.

_Side Effects_: Once streaming starts, the `channel`'s `isRecording` property will update. See signal `isRecordingChanged`.

```js
meld.toggleRecord();
```

#### **`toggleStream()`**

Toggles the streaming status.

_Side Effects_: Once streaming starts, the `channel`'s `isStreaming` property will update. See signal `isStreamingChanged`.

```js
meld.toggleStream();
```

#### **`registerTrackObserver(context: string, trackId: string)`**

Registers an observer for changes to a specific track.

**Parameters**:

| property | type     | description                                                                                                               |
| -------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| context  | `string` | The Identifier associated with the registering context. The same value must be used when calling unregisterTrackObserver. |
| trackId  | `string` | Track Identifier that should be registered for updates.                                                                   |

```js
const trackId = /* desired track id */;
meld.registerTrackObserver("documentation-context", trackId);
```

#### **`unregisterTrackObserver()`**

Unregisters an observer for a specific track.

**Parameters**:

| property | type     | description                                               |
| -------- | -------- | --------------------------------------------------------- |
| context  | `string` | The Identifier associated with the registering context.   |
| trackId  | `string` | Track Identifier that should be unregistered for updates. |

```js
const trackId = /* desired track id */;
meld.unregisterTrackObserver("documentation-context", trackId);
```

#### **`setGain(trackId: string, gain: Number)`**

Adjusts the gain for an audio track.

**Parameters**:

| property | type     | description                                                    |
| -------- | -------- | -------------------------------------------------------------- |
| trackId  | `string` | Track Identifier to modify.                                    |
| gain     | `Number` | The gain to set the specified track to. Range: `0.0` to `1.0`. |

```js
const trackId = /* desired track id */;
meld.setGain(trackId, 0.5);
```

#### **`sendEvent(event: string)`**

Sends a custom event.

**Parameters**:

| property | type     | description               |
| -------- | -------- | ------------------------- |
| event    | `string` | Event to trigger in Meld. |

```js
meld.sendEvent("co.meldstudio.events.screenshot");
```

**Supported Events**:

| event                             | action              |
| --------------------------------- | ------------------- |
| `co.meldstudio.events.screenshot` | Takes a screenshot. |

#### **`setStagedScene(sceneId: string)`**

Prepares a scene for switching without making it live.

**Parameters**:

| property | type     | description                                      |
| -------- | -------- | ------------------------------------------------ |
| sceneId  | `string` | Scene Identifier of the scene to mark as staged. |

```js
const sceneId = /* desired scene id */;
meld.setStagedScene(sceneId);
```

#### **`showStagedScene()`**

Switches to the prepared staged scene.

```js
const sceneId = /* desired scene id */;
meld.setStagedScene(sceneId);

// note: user may change the Staged scene via other means.
meld.showStagedScene();
```