import { test } from "node:test";
import assert from "node:assert/strict";
import { isMeetUrl } from "../extension/meet-url.js";

test("accepts canonical HTTPS Meet room URLs", () => {
	assert.equal(isMeetUrl("https://meet.google.com/abc-defg-hij"), true);
	assert.equal(isMeetUrl("https://meet.google.com/abc-defg-hij?authuser=1"), true);
});

test("rejects lookalike, insecure, and non-room URLs", () => {
	for (const url of [
		"https://evil.example/meet.google.com/abc-defg-hij",
		"https://meet.google.com.evil.example/abc-defg-hij",
		"http://meet.google.com/abc-defg-hij",
		"https://meet.google.com:444/abc-defg-hij",
		"https://meet.google.com/",
	]) {
		assert.equal(isMeetUrl(url), false, url);
	}
});
