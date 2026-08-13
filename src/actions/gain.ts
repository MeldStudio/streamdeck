// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

/** Lowest represented level, treated as silence. */
export const SILENCE_DB = -60;

/** Converts a linear gain (0..1) to decibels, flooring silence at -60 dB. */
export function toDb(gain: number): number {
	const dB = 20 * Math.log10(gain);
	return isFinite(dB) ? dB : SILENCE_DB;
}

/** Converts decibels back to a linear gain, clamped to 0..1. */
export function toGain(dB: number): number {
	if (!isFinite(dB) || dB < SILENCE_DB) {
		dB = SILENCE_DB;
	}
	let gain = Math.pow(10, dB / 20);
	gain = gain <= 0.001 ? 0 : gain;
	gain = gain > 1 ? 1 : gain;
	return gain;
}
