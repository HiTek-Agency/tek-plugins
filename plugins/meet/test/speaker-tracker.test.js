/**
 * Unit tests for src/speaker-tracker.js.
 *
 * The tracker is a pure-state, in-memory holder. Tests exercise it as a
 * state machine (tracker.setCurrent(...) → tracker.getCurrent()) without
 * timers or clocks of its own — the `at` timestamp is caller-supplied so
 * tests are deterministic.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSpeakerTracker } from "../src/speaker-tracker.js";

test("initial current is {name:null, since:0}", () => {
	const t = createSpeakerTracker();
	assert.deepEqual(t.getCurrent(), { name: null, since: 0 });
});

test("setCurrent updates current and history", () => {
	const t = createSpeakerTracker();
	t.setCurrent("Alice", 1000);
	assert.equal(t.getCurrent().name, "Alice");
	assert.equal(t.getCurrent().since, 1000);
	assert.equal(t.history().length, 1);
	assert.deepEqual(t.history()[0], { name: "Alice", startedAt: 1000 });
});

test("setCurrent dedupes consecutive same name (history stays size 1)", () => {
	const t = createSpeakerTracker();
	t.setCurrent("Alice", 1);
	t.setCurrent("Alice", 2);
	t.setCurrent("Alice", 3);
	assert.equal(t.history().length, 1);
	// since stays at the FIRST timestamp — dedup means "no new speaker turn"
	assert.equal(t.getCurrent().since, 1);
});

test("setCurrent records null (no one speaking) as a distinct transition", () => {
	const t = createSpeakerTracker();
	t.setCurrent("Alice", 1);
	t.setCurrent(null, 2);
	assert.equal(t.getCurrent().name, null);
	assert.equal(t.history().length, 2);
	assert.deepEqual(t.history()[1], { name: null, startedAt: 2 });
});

test("setCurrent alternates A→B→A → three history entries (re-entry is not dedup'd)", () => {
	const t = createSpeakerTracker();
	t.setCurrent("Alice", 1);
	t.setCurrent("Bob", 2);
	t.setCurrent("Alice", 3);
	assert.equal(t.history().length, 3);
	assert.equal(t.getCurrent().name, "Alice");
	assert.equal(t.getCurrent().since, 3);
});

test("history caps at 200 entries (ring-buffer by shift)", () => {
	const t = createSpeakerTracker();
	for (let i = 0; i < 250; i++) t.setCurrent("p" + i, i);
	assert.equal(t.history().length, 200);
	// The first 50 entries should have been shifted off; first remaining entry
	// is p50.
	assert.equal(t.history()[0].name, "p50");
	assert.equal(t.history()[199].name, "p249");
});

test("reset clears both current and history", () => {
	const t = createSpeakerTracker();
	t.setCurrent("Alice", 1);
	t.setCurrent("Bob", 2);
	t.reset();
	assert.equal(t.getCurrent().name, null);
	assert.equal(t.getCurrent().since, 0);
	assert.equal(t.history().length, 0);
});

test("setCurrent defaults `at` to Date.now() when omitted", () => {
	const t = createSpeakerTracker();
	const before = Date.now();
	t.setCurrent("Alice");
	const after = Date.now();
	const since = t.getCurrent().since;
	assert.ok(since >= before && since <= after, `since ${since} not in [${before}, ${after}]`);
});

test("getCurrent returns a copy — mutating it does not affect tracker state", () => {
	const t = createSpeakerTracker();
	t.setCurrent("Alice", 10);
	const snap = t.getCurrent();
	snap.name = "TAMPERED";
	assert.equal(t.getCurrent().name, "Alice");
});
