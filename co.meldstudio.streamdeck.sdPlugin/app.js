// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

let settingsCache = {};

/**
 * The first event fired when Stream Deck starts
 */
$SD.onConnected(
  ({ actionInfo, appInfo, connection, messageType, port, uuid }) => {
    console.log("Stream Deck connected!");
  }
);

$MS.on("connected", () => {
  console.log("Connect Callback.");
});

$MS.on("ready", () => {
  console.log("Session Ready.");
});

$MS.on("closed", () => {
  console.log("Closed Callback.");
});