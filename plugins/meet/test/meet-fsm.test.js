/**
 * Meet FSM tests (Plan 104-06 Task 1).
 *
 * Pure state machine — no timers, no clocks, no IO. Caller drives transitions
 * via transition(event); invalid transitions throw.
 *
 * State diagram:
 *   idle → join → observing
 *   observing → wake → wake-detected
 *   wake-detected → utterance-end → thinking (MVP: chunk text is the utterance)
 *   wake-detected → utterance-start → recording-utterance
 *   recording-utterance → utterance-end → thinking
 *   thinking → tts-ready → speaking
 *   thinking → llm-error → observing (graceful fail)
 *   speaking → tts-end → observing
 *   any → meeting-end → idle
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeetFsm, STATES } from "../src/meet-fsm.js";

test("initial state is idle", () => {
	const f = createMeetFsm();
	assert.equal(f.currentState(), STATES.IDLE);
});

test("idle + join → observing", () => {
	const f = createMeetFsm();
	f.transition("join");
	assert.equal(f.currentState(), STATES.OBSERVING);
});

test("full happy path: join → wake → utterance-end → tts-ready → tts-end → observing", () => {
	const f = createMeetFsm();
	f.transition("join");
	f.transition("wake");
	assert.equal(f.currentState(), STATES.WAKE_DETECTED);
	f.transition("utterance-end");
	assert.equal(f.currentState(), STATES.THINKING);
	f.transition("tts-ready");
	assert.equal(f.currentState(), STATES.SPEAKING);
	f.transition("tts-end");
	assert.equal(f.currentState(), STATES.OBSERVING);
});

test("wake-detected + utterance-start → recording-utterance", () => {
	const f = createMeetFsm();
	f.transition("join");
	f.transition("wake");
	f.transition("utterance-start");
	assert.equal(f.currentState(), STATES.RECORDING);
	f.transition("utterance-end");
	assert.equal(f.currentState(), STATES.THINKING);
});

test("meeting-end from any state returns to idle", () => {
	for (const e of ["join", "wake", "utterance-end", "tts-ready", "tts-end"]) {
		const f = createMeetFsm();
		// walk up to `e`
		f.transition("join");
		if (e !== "join") f.transition("wake");
		if (["utterance-end", "tts-ready", "tts-end"].includes(e)) f.transition("utterance-end");
		if (["tts-ready", "tts-end"].includes(e)) f.transition("tts-ready");
		if (e === "tts-end") f.transition("tts-end");
		// now dispatch meeting-end
		f.transition("meeting-end");
		assert.equal(f.currentState(), STATES.IDLE, `failed from state reached via "${e}"`);
	}
});

test("invalid transition throws", () => {
	const f = createMeetFsm();
	f.transition("join");
	assert.throws(() => f.transition("tts-end"), /Invalid transition/);
});

test("invalid transition from idle", () => {
	const f = createMeetFsm();
	assert.throws(() => f.transition("wake"), /Invalid transition/);
});

test("listeners receive {prev, next, event}", () => {
	const f = createMeetFsm();
	const events = [];
	f.on((e) => events.push(e));
	f.transition("join");
	f.transition("wake");
	assert.equal(events.length, 2);
	assert.equal(events[0].prev, STATES.IDLE);
	assert.equal(events[0].next, STATES.OBSERVING);
	assert.equal(events[0].event, "join");
	assert.equal(events[1].prev, STATES.OBSERVING);
	assert.equal(events[1].next, STATES.WAKE_DETECTED);
	assert.equal(events[1].event, "wake");
});

test("listener unsubscribe via returned function", () => {
	const f = createMeetFsm();
	const calls = [];
	const off = f.on((e) => calls.push(e));
	f.transition("join");
	off();
	f.transition("wake");
	assert.equal(calls.length, 1, "listener should only fire before unsubscribe");
});

test("llm-error takes us back to observing (graceful fail)", () => {
	const f = createMeetFsm();
	f.transition("join");
	f.transition("wake");
	f.transition("utterance-end");
	assert.equal(f.currentState(), STATES.THINKING);
	f.transition("llm-error");
	assert.equal(f.currentState(), STATES.OBSERVING);
});

test("reset returns to idle regardless of state", () => {
	const f = createMeetFsm();
	f.transition("join");
	f.transition("wake");
	f.reset();
	assert.equal(f.currentState(), STATES.IDLE);
});

test("STATES enum contains all documented states", () => {
	const expected = ["IDLE", "OBSERVING", "WAKE_DETECTED", "RECORDING", "THINKING", "SPEAKING"];
	for (const k of expected) assert.ok(STATES[k], `missing ${k}`);
});
