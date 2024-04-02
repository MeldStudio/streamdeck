#!/usr/bin/env bash


VERSION="$(grep '"Version": "' <co.meldstudio.streamdeck.sdPlugin/manifest.json | sed -n 's/.*: "\(.*\)".*/\1/p')"

DistributionTool -b -i co.meldstudio.streamdeck.sdPlugin -o ./

VERSIONED_NAME=co.meldstudio.streamdeck."$VERSION".streamDeckPlugin
BUCKET_NAME=meld-software-updates

echo "Creating versioned plugin file: ${VERSIONED_NAME}"
mv co.meldstudio.streamdeck.streamDeckPlugin "${VERSIONED_NAME}"

read -rp "CTRL-C if you do not want to upload to S3. Press any key to continue..."

aws s3 cp "${VERSIONED_NAME}" s3://"${BUCKET_NAME}"/"${VERSIONED_NAME}"