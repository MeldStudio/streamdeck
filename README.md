# Debugging:

1. Either check this repo out into `~/Library/Application\ Support/com.elgato.StreamDeck/Plugins/` as `co.meldstudio.streamdeck.sdPlugin` or use `rsync -avz`.
2. Run `defaults write com.elgato.StreamDeck html_remote_debugging_enabled -bool YES` and restart Stream Deck software.
3. Navigation to `http://localhost:23654/` in Chrome.
4. Click on one of the two entries:

![](images/screen-list.png)

* The blue link shows the Property Inspector page and console log.
* The red link shows the CodePath button press page and console.

Which should yield you:

![](images/debug.png)

From: https://streamdecklabs.com/debugging-your-javascript-plugin/

# Packaging

Elgato provides a CLI packaging tool. The files are just zipfiles, but the tool does some validation before packaging it all up.

[https://docs.elgato.com/sdk/plugins/packaging]

```
$ DistributionTool -b -i co.meldstudio.streamdeck.sdPlugin -o ./
```

This outputs a file `co.meldstudio.streamdeck.streamDeckPlugin` which is the file we upload to S3 and link with our publish request.
The CloudFront cache for the file should be invalidated after uploading to ensure that the Elgato crew downloads the correct plugin file.

Publish request should be sent to `streamdeck.elgato@corsair.com` with the following information:

* Download: https://packages.streamwithmeld.com/co.meldstudio.streamdeck.streamDeckPlugin
* User:  Meld Studio, Inc.
* Release Notes: _What changed with the new version of your plugin? (features/bug fixes)_
* Support: hi@meldstudio.co
* Category: Video

Include the content from `co.meldstudio.streamdeck.streamDeckPlugin/README.md` in the email including the plugin and plugin 2x icons so that our store entry gets updated with all the desired information. 