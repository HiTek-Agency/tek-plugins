/**
 * Unit tests for extension/chat-post.js.
 *
 * chat-post.js is a pure function module — no chrome.debugger, no timers,
 * no DOM. It produces the ORDERED sequence of CDP commands that the SW
 * executes to post a chat message. Tests assert the sequence shape and the
 * D-18 transparency wording (non-negotiable per the plan's must_haves).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildTransparencyText,
	buildChatPostCommands,
} from "../extension/chat-post.js";

test("buildTransparencyText matches D-18 exact wording for 'Andrew'", () => {
	const s = buildTransparencyText("Andrew");
	assert.equal(
		s,
		"Tek assistant is attending on behalf of Andrew. I'm recording a local transcript for note-taking.",
	);
});

test("buildTransparencyText interpolates arbitrary user names", () => {
	const s = buildTransparencyText("Dr. Jane Q. User");
	assert.match(s, /^Tek assistant is attending on behalf of Dr\. Jane Q\. User\./);
	assert.match(s, /I'm recording a local transcript for note-taking\.$/);
});

test("buildTransparencyText falls back to 'Tek user' when name is falsy", () => {
	const s1 = buildTransparencyText("");
	const s2 = buildTransparencyText(null);
	const s3 = buildTransparencyText(undefined);
	for (const s of [s1, s2, s3]) {
		assert.equal(
			s,
			"Tek assistant is attending on behalf of Tek user. I'm recording a local transcript for note-taking.",
		);
	}
});

test("buildChatPostCommands: Runtime.evaluate → wait → Runtime.evaluate → wait → Input.insertText → dispatchKeyEvent keyDown Enter → dispatchKeyEvent keyUp Enter", () => {
	const cmds = buildChatPostCommands("hello world");
	assert.equal(cmds[0].method, "Runtime.evaluate");
	assert.equal(cmds[1].method, "_wait");
	assert.equal(cmds[2].method, "Runtime.evaluate");
	assert.equal(cmds[3].method, "_wait");
	assert.equal(cmds[4].method, "Input.insertText");
	assert.equal(cmds[4].params.text, "hello world");
	assert.equal(cmds[5].method, "Input.dispatchKeyEvent");
	assert.equal(cmds[5].params.type, "keyDown");
	assert.equal(cmds[5].params.key, "Enter");
	assert.equal(cmds[6].method, "Input.dispatchKeyEvent");
	assert.equal(cmds[6].params.type, "keyUp");
	assert.equal(cmds[6].params.key, "Enter");
});

test("buildChatPostCommands includes chat button selectors in first evaluate expression", () => {
	const cmds = buildChatPostCommands("x");
	assert.match(cmds[0].params.expression, /Chat with everyone/i);
	assert.match(cmds[0].params.expression, /Open chat/i);
	assert.match(cmds[0].params.expression, /Show chat/i);
});

test("buildChatPostCommands includes chat input selectors in second evaluate expression", () => {
	const cmds = buildChatPostCommands("x");
	assert.match(cmds[2].params.expression, /Send a message/i);
	assert.match(cmds[2].params.expression, /message/i);
});

test("buildChatPostCommands wait values are positive integers >= 100 ms", () => {
	const cmds = buildChatPostCommands("x");
	assert.ok(
		Number.isInteger(cmds[1].params.ms) && cmds[1].params.ms >= 100,
		`expected integer >=100 ms, got ${cmds[1].params.ms}`,
	);
	assert.ok(
		Number.isInteger(cmds[3].params.ms) && cmds[3].params.ms >= 100,
		`expected integer >=100 ms, got ${cmds[3].params.ms}`,
	);
});

test("buildChatPostCommands dispatchKeyEvent Enter uses windowsVirtualKeyCode 13", () => {
	const cmds = buildChatPostCommands("x");
	assert.equal(cmds[5].params.windowsVirtualKeyCode, 13);
	assert.equal(cmds[6].params.windowsVirtualKeyCode, 13);
});

test("buildChatPostCommands: Input.insertText carries the message text verbatim", () => {
	// Must not mangle apostrophes — the D-18 wording has one.
	const msg = buildTransparencyText("Andrew");
	const cmds = buildChatPostCommands(msg);
	assert.equal(cmds[4].params.text, msg);
	assert.match(cmds[4].params.text, /I'm recording/);
});

test("buildChatPostCommands returns exactly 7 commands (button-click, wait, focus-input, wait, insert, keyDown, keyUp)", () => {
	const cmds = buildChatPostCommands("x");
	assert.equal(cmds.length, 7);
});
