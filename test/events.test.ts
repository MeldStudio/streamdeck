// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TypedEmitter } from "../src/meld/events.ts";

type Events = { ping: [value: number] };

test("emit delivers arguments to every listener", () => {
	const emitter = new TypedEmitter<Events>();
	const seen: number[] = [];
	emitter.on("ping", (value) => seen.push(value));
	emitter.on("ping", (value) => seen.push(value * 10));
	emitter.emit("ping", 7);
	assert.deepEqual(seen, [7, 70]);
});

test("a throwing listener is isolated from the others and the emitter", () => {
	const errors: string[] = [];
	const emitter = new TypedEmitter<Events>((event, err) => errors.push(`${event}: ${(err as Error).message}`));
	const seen: number[] = [];
	emitter.on("ping", () => {
		throw new Error("bad subscriber");
	});
	emitter.on("ping", (value) => seen.push(value));
	assert.doesNotThrow(() => emitter.emit("ping", 1));
	assert.deepEqual(seen, [1]);
	assert.deepEqual(errors, ["ping: bad subscriber"]);
});

test("off and the returned unsubscriber both remove listeners", () => {
	const emitter = new TypedEmitter<Events>();
	const seen: number[] = [];
	const listener = (value: number): void => {
		seen.push(value);
	};
	const unsubscribe = emitter.on("ping", listener);
	emitter.emit("ping", 1);
	emitter.off("ping", listener);
	emitter.emit("ping", 2);
	assert.deepEqual(seen, [1]);

	emitter.on("ping", listener);
	unsubscribe();
	emitter.emit("ping", 3);
	assert.deepEqual(seen, [1]);
});
