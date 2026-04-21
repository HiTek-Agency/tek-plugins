/**
 * Benchmark: whisper throughput on a canned 5-minute sample.
 *
 * Skipped unless BOTH:
 *   - test/fixtures/5min-sample.pcm16 exists (checked-in after plan 104-08 UAT)
 *   - TEK_WHISPER_MODEL env var points at a valid GGML model file
 *
 * Asserts ≥1.5× realtime throughput — 5 minutes of audio should transcribe
 * in ≤3.33 minutes wall time on the target M4 hardware. Fails the test if
 * whisper can't keep up (RESEARCH MEET-06 target).
 *
 * Not part of the default `npm test` suite — run explicitly:
 *   TEK_WHISPER_MODEL=~/.config/tek/plugins/voice-stt/models/ggml-base.en.bin \
 *     node --test test/whisper-throughput.bench.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTranscriber } from "../src/meet-transcriber.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, "fixtures", "5min-sample.pcm16");
const MODEL = process.env.TEK_WHISPER_MODEL;

test(
	"whisper 5-minute throughput ≥1.5× realtime",
	{ skip: !existsSync(FIXTURE) || !MODEL },
	async () => {
		const data = readFileSync(FIXTURE);
		// 100ms @ 16kHz mono Int16 = 1600 samples = 3200 bytes per frame
		const CHUNK = 1600 * 2;
		const t0 = Date.now();
		const chunks = [];
		const t = await createTranscriber({
			modelPath: MODEL,
			emitChunk: (c) => chunks.push(c),
		});
		for (let off = 0; off < data.length; off += CHUNK) {
			const slice = data.subarray(off, Math.min(off + CHUNK, data.length));
			await t.ingestFrame(slice.toString("base64"), t0 + (off / CHUNK) * 100);
		}
		await t.shutdown();
		const elapsedMs = Date.now() - t0;
		const realtimeMs = 5 * 60 * 1000;
		const factor = realtimeMs / elapsedMs;
		// eslint-disable-next-line no-console
		console.log(
			`whisper throughput: ${factor.toFixed(2)}× realtime (elapsed=${elapsedMs}ms, chunks=${chunks.length})`,
		);
		assert.ok(factor >= 1.5, `expected ≥1.5× realtime, got ${factor.toFixed(2)}×`);
	},
);
