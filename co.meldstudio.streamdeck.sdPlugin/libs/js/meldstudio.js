// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

const MeldStudioEventEmitter = ELGEvents.eventEmitter()

class MeldStudio {
	on = MeldStudioEventEmitter.on
	emit = MeldStudioEventEmitter.emit

	connected = false
	ready = false

	constructor () {
		this.connected = false
		this.initConnection()
	}

	initConnection () {
		const address = '127.0.0.1'
		const port = 13376

		this.socket = new WebSocket(`ws://${address}:${port}`)

		this.socket.onopen = () => {
			console.log('MeldStudio Connected!')

			this.connected = true
			this.emit('connected')

			this.channel = new QWebChannel(this.socket, channel => {
				this.meld = channel.objects.meld

				this.meld.sessionChanged.connect(() => {
					console.log('Session Changed')
					this.emit('sessionChanged', this.meld.session)
				})

				this.meld.isStreamingChanged.connect(() => {
					console.log('Streaming Changed')
					this.emit('isStreamingChanged', this.meld.isStreaming)
				})

				this.meld.isRecordingChanged.connect(() => {
					console.log('Recording Changed')
					this.emit('isRecordingChanged', this.meld.isRecording)
				})

				this.meld.gainUpdated.connect((trackId, gain, muted) => {
					this.emit('gainChanged', { trackId, gain, muted })
				})

				this.ready = true
				this.emit('ready')
				this.emit('sessionChanged', this.meld.session)
				this.emit('isStreamingChanged', this.meld.isStreaming)
				this.emit('isRecordingChanged', this.meld.isRecording)
			})
		}

		this.socket.onclose = () => {
			this.ready = false
			this.connected = false
			this.meld = {}

			this.emit('closed')

			setTimeout(() => {
				this.initConnection()
			}, 1000)
		}
	}
}

const $MS = new MeldStudio()

class MeldStudioPlugin {
	action
	contexts = {}

	constructor (UUID) {
		this.action = new Action(UUID)

		this.action.onWillAppear(({ context, payload }) => {
			this.contexts[context] = {
				isEncoder: payload.controller == 'Encoder',
				settings: {},
				settingsReady: false
			}
			$SD.getSettings(context)
		})

		this.action.onWillDisappear(({ context }) => {
			delete this.contexts[context]
		})

		this.action.onDidReceiveSettings(({ context, payload }) => {
			if (!this.contexts[context]) return

			const oldSettings = this.getSettings(context)
			this.setSettings(context, payload?.settings ?? {})

			if ($MS.ready) {
				this.hydrateContext(context, 'settings')
			}

			this.onReceivedSettings(context, payload?.settings, oldSettings)
		})

		// Reinitialize every active context on reconnect — $MS.meld is a fresh
		// QWebChannel object, so any prior registrations are gone. One listener
		// per plugin instance; do not register per-settings-delivery.
		$MS.on('ready', () => {
			this.hydrateAll('ready')
		})

		$MS.on('sessionChanged', session => {
			this.onSessionChanged(session)
			this.hydrateAll('sessionChanged', session)
		})
	}

	onReceivedSettings (context, newSettings, oldSettings) {}

	onSessionChanged (session) {}

	onHydrate (context, session, settings, reason) {}

	setSettings (context, settings) {
		this.contexts[context].settings = settings
		this.contexts[context].settingsReady = true
	}

	isEncoder (context) {
		return this.contexts[context].isEncoder
	}

	getSettings (context) {
		return this.contexts[context].settings
	}

	hydrateContext (context, reason, session = $MS.meld?.session) {
		const contextInfo = this.contexts[context]
		if (!contextInfo?.settingsReady) return

		this.onHydrate(context, session, contextInfo.settings, reason)
	}

	hydrateAll (reason, session = $MS.meld?.session) {
		for (const context in this.contexts) {
			this.hydrateContext(context, reason, session)
		}
	}

	updateState (context, state) {
		$SD.setImage(context, state.image, 0)
		$SD.setTitle(context, state.title)
	}

	forAllContexts (fn) {
		for (const context in this.contexts) {
			fn(context, this.getSettings(context))
		}
	}
}
