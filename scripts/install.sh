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

# --delete drops files removed from the repo (e.g. the legacy SDKv2 tree) from
# the installed copy; the 'logs' exclude also protects logs from deletion.
rsync -avz --delete --exclude 'logs' co.meldstudio.streamdeck.sdPlugin ~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/

# The plugin is a long-lived Node process; without a restart the old bundle
# keeps running even though the files on disk were just replaced.
if ! npx streamdeck restart co.meldstudio.streamdeck; then
    echo "Could not restart the plugin automatically; restart Stream Deck to load the update."
fi
