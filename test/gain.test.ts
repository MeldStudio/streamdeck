// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert from "node:assert/strict";
import { test } from "node:test";

import { SILENCE_DB, toDb, toGain } from "../src/actions/gain.ts";

test("toDb floors zero gain at silence", () => {
	assert.equal(toDb(0), SILENCE_DB);
});

test("toDb of unity gain is 0 dB", () => {
	assert.equal(toDb(1), 0);
});

test("toGain clamps to the 0..1 range", () => {
	assert.equal(toGain(6), 1);
	assert.equal(toGain(SILENCE_DB - 10), 0);
	assert.equal(toGain(Number.NaN), 0);
});

test("dB steps round-trip through gain", () => {
	for (const dB of [-40, -20, -6, -3, 0]) {
		assert.ok(Math.abs(toDb(toGain(dB)) - dB) < 1e-9, `round-trip failed for ${dB} dB`);
	}
});
