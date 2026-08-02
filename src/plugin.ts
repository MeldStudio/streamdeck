// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import streamDeck from "@elgato/streamdeck";

import { Clip } from "./actions/clip.js";
import { Media } from "./actions/media.js";
import { Replay } from "./actions/replay.js";
import { Screenshot } from "./actions/screenshot.js";
import { ShowScene } from "./actions/show-scene.js";
import { ToggleEffect } from "./actions/toggle-effect.js";
import { ToggleLayer } from "./actions/toggle-layer.js";
import { ToggleMonitor } from "./actions/toggle-monitor.js";
import { ToggleMute } from "./actions/toggle-mute.js";
import { ToggleRecord } from "./actions/toggle-record.js";
import { ToggleStream } from "./actions/toggle-stream.js";
import { TransitionStepper } from "./actions/transition-stepper.js";
import { VolumeStepper } from "./actions/volume-stepper.js";
import { WidgetControl } from "./actions/widget-control.js";
import { meld } from "./meld/index.js";
import { registerUiBridge } from "./ui-bridge.js";

streamDeck.logger.setLevel("info");

// Register every action. The base class wires each one to the shared Meld
// connection, so hydration and reconnect handling are automatic.
streamDeck.actions.registerAction(new ShowScene());
streamDeck.actions.registerAction(new Screenshot());
streamDeck.actions.registerAction(new Clip());
streamDeck.actions.registerAction(new ToggleMute());
streamDeck.actions.registerAction(new ToggleMonitor());
streamDeck.actions.registerAction(new VolumeStepper());
streamDeck.actions.registerAction(new TransitionStepper());
streamDeck.actions.registerAction(new ToggleLayer());
streamDeck.actions.registerAction(new ToggleEffect());
streamDeck.actions.registerAction(new ToggleRecord());
streamDeck.actions.registerAction(new ToggleStream());
streamDeck.actions.registerAction(new Replay());
streamDeck.actions.registerAction(new Media());
streamDeck.actions.registerAction(new WidgetControl());

// Serve session data to property inspectors from the single Meld connection.
registerUiBridge();

// Connect to the Stream Deck, then open the single connection to Meld Studio.
streamDeck.connect().then(() => meld.connect());
