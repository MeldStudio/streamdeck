
## Overview

Meld Studio 💙 Stream Deck. Take your stream to new heights with powerful new capabilities at your fingertips. Trigger transitions, manage audio tracks, toggle filter effects on and off, and much more. 

1. **Now you see me, now you don’t**: Things getting weird on the cat-cam? Quickly toggle visibility on any layer.
2. **What the \*\*\*\*\*?** Mute your microphone in a millisecond or precision adjust your audio inputs using the StreamDeck+.
4. **End your 24 hour streamathon with a bang.** Or just press the button to go offline.
5. **Want to post your victorious boss battle (and not the 13 times you died trying)?** Start and stop recordings or take a screenshot with the touch of a button - as many as you want.

And we're not done yet! We are continually working to bring you even more capabilities for this integration, so stay tuned for updates and new features.

## What's New

Version 0.6.4.1
- Refactored the plugin onto Elgato's official Node.js Stream Deck SDK.
- Optimized Meld Studio interactions for all actions.
- Added configurable durations to the Record Clip action. Choose a 10, 15, 30, 60, or 90 second preset, or enter a custom duration from 0 to 90 seconds.
- Improved action state synchronization and recovery after Meld Studio reconnects and session restores.
- Fixed reversed active/inactive icon states on the Cue, Layer Visibility, Effect Visibility, Record, Go Live, and Change Scene actions so third icon packs indicate correctly with Meld Studio actions.

## Helpful Links

https://meldstudio.co/

## Information

Stream Deck 7.1 and later, macOS 12.3 and later.
Languages: English, German

## Support Links

hi@meldstudio.co 


------------
# Change History:
------------

## 2026-08-12 (v0.6.4.1)
### Changes:
-----------
- Refactored the plugin onto Elgato's official Node.js Stream Deck SDK.
- Optimized Meld Studio interactions for all actions.
- Added configurable durations to the Record Clip action. Choose a 10, 15, 30, 60, or 90 second preset, or enter a custom duration from 0 to 90 seconds.
- Improved action state synchronization and recovery after Meld Studio reconnects and session restores.
- Fixed reversed active/inactive icon states on the Cue, Layer Visibility, Effect Visibility, Record, Go Live, and Change Scene actions so third icon packs indicate correctly with Meld Studio actions.


## 2026-05-13 (v0.6.3.2)
### Changes:
-----------
- Fixed a bug in how dials and scene change actions store state.


## 2026-01-22 (v0.6.2.1)
### Changes:
-----------
- Added Mute and Cue controls to the Replay Clip action.


## 2026-01-22 (v0.6.2.0)
### Changes:
-----------
- Added Widget control actions for controlling the counter widget in Meld Studio.


## 2025-12-16 (v0.6.1.0)
### Changes:
-----------
- Added Widget control actions for controlling supported widgets in Meld Studio.


## 2025-09-08 (v0.6.0.0)
### Changes:
-----------
- Added Instant Replay and Media Controls for replaying clips and controlling media layers.
- Use new setMuted method to avoid deprecated setProperty call on "muted" AudioTrack properties.


## 2025-01-30 (v0.5.0.1)
### Changes:
-----------
- Added support for Clip action.
- Fixup for several user reported bugs.


## 2023-12-05 (v0.4.0.0)
### Changes:
-----------
- Added support for switching scenes using a dial to the StreamDeck+.
- Added support for switching volume between percent and dB on the Volume control for StreamDeck+.
- Added support for monitoring an audio track for all StreamDeck devices.
- Added support for setting a specific state to set for Mute, Monitor, Layer, and Effects keys.


## 2023-09-01 (v0.3.0.0)
### Changes:
-----------
- Added support for taking screenshots in MeldStudio with the StreamDeck.


## 2023-05-31 (v0.2.0.0)
### Changes:
-----------
- Added support for volume controls for the StreamDeck+.


## 2023-04-28 (v0.1.0.0)
### Changes:
-----------
- Initial implementation of 6 core features (Scene Selection, Layer Visibility, Effect Visibility, Mute Audio, Stream, and Record).
