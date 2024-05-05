# Meld Studio - Stream Deck Plugin

To download the current official release, visit our page on the [Elgato marketplace](https://marketplace.elgato.com/product/meld-studio-737415fa-1957-489d-a62e-1becec068b6e).

## Integrations

If you're interested in developing a software intergration with Meld Studio, you can find our API documentation [here](./WebChannelAPI.md). If you have any questions, please join our [discord](https://discord.gg/ZHpeXEw4) and reach out in [`#support`](https://discord.com/channels/1019227275897614337/1019584582913364101).

## Development

We primarily develop on macOS, so these instructions are tailored to macOS. Feel free to submit a PR to update them for Windows if that's your flavor of OS.

1) Check out the repository.
2) Run `scripts/install.sh` (optionally, `--fresh` to remove and reinstall).

   This will update the plugin in `~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/` if it exists.

3) Code away.
4) Run `scripts/install.sh` again to update the install.

   See below for debugging information.

## Debugging:

1. To enable debugging on macOS, run: `defaults write com.elgato.StreamDeck html_remote_debugging_enabled -bool YES` and restart Stream Deck app.
2. Navigation to `http://localhost:23654/` in Chrome.
3. Click on one of the two entries:

![](images/screen-list.png)

* The blue link shows the Property Inspector page and console log.
* The red link shows the CodePath button press page and console.

Which should yield you:

![](images/debug.png)

From here you can refresh the plugin source from the debug console UI.

For more details: https://streamdecklabs.com/debugging-your-javascript-plugin/

## Packaging

Elgato provides a CLI packaging tool. The files are just zip files, but the tool does some validation before packaging it all up.

[https://docs.elgato.com/sdk/plugins/packaging]

```
$ DistributionTool -b -i co.meldstudio.streamdeck.sdPlugin -o ./
```

This outputs a file `co.meldstudio.streamdeck.streamDeckPlugin` which can be installed directly.

### Internal notes:

1) `scripts/build.sh` helper script is provided to generate a versioned plugin file. It will also upload the plugin to the bucket on S3. You must configure your local environment with the correct keys, and you must have the eglato `DistributionTool` in your PATH.
2) Ensure CloudFront cache for the file gets invalidated after uploading to ensure that the elgato crew downloads the correct plugin file.

Publish request should be sent to `maker@elgato.com` with the following information:

* Link: `https://packages.streamwithmeld.com/co.meldstudio.streamdeck.<version>.streamDeckPlugin`
* User:  Meld Studio, Inc.
* Release Notes: _What changed with the new version of your plugin? (features/bug fixes)_
* Support: hi@meldstudio.co
* Category: Video

Include the content from `co.meldstudio.streamdeck.streamDeckPlugin/README.md` in the email including the plugin and plugin 2x icons so that our store entry gets updated with all the desired information.