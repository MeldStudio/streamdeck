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
	const expired: string[] = [];
	const store = new OptimisticStore<number>(TTL_MS, (context) => expired.push(context));
	store.set("ctx", 0.1);
	await sleep(TTL_MS / 2);
	store.set("ctx", 0.2);
	assert.equal(store.get("ctx"), 0.2);
	await sleep(TTL_MS * 3);
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
