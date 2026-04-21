/**
 * Unit tests for src/meet-transcriber.js.
 *
 * We inject initWhisperFn so tests never touch @fugood/whisper.node — the
 * fake context returns deterministic segment data. This lets us assert:
 *   - chunking boundary (1s target, 5s fallback)
 *   - VAD gate drops silent chunks
 *   - suppressed=true tags chunks as self-echo / transcribe:false
 *   - shutdown flushes buffered audio
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTranscriber } from "../src/meet-transcriber.js";

/** Build base64 for `samples` Int16 values, each filled with `value`. */
function makePcmBase64(samples, value = 10000) {
	const i16 = new Int16Array(samples);
	for (let i = 0; i < samples; i++) i16[i] = value;
	return Buffer.from(i16.buffer).toString("base64");
}

test("transcriber uses injected initWhisperFn — no real @fugood/whisper.node needed", async () => {
	let calls = 0;
	const fakeCtx = {
		transcribeData(_buf) {
			calls++;
			return {
				stop() {},
				promise: Promise.resolve({ segments: [{ text: "hello" }], duration: 1 }),
			};
		},
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/nonexistent",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
	});
	// Send 1s of PCM as 10 frames of 1600 samples each (16000 @ 16kHz = 1s).
	// Last frame crosses the CHUNK_TARGET_MS threshold and triggers flush.
	for (let i = 0; i < 10; i++) {
		await t.ingestFrame(makePcmBase64(1600), Date.now() + i * 100);
	}
	await t.shutdown();
	assert.ok(chunks.length >= 1, `expected at least one chunk, got ${chunks.length}`);
	assert.equal(chunks[0].text, "hello");
	assert.equal(chunks[0].transcribe, true);
	assert.equal(chunks[0].source, "whisper");
	assert.equal(chunks[0].speakerGuess, null);
	assert.ok(calls >= 1);
});

test("transcriber respects suppressed=true → source='self-echo', transcribe=false", async () => {
	const fakeCtx = {
		transcribeData: () => ({
			stop() {},
			promise: Promise.resolve({ segments: [{ text: "self" }] }),
		}),
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
	});
	for (let i = 0; i < 10; i++) {
		await t.ingestFrame(makePcmBase64(1600), Date.now(), /*suppressed=*/ true);
	}
	await t.shutdown();
	const selfEcho = chunks.find((c) => c.source === "self-echo");
	assert.ok(selfEcho, "expected at least one self-echo chunk");
	assert.equal(selfEcho.transcribe, false);
});

test("silence frames are skipped (VAD gate — no emitChunk call)", async () => {
	const fakeCtx = {
		transcribeData: () => ({
			stop() {},
			promise: Promise.resolve({ segments: [{ text: "should-not-appear" }] }),
		}),
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
	});
	// 1s of silence (all-zero Int16 = RMS 0, below default threshold 500).
	const silentB64 = Buffer.from(new Int16Array(1600).buffer).toString("base64");
	for (let i = 0; i < 10; i++) await t.ingestFrame(silentB64, Date.now());
	// Intentionally NOT calling shutdown — shutdown force-flushes, which is
	// a separate code path. Here we want to confirm that a passive 1s of
	// silence never emits.
	assert.equal(chunks.length, 0, "silence should not emit");
});

test("5s fallback window force-flushes even with silence", async () => {
	let transcribeCalls = 0;
	const fakeCtx = {
		transcribeData: () => {
			transcribeCalls++;
			return {
				stop() {},
				promise: Promise.resolve({ segments: [{ text: "quiet-but-flushed" }] }),
			};
		},
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
	});
	// 5s of silence = 50 frames of 1600 samples. The last frame pushes
	// elapsedMs >= 5000 and triggers force=true.
	const silentB64 = Buffer.from(new Int16Array(1600).buffer).toString("base64");
	for (let i = 0; i < 50; i++) await t.ingestFrame(silentB64, Date.now());
	// force-flush should have fired at least once
	assert.ok(transcribeCalls >= 1, "5s fallback should force transcribe");
	assert.ok(chunks.length >= 1);
	assert.equal(chunks[0].text, "quiet-but-flushed");
});

test("shutdown flushes remaining buffered audio", async () => {
	const fakeCtx = {
		transcribeData: () => ({
			stop() {},
			promise: Promise.resolve({ segments: [{ text: "tail" }] }),
		}),
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
	});
	// Only send 500ms of loud audio — below 1s CHUNK_TARGET so normal ingest
	// won't flush. shutdown() must force-flush the residual.
	for (let i = 0; i < 5; i++) await t.ingestFrame(makePcmBase64(1600), Date.now());
	assert.equal(chunks.length, 0, "partial buffer should not flush mid-ingest");
	await t.shutdown();
	assert.ok(chunks.length >= 1, "shutdown should flush tail");
	assert.equal(chunks[0].text, "tail");
});

test("transcriber emits error chunk when whisper throws", async () => {
	const fakeCtx = {
		transcribeData: () => ({
			stop() {},
			promise: Promise.reject(new Error("gpu-oom")),
		}),
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
	});
	for (let i = 0; i < 10; i++) await t.ingestFrame(makePcmBase64(1600), Date.now());
	await t.shutdown();
	const errChunk = chunks.find((c) => c.error);
	assert.ok(errChunk, "expected an error chunk when whisper rejects");
	assert.equal(errChunk.transcribe, false);
	assert.match(errChunk.error, /gpu-oom/);
});

test("plan 104-04: getSpeaker callback stamps speakerGuess into each emitted chunk", async () => {
	let currentSpeaker = null;
	const fakeCtx = {
		transcribeData: () => ({
			stop() {},
			promise: Promise.resolve({ segments: [{ text: "hello" }] }),
		}),
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
		getSpeaker: () => currentSpeaker,
	});
	// First chunk while no speaker is known → speakerGuess null
	for (let i = 0; i < 10; i++) await t.ingestFrame(makePcmBase64(1600), Date.now());
	// Now simulate a DOM speaker.changed event — tracker updates its state
	currentSpeaker = "Alice";
	for (let i = 0; i < 10; i++) await t.ingestFrame(makePcmBase64(1600), Date.now());
	await t.shutdown();
	assert.ok(chunks.length >= 2, `expected ≥2 chunks, got ${chunks.length}`);
	assert.equal(chunks[0].speakerGuess, null, "first chunk predates speaker event");
	const aliceChunk = chunks.find((c) => c.speakerGuess === "Alice");
	assert.ok(aliceChunk, "a chunk after speaker event should be tagged 'Alice'");
});

test("plan 104-04: getSpeaker defaults to null-returning fn when not passed", async () => {
	const fakeCtx = {
		transcribeData: () => ({
			stop() {},
			promise: Promise.resolve({ segments: [{ text: "x" }] }),
		}),
		release: async () => {},
	};
	const chunks = [];
	// No getSpeaker — default should keep speakerGuess null (baseline behavior)
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
	});
	for (let i = 0; i < 10; i++) await t.ingestFrame(makePcmBase64(1600), Date.now());
	await t.shutdown();
	assert.ok(chunks.length >= 1);
	assert.equal(chunks[0].speakerGuess, null);
});

test("plan 104-04: getSpeaker throwing doesn't break emission — speakerGuess falls back to null", async () => {
	const fakeCtx = {
		transcribeData: () => ({
			stop() {},
			promise: Promise.resolve({ segments: [{ text: "x" }] }),
		}),
		release: async () => {},
	};
	const chunks = [];
	const t = await createTranscriber({
		modelPath: "/n",
		emitChunk: (c) => chunks.push(c),
		initWhisperFn: async () => fakeCtx,
		getSpeaker: () => {
			throw new Error("tracker-exploded");
		},
	});
	for (let i = 0; i < 10; i++) await t.ingestFrame(makePcmBase64(1600), Date.now());
	await t.shutdown();
	assert.ok(chunks.length >= 1);
	assert.equal(chunks[0].speakerGuess, null);
	assert.equal(chunks[0].text, "x");
});
