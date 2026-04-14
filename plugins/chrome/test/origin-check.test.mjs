import { test } from "node:test";
import assert from "node:assert/strict";
import { checkConnection } from "../src/index.js";

const TOKEN = "a".repeat(64);

test("rejects non-loopback", () => {
	const r = checkConnection("10.0.0.5", "/?token=" + TOKEN, TOKEN);
	assert.equal(r.ok, false);
	assert.equal(r.code, 403);
});

test("rejects wrong token", () => {
	const r = checkConnection("127.0.0.1", "/?token=BAD", TOKEN);
	assert.equal(r.ok, false);
	assert.equal(r.code, 401);
});

test("rejects missing token", () => {
	const r = checkConnection("127.0.0.1", "/", TOKEN);
	assert.equal(r.ok, false);
	assert.equal(r.code, 401);
});

test("accepts 127.0.0.1 with correct token", () => {
	const r = checkConnection("127.0.0.1", "/?token=" + TOKEN, TOKEN);
	assert.equal(r.ok, true);
});

test("accepts ::1", () => {
	const r = checkConnection("::1", "/?token=" + TOKEN, TOKEN);
	assert.equal(r.ok, true);
});

test("accepts ::ffff:127.0.0.1", () => {
	const r = checkConnection("::ffff:127.0.0.1", "/?token=" + TOKEN, TOKEN);
	assert.equal(r.ok, true);
});
