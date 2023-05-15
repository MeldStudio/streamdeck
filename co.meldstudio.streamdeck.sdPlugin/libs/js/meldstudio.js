const MeldStudioEventEmitter = ELGEvents.eventEmitter();

class MeldStudio {
	on = MeldStudioEventEmitter.on;
	emit = MeldStudioEventEmitter.emit;

	connected = false;
	ready = false;

	constructor() {
		this.connected = false;
		this.initConnection();
	}

	initConnection() {
		const address = '127.0.0.1';
		const port = 13376;

		this.socket = new WebSocket(`ws://${address}:${port}`);

		this.socket.onopen = () => {
			console.log('MeldStudio Connected!');

			this.connected = true;
			this.emit('connected');

			this.channel = new QWebChannel(this.socket, (channel) => {
				this.meld = channel.objects.meld;

				this.meld.sessionChanged.connect(() => {
					console.log('Session Changed');
					this.emit('sessionChanged', this.meld.session);
				});

				this.meld.isStreamingChanged.connect(() => {
					console.log('Streaming Changed');
					this.emit('isStreamingChanged', this.meld.isStreaming);
				});

				this.meld.isRecordingChanged.connect(() => {
					console.log('Recording Changed');
					this.emit('isRecordingChanged', this.meld.isRecording);
				});

				this.meld.gainUpdated.connect((id, gain) => {
					this.emit('gainChanged', id, gain);
				});

				this.ready = true;
				this.emit('ready');
				this.emit('sessionChanged', this.meld.session);
				this.emit('isStreamingChanged', this.meld.isStreaming);
				this.emit('isRecordingChanged', this.meld.isRecording);
			});
		};

		this.socket.onclose = () => {
			this.ready = false;
			this.connected = false;
			this.meld = {};

			this.emit('closed');

			setTimeout(() => {
				this.initConnection();
			}, 1000);
		};
	}
}

const $MS = new MeldStudio();

class MeldStudioPlugin {
	action;
	contexts = {};

	constructor(UUID) {
		this.action = new Action(UUID);

		this.action.onWillAppear(({ context }) => {
			this.contexts[context] = { settings: {} };
			$SD.getSettings(context);
		});

		this.action.onDidReceiveSettings(({ context, payload }) => {
			this.setSettings(context, payload?.settings ?? {});
		});
	}

	setSettings(context, settings) {
		this.contexts[context].settings = settings;
	}

	getSettings(context) {
		return this.contexts[context].settings;
	}

	updateState(context, state) {
		$SD.setImage(context, state.image, 0);
		$SD.setTitle(context, state.title);
	}

	forAllContexts(fn) {
		for (const context in this.contexts) {
			fn(context, this.getSettings(context));
		}
	}
};
