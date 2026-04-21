/**
 * Chunked whisper transcription loop for Tek Meet.
 *
 * Ingests 16-bit PCM @ 16 kHz mono frames (sent by the extension's offscreen
 * worklet, ~100 ms each). Accumulates into a rolling buffer; when the buffer
 * reaches ~1 s AND the VAD says "speech", runs @fugood/whisper.node's
 * transcribeData; when the buffer reaches 5 s regardless of VAD, force-runs
 * to guarantee we don't silently sit on buffered audio during a long quiet
 * stretch (RESEARCH Pitfall 5).
 *
 * Whisper is lazy-loaded via the EXACT dynamic-import pattern used in
 * packages/gateway/src/plugins/voice-input-stt/src/providers/local-whisper.ts —
 * we do NOT add @fugood/whisper.node as a plugin dep (per phase-82 plugin
 * sandbox conventions, the peer dep resolves from the gateway install).
 *
 * Supports self-echo suppression via a per-frame `suppressed` flag: when the
 * extension is playing back TTS (plan 104-06 sets this), the offscreen doc
 * tags frames suppressed=true. The transcriber still transcribes them, but
 * marks the chunk {source:"self-echo", transcribe:false} so the LLM-facing
 * transcript skips them while raw.jsonl preserves the full timeline.
 */

import { isSpeech } from "./vad.js";

const SAMPLE_RATE = 16000;
const CHUNK_TARGET_MS = 1000;
const FALLBACK_WINDOW_MS = 5000;

/**
 * @typedef {object} TranscriberChunk
 * @property {number}  t_start_ms
 * @property {number}  t_end_ms
 * @property {string}  text
 * @property {null}    speakerGuess   always null in plan 104-03; plan 104-04 fills
 * @property {string}  source         "whisper" | "self-echo"
 * @property {boolean} transcribe     true for LLM-facing, false for self-echo
 * @property {string}  [error]
 */

/**
 * Create a transcriber bound to one whisper context. The returned handle
 * exposes ingestFrame (feed audio) and shutdown (flush + release).
 *
 * @param {object} opts
 * @param {string}   opts.modelPath        GGML whisper model path (used by initWhisper)
 * @param {(c:TranscriberChunk) => void} opts.emitChunk  called per completed chunk
 * @param {(o:object) => Promise<any>} [opts.initWhisperFn]  override for tests — defaults to dynamic @fugood/whisper.node import
 * @param {number} [opts.vadThreshold=500]
 * @param {() => (string|null)} [opts.getSpeaker]   plan 104-04: called at each flush to read the current DOM-scraped speaker; return value becomes chunk.speakerGuess. Defaults to always-null.
 */
export async function createTranscriber({
	modelPath,
	emitChunk,
	initWhisperFn,
	vadThreshold = 500,
	getSpeaker = () => null,
}) {
	const init =
		initWhisperFn ??
		(async (initOpts) => {
			// Dynamic import pattern MIRRORS local-whisper.ts exactly — do NOT
			// add @fugood/whisper.node as a plugin dep. The plugin sandbox
			// resolves it from the gateway's node_modules at runtime.
			// eslint-disable-next-line no-new-func
			const mod = await Function('return import("@fugood/whisper.node")')();
			return mod.initWhisper(initOpts);
		});
	const ctx = await init({ model: modelPath, useGpu: true });

	let buf = []; // array of Int16Array slices
	let bufSamples = 0;
	let firstFrameAt = null;
	let shutdownFlag = false;

	async function flush({ force = false, suppressed = false } = {}) {
		if (bufSamples === 0) return;
		// Peek-first VAD: when NOT force-flushing, check speech BEFORE clearing
		// the buffer. If VAD fails at the 1s mark we keep the buffer accruing
		// toward the 5s fallback window — otherwise a long silent stretch
		// would be repeatedly dropped at 1s and the fallback would never fire.
		const concat = new Int16Array(bufSamples);
		let off = 0;
		for (const s of buf) {
			concat.set(s, off);
			off += s.length;
		}
		const speech = force || isSpeech(concat, vadThreshold);
		if (!speech && !force) {
			// Silence during a soft flush — do NOT clear buffer. Wait for
			// either speech within the next window or the 5s fallback.
			return;
		}
		const t_start_ms = firstFrameAt;
		const t_end_ms = Date.now();
		buf = [];
		bufSamples = 0;
		firstFrameAt = null;

		// Buffer.from with byteOffset + byteLength avoids copying — we just
		// expose the Int16Array's backing ArrayBuffer view as a node Buffer.
		const pcmBuffer = Buffer.from(concat.buffer, concat.byteOffset, concat.byteLength);
		try {
			const { promise } = ctx.transcribeData(pcmBuffer, {
				language: "en",
				temperature: 0.0,
			});
			const result = await promise;
			const text = (result.segments || [])
				.map((s) => s.text)
				.join(" ")
				.trim();
			if (text) {
				// Plan 104-04: stamp the live DOM-scraped speaker into the chunk.
				// getSpeaker() returns null when no MutationObserver event has
				// fired yet or when no selector matched — both are correct; a
				// null speakerGuess is the honest signal.
				let speakerGuess = null;
				try {
					speakerGuess = getSpeaker() ?? null;
				} catch {
					speakerGuess = null;
				}
				emitChunk({
					t_start_ms,
					t_end_ms,
					text,
					speakerGuess,
					source: suppressed ? "self-echo" : "whisper",
					transcribe: !suppressed,
				});
			}
		} catch (e) {
			let speakerGuess = null;
			try {
				speakerGuess = getSpeaker() ?? null;
			} catch {
				speakerGuess = null;
			}
			emitChunk({
				t_start_ms,
				t_end_ms,
				text: "",
				speakerGuess,
				source: "whisper",
				transcribe: false,
				error: e?.message || String(e),
			});
		}
	}

	return {
		/**
		 * Ingest one base64-encoded PCM16 frame from the extension worklet.
		 *
		 * @param {string}  frameBase64
		 * @param {number}  tsMs         epoch-ms timestamp of the frame START
		 * @param {boolean} [suppressed=false]  plan 104-06 sets this during TTS playback
		 */
		async ingestFrame(frameBase64, tsMs, suppressed = false) {
			if (shutdownFlag) return;
			const bin = Buffer.from(frameBase64, "base64");
			// Int16Array view over the Buffer's bytes. The byteLength / 2 is
			// the sample count; callers should send whole-sample-aligned
			// buffers (the worklet always does — 1600 samples = 3200 bytes).
			const i16 = new Int16Array(bin.buffer, bin.byteOffset, bin.length / 2);
			if (firstFrameAt == null) firstFrameAt = tsMs;
			buf.push(i16);
			bufSamples += i16.length;
			const elapsedMs = (bufSamples / SAMPLE_RATE) * 1000;
			if (elapsedMs >= FALLBACK_WINDOW_MS) {
				await flush({ force: true, suppressed });
			} else if (elapsedMs >= CHUNK_TARGET_MS) {
				await flush({ force: false, suppressed });
			}
		},
		async shutdown() {
			shutdownFlag = true;
			await flush({ force: true });
			try {
				await ctx.release?.();
			} catch {
				// ignore — best-effort release
			}
		},
	};
}
