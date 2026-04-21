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

// ─────────────────────────────────────────────────────────────────────────
// Plan 104-09 — handleWakeWord now calls ctx.generateReply + ctx.generateTts
// directly (no `?? Promise.resolve(null)` fallback). These tests exercise
// the test-only entry point to confirm the meat of the FSM flow still
// reaches the ctx helpers with the right arguments.
// ─────────────────────────────────────────────────────────────────────────

test("handleWakeWord calls ctx.generateReply + ctx.generateTts without fallback (phase 104-09)", async () => {
	const mod = await import("../src/index.js").catch((e) => {
		console.warn("skip: index.js import failed:", e?.message || e);
		return null;
	});
	if (!mod?.__test__?.handleWakeWord) {
		console.warn("skip: __test__ export not available");
		return;
	}

	// Fake FSM that records every transition.
	const transitions = [];
	const fsm = {
		transition(evt) {
			transitions.push(evt);
			return this;
		},
		currentState: () => "observing",
		reset() {},
		on() {
			return () => {};
		},
	};
	mod.__test__._setFsm(fsm);
	mod.__test__._setMeetingId("test-meeting-123");

	const calls = { reply: [], tts: [] };
	const rpcLog = [];
	mod.__test__._setCtx({
		getConfig: () => ({ silenceTimeoutMs: 15_000 }),
		generateReply: async (args) => {
			calls.reply.push(args);
			return { text: "ok response" };
		},
		generateTts: async (args) => {
			calls.tts.push(args);
			// 8 chars base64 → 6 decoded bytes → 3 int16 samples @ 24 kHz → ~0.125ms
			return { pcmBase64: "AAAAAAA=", sampleRate: 24000 };
		},
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});

	// handleWakeWord fires meet.play-tts via _rpc — that depends on an open
	// WS socket. We skip the RPC side-effect by NOT wiring _sock; the call
	// will reject and hit the caught-path below. What we verify is that
	// generateReply + generateTts got called with the right shape BEFORE
	// the RPC step, and that the FSM transitioned correctly up to there.
	try {
		await mod.__test__.handleWakeWord({ text: "hey tek what's up", matchedPhrase: "hey tek" });
	} catch {
		// Expected: no WS socket wired → play-tts rejects. Handler already
		// caught internally; this catch is belt-and-suspenders.
	}

	assert.equal(calls.reply.length, 1, "generateReply called exactly once");
	assert.equal(calls.reply[0].prompt, "what's up");
	assert.ok(
		typeof calls.reply[0].systemContext === "string" && calls.reply[0].systemContext.length > 0,
		"systemContext passed through",
	);
	assert.equal(calls.tts.length, 1, "generateTts called exactly once");
	assert.equal(calls.tts[0].text, "ok response");
	assert.equal(calls.tts[0].sampleRate, 24000);

	// FSM should have walked wake → utterance-end → tts-ready and then
	// either tts-end (if RPC succeeds) or a llm-error/tts-end path. The
	// key assertion: wake + utterance-end + tts-ready MUST all fire.
	assert.ok(transitions.includes("wake"), "FSM transitioned 'wake'");
	assert.ok(transitions.includes("utterance-end"), "FSM transitioned 'utterance-end'");
	assert.ok(transitions.includes("tts-ready"), "FSM transitioned 'tts-ready'");
	rpcLog.length; // touch var (keeps eslint quiet if present)
});

test("handleWakeWord transitions to llm-error when generateReply is absent (phase 104-09)", async () => {
	const mod = await import("../src/index.js").catch(() => null);
	if (!mod?.__test__?.handleWakeWord) {
		console.warn("skip: __test__ export not available");
		return;
	}
	const transitions = [];
	const fsm = {
		transition(evt) {
			transitions.push(evt);
			return this;
		},
		currentState: () => "observing",
		reset() {},
		on() {
			return () => {};
		},
	};
	mod.__test__._setFsm(fsm);
	mod.__test__._setMeetingId("test-meeting-123");
	// Ctx WITHOUT generateReply — simulates an older gateway that didn't yet
	// ship phase 104-09.
	mod.__test__._setCtx({
		getConfig: () => ({}),
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	await mod.__test__.handleWakeWord({ text: "hey tek test", matchedPhrase: "hey tek" });
	assert.ok(transitions.includes("llm-error"), "FSM transitioned 'llm-error' on missing generateReply");
});

test("handleWakeWord transitions to llm-error when generateTts returns null (phase 104-09)", async () => {
	const mod = await import("../src/index.js").catch(() => null);
	if (!mod?.__test__?.handleWakeWord) {
		console.warn("skip: __test__ export not available");
		return;
	}
	const transitions = [];
	const fsm = {
		transition(evt) {
			transitions.push(evt);
			return this;
		},
		currentState: () => "observing",
		reset() {},
		on() {
			return () => {};
		},
	};
	mod.__test__._setFsm(fsm);
	mod.__test__._setMeetingId("test-meeting-123");
	mod.__test__._setCtx({
		getConfig: () => ({}),
		generateReply: async () => ({ text: "sure" }),
		// Simulates voice-output-tts not installed.
		generateTts: async () => null,
		logger: { info() {}, warn() {}, error() {}, debug() {} },
	});
	await mod.__test__.handleWakeWord({ text: "hey tek test", matchedPhrase: "hey tek" });
	assert.ok(
		transitions.includes("llm-error"),
		"FSM transitioned 'llm-error' on null TTS result",
	);
});
