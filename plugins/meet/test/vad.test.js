/**
 * Unit tests for src/vad.js.
 *
 * The VAD is the gate between raw PCM frames and whisper — getting it too
 * aggressive silently drops speech, too lax burns CPU on HVAC hum. These
 * tests pin the threshold semantics so future tuning is deliberate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rms, isSpeech } from "../src/vad.js";

test("rms of silent buffer is 0", () => {
	const silent = new Int16Array(1600);
	assert.equal(rms(silent), 0);
});

test("rms of full-scale sine is ~23170 (32767 / sqrt(2))", () => {
	const buf = new Int16Array(1600);
	for (let i = 0; i < 1600; i++) {
		buf[i] = Math.round(32767 * Math.sin((i / 1600) * 2 * Math.PI));
	}
	const r = rms(buf);
	assert.ok(r > 20000 && r < 25000, `expected rms in [20000,25000], got ${r}`);
});

test("rms of zero-length buffer does not NaN (defensive)", () => {
	assert.equal(rms(new Int16Array(0)), 0);
});

test("isSpeech returns false for silence", () => {
	assert.equal(isSpeech(new Int16Array(1600), 500), false);
});

test("isSpeech returns true for loud signal", () => {
	const buf = new Int16Array(1600);
	for (let i = 0; i < 1600; i++) buf[i] = 10000;
	assert.equal(isSpeech(buf, 500), true);
});

test("custom threshold gates correctly at 200 vs 500", () => {
	const buf = new Int16Array(1600);
	for (let i = 0; i < 1600; i++) buf[i] = 200;
	assert.equal(isSpeech(buf, 100), true);
	assert.equal(isSpeech(buf, 500), false);
});

test("default threshold is 500 when omitted", () => {
	const buf = new Int16Array(1600);
	for (let i = 0; i < 1600; i++) buf[i] = 400;
	// rms(all-400) = 400 which is BELOW default 500 — false
	assert.equal(isSpeech(buf), false);
	for (let i = 0; i < 1600; i++) buf[i] = 600;
	assert.equal(isSpeech(buf), true);
});
