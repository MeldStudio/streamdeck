// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

class MeldStudioPropertyInspector {
	settings = {}
	callbacks = {}

	createOption (opt) {
		const item = document.createElement('option')

		item.innerHTML = opt.text
		item.value = opt.value
		item.selected = opt.selected

		return item
	}

	// Get all items of a specific type.

	getItemsByType (type, currentValue, parent, keep_filter) {
		const items = $MS.meld?.session?.items ?? {}

		let selectedItems = [
			{
				text: '[No Selection]',
				value: '',
				selected: currentValue == ''
			}
		]

		for (let key in items) {
			const item = items[key]

			if (keep_filter && !keep_filter(type, item)) continue

			if (item.type != type) continue
			if (parent && item.parent != parent) continue

			selectedItems.push({
				text: item.name,
				value: key,
				selected: currentValue == key
			})
		}

		return selectedItems
	}

	getValue (key) {
		return this.settings[key] ?? ''
	}

	// Iterates over the items in the session and filters down
	// each pass to the current type, filtered by the keep_filter function is provided.

	updateSelection (elements, keep_filter) {
		if (!this.callbacks[elements]) {
			this.callbacks[elements] = $MS.on('sessionChanged', session => {
				this.updateSelection(elements)
			})
		}

		if (!$MS.meld) {
			$MS.on('ready', () => {
				this.updateSelection(elements)
			})
			return
		}

		let last = ''
		for (let elid of elements) {
			const value = this.getValue(elid)
			const element = document.getElementById(elid)

			let available = this.getItemsByType(elid, value, last, keep_filter)

			element.innerHTML = ''
			element.disabled = false

			for (let opt of available) {
				element.appendChild(this.createOption(opt))
			}

			last = value
		}
	}

	initializeSelection (action, elements, data_provided = true, keep_filter = null) {
		for (let id of elements) {
			const el = document.getElementById(id)
			console.assert(el.id, 'Select element not found')
			if (!el) continue

			if (this.settings[el.id] === undefined) this.settings[el.id] = ''

			el.onchange = () => {
				if (!this.settings) return
				this.settings = { ...this.settings, [id]: el.value }
				$PI.setSettings(this.settings)
				if (data_provided) this.updateSelection(elements, keep_filter)
			}
		}

		$PI.onDidReceiveSettings(action, ({ action, payload }) => {
			const { settings } = payload
			this.settings = settings

			for (let field of elements) {
				const dom_field = document.getElementById(field)

				if (settings[field] === undefined) continue

				dom_field.value = settings[field]
			}

			if (data_provided) this.updateSelection(elements, keep_filter)
		})

		$PI.getSettings()
	}

	initializeText (action, elements) {
		for (let id of elements) {
			const el = document.getElementById(id)
			console.assert(el.id, 'Input element not found')
			if (!el) continue

			this.settings[el.id] = ''

			el.onchange = () => {
				if (!this.settings) return
				this.settings = { ...this.settings, [id]: el.value }
				$PI.setSettings(this.settings)
			}
		}

		$PI.onDidReceiveSettings(action, ({ action, payload }) => {
			const { settings } = payload
			this.settings = settings

			for (let field of elements) {
				const dom_field = document.getElementById(field)
				if (settings[field] !== undefined) {
					dom_field.value = settings[field]
				} else {
					// Use the default value specified by the field.
					this.settings[field] = dom_field.value
				}
			}
		})
	}

	watchConnections (id) {
		$MS.on('connected', () => {
			document.getElementById(id).style = 'display: none;'
		})

		$MS.on('closed', () => {
			document.getElementById(id).style = ''
		})

		if ($MS.connected) document.getElementById(id).style = 'display: none;'
	}
}

const $MSPI = new MeldStudioPropertyInspector()
