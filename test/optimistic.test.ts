// Copyright (c) 2024 Meld Studio, Inc.
// Licensed under the MIT license. See LICENSE file in the project root for details.

import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { OptimisticStore } from "../src/actions/optimistic.ts";

const TTL_MS = 30;

test("set/get returns the optimistic value until cleared", () => {
	const store = new OptimisticStore<number>(TTL_MS);
	store.set("ctx", 0.5);
	assert.equal(store.get("ctx"), 0.5);
	store.clear("ctx");
	assert.equal(store.get("ctx"), undefined);
});

test("values expire after the TTL", async () => {
	const store = new OptimisticStore<number>(TTL_MS);
	store.set("ctx", 0.5);
	await sleep(TTL_MS * 3);
	assert.equal(store.get("ctx"), undefined);
});

test("expiry invokes onExpire with the context", async () => {
	const expired: string[] = [];
	const store = new OptimisticStore<number>(TTL_MS, (context) => expired.push(context));
	store.set("ctx", 0.5);
	await sleep(TTL_MS * 3);
	assert.deepEqual(expired, ["ctx"]);
});

test("clearing before the TTL suppresses onExpire", async () => {
	const expired: string[] = [];
	const store = new OptimisticStore<number>(TTL_MS, (context) => expired.push(context));
	store.set("ctx", 0.5);
	store.clear("ctx");
	await sleep(TTL_MS * 3);
	assert.deepEqual(expired, []);
});

test("set replaces the value and restarts the timer without an extra onExpire", async () => {
	// The restart is what holds a value across a sustained interaction: a dial
	// rotated for longer than one TTL re-sets on every tick, and if the deadline
	// were still measured from the first tick the value would be dropped
	// mid-rotation and the next tick would re-base on a stale gain.
	const expired: string[] = [];
	const store = new OptimisticStore<number>(TTL_MS, (context) => expired.push(context));
	store.set("ctx", 0.1);
	await sleep(TTL_MS * 0.6);
	store.set("ctx", 0.2);

	// Past the ORIGINAL deadline but inside the restarted one.
	await sleep(TTL_MS * 0.6);
	assert.equal(store.get("ctx"), 0.2, "the second set must extend the lifetime, not inherit the first deadline");
	assert.deepEqual(expired, [], "and nothing should have expired yet");

	// Past the restarted deadline: exactly one expiry, not one per set.
	await sleep(TTL_MS * 2);
	assert.equal(store.get("ctx"), undefined);
	assert.deepEqual(expired, ["ctx"]);
});

test("clearAll drops every value and suppresses onExpire", async () => {
	const expired: string[] = [];
	const store = new OptimisticStore<number>(TTL_MS, (context) => expired.push(context));
	store.set("a", 1);
	store.set("b", 2);
	store.clearAll();
	assert.equal(store.get("a"), undefined);
	assert.equal(store.get("b"), undefined);
	await sleep(TTL_MS * 3);
	assert.deepEqual(expired, []);
});
