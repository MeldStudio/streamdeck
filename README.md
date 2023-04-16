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
