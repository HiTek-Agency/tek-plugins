/**
 * Wake-word scanner tests (Plan 104-06 Task 1).
 *
 * Pure unit tests — scanner is a pure-state holder with no timers / no IO.
 * Default phrase list is ["hey tek", "tek join in"] per CONTEXT D-08.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createWakeWordScanner, matchesWakeWord } from "../src/wake-word-scanner.js";

test("matches 'hey tek' case-insensitively", () => {
	const s = createWakeWordScanner();
	assert.equal(s.processChunk({ text: "Hey Tek, what's next?" }).matched, true);
	assert.equal(s.processChunk({ text: "HEY TEK!" }).matched, true);
	assert.equal(s.processChunk({ text: "hey tek" }).matched, true);
});

test("matches 'tek join in'", () => {
	const s = createWakeWordScanner();
	assert.equal(s.processChunk({ text: "Tek join in please" }).matched, true);
	assert.equal(s.processChunk({ text: "hey, tek join in now" }).matched, true);
});

test("does not match near-miss phrases", () => {
	const s = createWakeWordScanner();
	assert.equal(s.processChunk({ text: "technology joins in" }).matched, false);
	assert.equal(s.processChunk({ text: "I had a heyday" }).matched, false);
	assert.equal(s.processChunk({ text: "treks and teks" }).matched, false);
});

test("setPhrases replaces the list", () => {
	const s = createWakeWordScanner();
	s.setPhrases(["computer"]);
	assert.equal(s.processChunk({ text: "computer run a check" }).matched, true);
	assert.equal(s.processChunk({ text: "hey tek" }).matched, false);
});

test("suppression window blocks matches", () => {
	const s = createWakeWordScanner();
	const now = Date.now();
	s.setSuppressUntil(now + 10_000);
	const r = s.processChunk({ text: "hey tek", t_end_ms: now });
	assert.equal(r.matched, false);
	assert.equal(r.suppressed, true);
});

test("suppression window expired → matches resume", () => {
	const s = createWakeWordScanner();
	s.setSuppressUntil(100); // already in the past
	const r = s.processChunk({ text: "hey tek", t_end_ms: Date.now() });
	assert.equal(r.matched, true);
});

test("returns the matched phrase", () => {
	const s = createWakeWordScanner();
	const r = s.processChunk({ text: "hey tek" });
	assert.equal(r.phrase, "hey tek");
});

test("matchesWakeWord convenience fn works", () => {
	const r = matchesWakeWord("hey tek hello");
	assert.equal(r.matched, true);
});

test("processChunk handles empty / missing text defensively", () => {
	const s = createWakeWordScanner();
	assert.equal(s.processChunk({}).matched, false);
	assert.equal(s.processChunk({ text: "" }).matched, false);
	assert.equal(s.processChunk(null).matched, false);
});

test("getPhrases returns current list (lowercased)", () => {
	const s = createWakeWordScanner({ phrases: ["Hey Tek", "TEK JOIN IN"] });
	const p = s.getPhrases();
	assert.deepEqual(p, ["hey tek", "tek join in"]);
});

test("regex special chars in phrases are escaped (no regex injection)", () => {
	// If special chars weren't escaped, "foo.bar" would match "fooXbar" via ".".
	const s = createWakeWordScanner({ phrases: ["foo.bar"] });
	assert.equal(s.processChunk({ text: "fooXbar" }).matched, false);
	assert.equal(s.processChunk({ text: "foo.bar here" }).matched, true);
});
