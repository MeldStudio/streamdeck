#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root regardless of where the script is invoked from.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--fresh" ]]; then
    rm -rf ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/co.meldstudio.streamdeck.sdPlugin
fi

# Build the Node plugin bundle (co.meldstudio.streamdeck.sdPlugin/bin/plugin.js).
if [[ ! -d node_modules ]]; then
    npm install
fi
npm run build

rsync -avz --exclude 'logs' co.meldstudio.streamdeck.sdPlugin ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/
