import { test } from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../extension/dispatch.js";

test("dispatch('welcome') returns ack", async () => {
	const r = await dispatch({ kind: "welcome" }, () => {});
	assert.equal(r.kind, "ack");
	assert.equal(r.okay, true);
});

test("dispatch('call') sends not-implemented stub result", async () => {
	let sent = null;
	await dispatch(
		{ kind: "call", id: 7, tool: "meet__something", args: {} },
		(m) => {
			sent = m;
		},
	);
	assert.equal(sent.kind, "result");
	assert.equal(sent.id, 7);
	assert.match(sent.error, /not implemented in plan 104-02/);
});

test("dispatch('ping') sends pong with timestamp", async () => {
	let sent = null;
	await dispatch({ kind: "ping" }, (m) => {
		sent = m;
	});
	assert.equal(sent.kind, "pong");
	assert.ok(typeof sent.t === "number");
});
