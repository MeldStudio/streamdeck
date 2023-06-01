class MeldStudioPropertyInspector {
	settings = {};

	createOption(opt) {
		const item = document.createElement('option');

		item.innerHTML = opt.text;
		item.value = opt.value;
		item.selected = opt.selected;

		return item;
	}

	// Get all items of a specific type.
	getItemsByType(type, currentValue, parent) {
		const items = $MS.meld?.session?.items ?? {};

		let selectedItems = [
			{
				text: '[No Selection]',
				value: '',
				selected: currentValue == '',
			},
		];

		for (let key in items) {
			const item = items[key];

			if (item.type != type) continue;
			if (parent && item.parent != parent) continue;

			selectedItems.push({
				text: item.name,
				value: key,
				selected: currentValue == key,
			});
		}

		return selectedItems;
	}

	getValue(key) {
		return this.settings[key] ?? '';
	}

	// Iterators over the items in the session and filters down
	// each pass to the current type, filtered by the previous value.
	updateSelection(elements) {
		if (!$MS.meld) {
			$MS.on('ready', () => {
				this.updateSelection(elements);
			});
			$MS.on('sessionChanged', () => {
				this.updateSelection(elements);
			});
			return;
		}

		let last = '';
		for (let elid of elements) {
			const value = this.getValue(elid);
			const element = document.getElementById(elid);

			let available = this.getItemsByType(elid, value, last);

			element.innerHTML = '';
			element.disabled = false;

			for (let opt of available) element.appendChild(this.createOption(opt));

			last = value;
		}
	}

	initializeSelection(action, elements) {
		for (let id of elements) {
			const el = document.getElementById(id);
			console.assert(el.id, 'Select element not found');
			if (!el) continue;

			this.settings[el] = '';

			el.onchange = () => {
				if (!this.settings) return;
				this.settings = { ...this.settings, [id]: el.value };
				$PI.setSettings(this.settings);
				this.updateSelection(elements);
			};
		}

		$PI.onDidReceiveSettings(action, ({ action, payload }) => {
			const { settings } = payload;
			this.settings = settings;

			const suffix = action.split('.').pop();

			for (let field of elements) {
				const dom_field = document.getElementById(field);
				dom_field.value = settings[field];
				if (dom_field.value == 'undefined') dom_field.value = '';
			}

			this.updateSelection(elements);
		});

		$PI.getSettings();
	}

	initializeText(action, elements) {
		for (let id of elements) {
			const el = document.getElementById(id);
			console.assert(el.id, 'Input element not found');
			if (!el) continue;

			this.settings[el] = '';

			el.onchange = () => {
				if (!this.settings) return;
				this.settings = { ...this.settings, [id]: el.value };
				$PI.setSettings(this.settings);
			};
		}

		$PI.onDidReceiveSettings(action, ({ action, payload }) => {
			const { settings } = payload;
			this.settings = settings;

			for (let field of elements) {
				const dom_field = document.getElementById(field);
				if (settings[field] !== undefined) {
					dom_field.value = settings[field];
				} else {
					// Use the default value specified by the field.
					this.settings[field] = dom_field.value;
				}
			}
		});
	}

	watchConnections(id) {
		$MS.on('connected', () => {
			document.getElementById(id).style = 'display: none;';
		});

		$MS.on('closed', () => {
			document.getElementById(id).style = '';
		});

		if ($MS.connected) document.getElementById(id).style = 'display: none;';
	}
}

const $MSPI = new MeldStudioPropertyInspector();
