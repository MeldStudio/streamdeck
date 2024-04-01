#!/usr/bin/env bash


VERSION="$(grep '"Version": "' <co.meldstudio.streamdeck.sdPlugin/manifest.json | sed -n 's/.*: "\(.*\)".*/\1/p')"

DistributionTool -b -i co.meldstudio.streamdeck.sdPlugin -o ./

echo "Creating versioned plugin file: co.meldstudio.streamdeck.$VERSION.streamDeckPlugin"
mv co.meldstudio.streamdeck.streamDeckPlugin co.meldstudio.streamdeck."$VERSION".streamDeckPlugin