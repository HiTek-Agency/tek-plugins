/**
 * Unit tests for extension/keepalive.js.
 *
 * The module is pure — no chrome.* deps — so we can import and run the cycle
 * with fake sendPing / recreate functions.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { runKeepaliveCycle, KEEPALIVE_INTERVAL_MS, KEEPALIVE_TIMEOUT_MS } from "../extension/keepalive.js";

test("module exports expected constants", () => {
	assert.equal(KEEPALIVE_INTERVAL_MS, 25_000);
	assert.equal(KEEPALIVE_TIMEOUT_MS, 2_000);
});

test("keepalive succeeds when sendPing resolves within timeout", async () => {
	const r = await runKeepaliveCycle({
		sendPing: async () => ({ kind: "keepalive-pong", t: 1 }),
		recreate: async () => {
			throw new Error("should not be called");
		},
		timeoutMs: 100,
	});
	assert.equal(r.alive, true);
	assert.equal(r.pong.kind, "keepalive-pong");
});

test("keepalive triggers recreate on timeout", async () => {
	let recreated = false;
	const r = await runKeepaliveCycle({
		sendPing: () => new Promise(() => {}), // never resolves
		recreate: async () => {
			recreated = true;
		},
		timeoutMs: 10,
	});
	assert.equal(r.alive, false);
	assert.equal(r.recreated, true);
	assert.equal(recreated, true);
	assert.match(r.reason, /timeout/i);
});

test("keepalive triggers recreate on sendPing reject", async () => {
	let recreated = false;
	const r = await runKeepaliveCycle({
		sendPing: async () => {
			throw new Error("port closed");
		},
		recreate: async () => {
			recreated = true;
		},
		timeoutMs: 100,
	});
	assert.equal(recreated, true);
	assert.equal(r.alive, false);
	assert.match(r.reason, /port closed/);
});

test("keepalive surfaces recreate failure without crashing", async () => {
	const r = await runKeepaliveCycle({
		sendPing: async () => {
			throw new Error("initial-fail");
		},
		recreate: async () => {
			throw new Error("recreate-fail");
		},
		timeoutMs: 100,
	});
	assert.equal(r.alive, false);
	assert.equal(r.recreated, false);
	assert.match(r.reason, /recreate-failed/);
});
