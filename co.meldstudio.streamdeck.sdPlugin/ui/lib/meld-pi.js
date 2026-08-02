// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.
//
// Thin property-inspector runtime. Unlike the old inspectors, this NEVER opens a
// connection to Meld Studio — it speaks only the Stream Deck property-inspector
// protocol and asks the plugin for session data. The plugin (the single source
// of truth) answers and pushes live updates, so dropdowns stay in sync with the
// keys without a second, drifting connection.

(function () {
	let ws;
	let uuid;
	let actionInfo = {};
	let currentSettings = {};
	let session = { items: {}, connected: false };

	const settingsListeners = [];
	const sessionListeners = [];
	const readyListeners = [];

	/** Entry point invoked by the Stream Deck application. */
	function connectElgatoStreamDeckSocket(inPort, inUUID, inRegisterEvent, _inInfo, inActionInfo) {
		uuid = inUUID;
		try {
			actionInfo = inActionInfo ? JSON.parse(inActionInfo) : {};
		} catch {
			actionInfo = {};
		}
		currentSettings = (actionInfo && actionInfo.payload && actionInfo.payload.settings) || {};

		ws = new WebSocket("ws://127.0.0.1:" + inPort);

		ws.onopen = function () {
			ws.send(JSON.stringify({ event: inRegisterEvent, uuid: inUUID }));
			readyListeners.forEach((fn) => fn());
			MeldPI.requestSession();
		};

		ws.onmessage = function (event) {
			let msg;
			try {
				msg = JSON.parse(event.data);
			} catch {
				return;
			}

			if (msg.event === "didReceiveSettings") {
				currentSettings = (msg.payload && msg.payload.settings) || {};
				settingsListeners.forEach((fn) => fn(currentSettings));
			} else if (msg.event === "sendToPropertyInspector") {
				const payload = msg.payload || {};
				if (payload.event === "meld.session") {
					session = { items: payload.items || {}, connected: !!payload.connected };
					sessionListeners.forEach((fn) => fn(session));
				}
			}
		};
	}

	/** Builds an `<option>` element. */
	function option(text, value, selected) {
		const el = document.createElement("option");
		el.textContent = text;
		el.value = value;
		if (selected) {
			el.selected = true;
		}
		return el;
	}

	/** Collects session items of a type, optionally filtered by parent / predicate. */
	function itemsByType(items, type, parent, keepFilter) {
		const result = [];
		for (const id of Object.keys(items)) {
			const item = items[id];
			if (keepFilter && !keepFilter(type, item)) {
				continue;
			}
			if (item.type !== type) {
				continue;
			}
			if (parent && item.parent !== parent) {
				continue;
			}
			result.push({ id, name: item.name });
		}
		return result;
	}

	const MeldPI = {
		/** The action's manifest UUID. */
		get actionUUID() {
			return actionInfo.action;
		},

		/** Registers a callback for when the socket is connected. */
		onReady(fn) {
			readyListeners.push(fn);
		},

		/** The current, in-memory settings object. */
		getSettings() {
			return currentSettings;
		},

		/** Persists settings to Stream Deck. */
		setSettings(settings) {
			currentSettings = settings;
			if (ws) {
				ws.send(JSON.stringify({ event: "setSettings", context: uuid, payload: settings }));
			}
		},

		/** Merges a partial update into settings and persists it. */
		patchSettings(patch) {
			this.setSettings(Object.assign({}, currentSettings, patch));
		},

		/** Registers a callback for `didReceiveSettings`. */
		onDidReceiveSettings(fn) {
			settingsListeners.push(fn);
		},

		/** Requests a fresh session snapshot from the plugin. */
		requestSession() {
			this.sendToPlugin({ event: "meld.getSession" });
		},

		/** Registers a callback for session snapshots (fires immediately if known). */
		onSession(fn) {
			sessionListeners.push(fn);
			fn(session);
		},

		/** Sends an arbitrary payload to the plugin. */
		sendToPlugin(payload) {
			if (ws) {
				ws.send(JSON.stringify({ event: "sendToPlugin", context: uuid, action: actionInfo.action, payload }));
			}
		},

		/** Opens a URL in the user's browser via Stream Deck. */
		openUrl(url) {
			if (ws) {
				ws.send(JSON.stringify({ event: "openUrl", payload: { url } }));
			}
		},

		/**
		 * Binds a chain of session-driven `<select>` elements whose ids match item
		 * types (`scene`, `layer`, `effect`, `track`). Each select after the first is
		 * filtered to children of the previous select's value.
		 * @param {string[]} ids Ordered element ids (also used as item types).
		 * @param {(type:string,item:object)=>boolean} [keepFilter] Optional predicate.
		 */
		bindSessionSelects(ids, keepFilter) {
			const rebuild = () => {
				let parent = "";
				for (const id of ids) {
					const el = document.getElementById(id);
					if (!el) {
						continue;
					}
					const current = currentSettings[id] || "";
					el.innerHTML = "";
					el.disabled = false;
					el.appendChild(option("[No Selection]", "", current === ""));
					for (const item of itemsByType(session.items, id, parent, keepFilter)) {
						el.appendChild(option(item.name, item.id, item.id === current));
					}
					el.value = current;
					parent = current;
				}
			};

			ids.forEach((id) => {
				const el = document.getElementById(id);
				if (!el) {
					return;
				}
				el.addEventListener("change", () => {
					MeldPI.patchSettings({ [id]: el.value });
					rebuild();
				});
			});

			this.onDidReceiveSettings(rebuild);
			this.onSession(rebuild);
			rebuild();
		},

		/**
		 * Binds a static `<select>` / `<input>` whose value persists to settings.
		 * @param {string} id Element id (and settings key).
		 * @param {string} [fallback] Default value when no setting is present.
		 */
		bindField(id, fallback) {
			const el = document.getElementById(id);
			if (!el) {
				return;
			}
			const apply = () => {
				const value = currentSettings[id];
				if (value !== undefined && value !== null) {
					el.value = value;
				} else if (fallback !== undefined) {
					el.value = fallback;
					currentSettings = Object.assign({}, currentSettings, { [id]: fallback });
				}
			};
			el.addEventListener("change", () => {
				MeldPI.patchSettings({ [id]: el.value });
			});
			this.onDidReceiveSettings(apply);
			apply();
		},

		/**
		 * Shows/hides a "Connecting to Meld Studio..." element based on the plugin's
		 * connection status.
		 * @param {string} loadingId Element id of the connecting indicator.
		 */
		watchConnection(loadingId) {
			const el = document.getElementById(loadingId);
			if (!el) {
				return;
			}
			this.onSession((s) => {
				el.style.display = s.connected ? "none" : "";
			});
		},
	};

	window.connectElgatoStreamDeckSocket = connectElgatoStreamDeckSocket;
	window.MeldPI = MeldPI;
})();
