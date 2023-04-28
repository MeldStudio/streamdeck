#!/usr/bin/env bash

if [[ "$1" == "--fresh" ]]; then
    rm -rf ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/co.meldstudio.streamdeck.sdPlugin
fi

rsync -avz co.meldstudio.streamdeck.sdPlugin ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/