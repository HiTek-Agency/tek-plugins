import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConnection, isLoopback } from "../src/check-connection.js";

const TOKEN = "a".repeat(64);

test("rejects non-loopback with 403", () => {
	const r = checkConnection("10.0.0.5", "/?token=" + TOKEN, TOKEN);
	assert.equal(r.ok, false);
	assert.equal(r.code, 403);
	assert.equal(r.reason, "non-loopback");
});

test("rejects wrong token with 401", () => {
	const r = checkConnection("127.0.0.1", "/?token=BAD", TOKEN);
	assert.equal(r.ok, false);
	assert.equal(r.code, 401);
});

test("rejects missing token with 401", () => {
	const r = checkConnection("127.0.0.1", "/", TOKEN);
	assert.equal(r.ok, false);
	assert.equal(r.code, 401);
});

test("accepts 127.0.0.1 with correct token", () => {
	assert.equal(checkConnection("127.0.0.1", "/?token=" + TOKEN, TOKEN).ok, true);
});

test("accepts ::1 with correct token", () => {
	assert.equal(checkConnection("::1", "/?token=" + TOKEN, TOKEN).ok, true);
});

test("accepts ::ffff:127.0.0.1 with correct token", () => {
	assert.equal(checkConnection("::ffff:127.0.0.1", "/?token=" + TOKEN, TOKEN).ok, true);
});

test("isLoopback identifies loopback and non-loopback", () => {
	assert.equal(isLoopback("127.0.0.1"), true);
	assert.equal(isLoopback("::1"), true);
	assert.equal(isLoopback("192.168.1.1"), false);
});
