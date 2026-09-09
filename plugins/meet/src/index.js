/**
 * Tek Meet plugin — gateway-side (Plan 104-02).
 *
 * Opens a loopback WebSocket server on 127.0.0.1 with a 32-byte hex token
 * (persisted at ~/.config/tek/meet.token, mode 0600), advertises {port, token}
 * at ~/.config/tek/meet.json for the extension popup to read, and registers
 * two agent tools with ASYMMETRIC approval tiers per CONTEXT D-02 + checker
 * blocker-3:
 *   - meet__join_observer    (session tier — tab audio only)
 *   - meet__join_participant (always tier — mic exposure)
 *
 * Mirrors the chrome-control plugin's WS server + hello/welcome handshake
 * shape (see ../../../chrome/src/index.js). Plans 104-03..104-06 will wire
 * audio capture, CDP navigation, DOM scraping, wake-word, and TTS on top of
 * the channel this plan proves.
 */

import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
	chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { checkConnection } from "./check-connection.js";
import { spawnBotChrome, stopBotChrome } from "./chrome-profile.js";
import { createTranscriber } from "./meet-transcriber.js";
import { resolveArchiveDir, appendChunk } from "./raw-jsonl-writer.js";
import { createSpeakerTracker } from "./speaker-tracker.js";
// Plan 104-05 additions — post-meeting pipeline.
import { finalize as finalizeArchive } from "./archive-writer.js";
import { writeSummaryMd } from "./summarize.js";
import { createMeetingDoc } from "./doc-creator.js";
import { startReconciliation } from "./meet-reconciler.js";
// Plan 104-06 additions — participant-mode wake-word + FSM.
import { createWakeWordScanner } from "./wake-word-scanner.js";
import { createMeetFsm, STATES } from "./meet-fsm.js";

const TOKEN_PATH = join(homedir(), ".config", "tek", "meet.token");
const META_PATH = join(homedir(), ".config", "tek", "meet.json");
const LOG_PREFIX = "[meet]";

function getOrCreateToken() {
	mkdirSync(dirname(TOKEN_PATH), { recursive: true });
	if (existsSync(TOKEN_PATH)) {
		const t = readFileSync(TOKEN_PATH, "utf8").trim();
		if (t.length === 64) return t;
	}
	const t = randomBytes(32).toString("hex");
	writeFileSync(TOKEN_PATH, t, { mode: 0o600 });
	try {
		chmodSync(TOKEN_PATH, 0o600);
	} catch {
		// ignore chmod errors on non-POSIX
	}
	return t;
}

// Module-level state (same pattern as chrome plugin)
let _wss = null;
let _sock = null; // control service-worker socket; audio uses its own connection
const _connections = new Map();
let _lastHandshakeAt = null;
let _meetingId = null;
let _mode = null; // "observer" | "participant" | null
let _capture = { state: "idle" };
let _captureRevision = 0;
let _transcriptionError = null;
const CAPTURE_USER_ACTION_CODE = "MEET_CAPTURE_USER_GESTURE_REQUIRED";
const CAPTURE_GUIDANCE =
	"Focus the Meet tab in the dedicated bot Chrome profile, open the Tek Meet extension, and click Start audio. Chrome requires the user to invoke the extension before capturing the tab.";

function setCaptureState(state, details = {}) {
	_capture = { state, ...details };
	_captureRevision++;
}

function captureFailure(value) {
	const code =
		typeof value?.code === "string" ? value.code : "MEET_CAPTURE_FAILED";
	const error =
		typeof value?.error === "string"
			? value.error
			: "The extension did not confirm that audio capture started.";
	setCaptureState(code === CAPTURE_USER_ACTION_CODE ? "needs-user" : "failed", {
		code,
		error,
	});
}
const _pending = new Map();
let _seq = 0;
let _logger = console;
// Plan 104-03 additions — transcriber + archive lifecycle state.
let _transcriber = null;
let _archiveDir = null;
let _startedAt = null;
let _currentCtx = null;
// Plan 104-04 additions — speaker tracker + bot tab id (for CDP chat-post).
let _tracker = null;
let _meetTabId = null;
// Plan 104-05 additions — captured at joinMeet, consumed by onMeetingEnd.
let _meetUrl = null;
let _meetingTitle = "";
// Plan 104-06 additions — participant mode wake-word + FSM state.
// _scanner and _fsm are created only in participant mode; observer-mode joins
// leave them null so the emitChunk callback short-circuits without overhead.
let _scanner = null;
let _fsm = null;
let _silenceTimer = null;
// A stop invalidates every callback from the previous meeting. The operation
// gate remains held until its in-flight setup/cleanup has actually settled.
let _generation = 0;
let _operation = null;
let _unloading = false;
let _registration = null;
let _stopEvidence = null;
const _shutdowns = new WeakMap();
const _transcriberArchives = new WeakMap();

function actionError(code, error) {
	return { ok: false, code, error };
}

function cancelledError() {
	return Object.assign(new Error("Meet operation was stopped."), {
		code: "MEET_CANCELLED",
	});
}

function assertCurrent(op) {
	if (op.generation !== _generation || op.controller.signal.aborted)
		throw cancelledError();
}

function runOperation(kind, run) {
	const op = {
		kind,
		generation: _generation,
		controller: new AbortController(),
		spawning: false,
	};
	let settled;
	op.done = new Promise((resolve) => {
		settled = resolve;
	});
	_operation = op;
	return (async () => {
		try {
			assertCurrent(op);
			return await run(op);
		} catch (e) {
			return actionError(e?.code || "MEET_FAILED", e?.message || String(e));
		} finally {
			if (_operation === op) _operation = null;
			settled();
		}
	})();
}

function busyError() {
	return actionError(
		"MEET_BUSY",
		"Another Meet operation is still active or cleaning up. Stop it or wait for cleanup before trying again.",
	);
}

function expectedMeetingError(msg) {
	if (!Object.hasOwn(msg, "expectedMeetingId")) return null; // legacy emergency control
	if (
		msg.expectedMeetingId !== null &&
		typeof msg.expectedMeetingId !== "string"
	) {
		return actionError(
			"MEET_CONFLICT",
			"expectedMeetingId must be a meeting ID or null. Refresh Meet status.",
		);
	}
	if (msg.expectedMeetingId !== (_stopEvidence?.meetingId ?? _meetingId)) {
		return actionError(
			"MEET_CONFLICT",
			"The active meeting changed. Refresh Meet status before trying again.",
		);
	}
	return null;
}

function waitForOperation(op, ms) {
	assertCurrent(op);
	return new Promise((resolve, reject) => {
		const signal = op.controller.signal;
		const cancel = () => {
			clearTimeout(timer);
			reject(cancelledError());
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", cancel);
			resolve();
		}, ms);
		signal.addEventListener("abort", cancel, { once: true });
	});
}

async function spawnForOperation(op, options) {
	assertCurrent(op);
	op.spawning = true;
	try {
		await spawnBotChrome(options);
	} finally {
		op.spawning = false;
	}
	assertCurrent(op);
}

function shutdownTranscriber(transcriber) {
	if (!transcriber) return Promise.resolve();
	let shutdown = _shutdowns.get(transcriber);
	if (!shutdown) {
		shutdown = Promise.resolve()
			.then(() => transcriber.shutdown?.())
			.finally(() => {
				const archive = _transcriberArchives.get(transcriber);
				if (archive) archive.accepting = false;
			});
		_shutdowns.set(transcriber, shutdown);
	}
	return shutdown;
}

function clearMeetingState() {
	setCaptureState("idle");
	_transcriptionError = null;
	_transcriber = null;
	_archiveDir = null;
	_startedAt = null;
	_meetingId = null;
	_mode = null;
	_meetTabId = null;
	_meetUrl = null;
	_meetingTitle = "";
	// The old transcriber may still read its captured tracker while flushing.
	_tracker = null;
	_scanner = null;
	try {
		_fsm?.reset();
	} catch {
		/* best-effort */
	}
	_fsm = null;
	if (_silenceTimer) clearTimeout(_silenceTimer);
	_silenceTimer = null;
}

function rejectSocketCalls(sock, error) {
	for (const [id, pending] of _pending) {
		if (pending.sock !== sock) continue;
		_pending.delete(id);
		pending.reject(error);
	}
}

function detachSocket(sock = _sock) {
	if (_sock === sock) {
		_sock = null;
		if (_meetingId && _capture.state === "active")
			setCaptureState("unknown", {
				error:
					"The control extension disconnected; current capture state is unknown.",
			});
	}
	_connections.delete(sock);
	rejectSocketCalls(sock, cancelledError());
	try {
		sock?.close();
	} catch {
		/* best-effort */
	}
}

function detachAllSockets() {
	for (const sock of _connections.keys()) detachSocket(sock);
}

function stopMeeting() {
	if (_operation?.kind === "stop") return busyError();
	const previous = _operation;
	const spawning = previous?.spawning;
	const transcriber = _transcriber;
	_stopEvidence ??= { meetingId: _meetingId, mode: _mode };
	_generation++;
	previous?.controller.abort();
	return runOperation("stop", async () => {
		detachAllSockets();
		clearMeetingState();
		const errors = [];
		const attempt = async (label, run) => {
			try {
				await run();
			} catch (e) {
				errors.push(`${label}: ${e?.message || e}`);
			}
		};
		// Initiate browser termination immediately, before a whisper flush or a
		// pending setup operation can delay the emergency stop.
		const stopChrome = async () => {
			const result = await stopBotChrome();
			if (result?.stopped === false && result.reason !== "not-running") {
				throw new Error(
					"Chrome termination is unconfirmed. Retry stop before starting another Meet operation.",
				);
			}
		};
		const stop = attempt("stopBotChrome", stopChrome);
		const shutdown = attempt("transcriber", () =>
			shutdownTranscriber(transcriber),
		);
		await Promise.all([stop, shutdown, previous?.done]);
		// A spawn already in progress when stop arrived can finish after the
		// first stop. Keep the gate held and stop that late process as well.
		if (spawning) await attempt("late Chrome cleanup", stopChrome);
		if (errors.length === 0) _stopEvidence = null;
		return {
			ok: errors.length === 0,
			error: errors.length ? errors.join("; ") : undefined,
		};
	});
}

/**
 * Default whisper model path — reuses voice-input-stt's model location so
 * users don't have to download twice. Override via plugin config
 * `whisperModelPath`.
 */
function resolveWhisperModelPath(override) {
	if (override) return override;
	return join(
		homedir(),
		".config",
		"tek",
		"plugins",
		"voice-stt",
		"models",
		"ggml-base.en.bin",
	);
}

export function _getActiveSocket() {
	return _sock;
}

export function _rpc(tool, args, timeoutMs = 30_000) {
	const sock = _sock;
	if (!sock) return Promise.reject(new Error("meet extension not connected"));
	const id = ++_seq;
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			_pending.delete(id);
			reject(new Error(`${tool} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		const pending = {
			sock,
			resolve: (v) => {
				clearTimeout(t);
				resolve(v);
			},
			reject: (e) => {
				clearTimeout(t);
				reject(e);
			},
		};
		_pending.set(id, pending);
		try {
			sock.send(JSON.stringify({ id, kind: "call", tool, args }));
		} catch (e) {
			_pending.delete(id);
			pending.reject(e);
		}
	});
}

function extractMeetCode(url) {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:" || parsed.hostname !== "meet.google.com")
			return null;
		return (
			parsed.pathname.match(/^\/([a-z0-9]+(?:-[a-z0-9]+)+)\/?$/i)?.[1] ?? null
		);
	} catch {
		return null;
	}
}

async function joinMeet(args, mode) {
	if (_unloading || _operation || _stopEvidence || _meetingId !== null)
		return busyError();
	return runOperation("join", (op) => joinMeetOwned(args, mode, op));
}

async function joinMeetOwned({ url, voiceProfileId }, mode, op) {
	const meetingCode = typeof url === "string" ? extractMeetCode(url) : null;
	if (!meetingCode) return { ok: false, reason: "invalid-url" };
	_meetingId = meetingCode;
	_mode = mode;
	setCaptureState("idle");
	_transcriptionError = null;
	_startedAt = new Date();
	// Plan 104-05: keep the URL + title around so onMeetingEnd can stamp them
	// into meta.json without re-deriving from cfg.
	_meetUrl = url;
	_meetingTitle = "";
	// Plan 104-03: create the archive dir + whisper transcriber BEFORE
	// spawning Chrome so the moment audio frames start flowing, we have
	// somewhere to put them.
	_archiveDir = resolveArchiveDir({
		startedAt: _startedAt,
		meetCode: _meetingId || "unknown",
		title: "",
	});
	_logger.info?.(`${LOG_PREFIX} archive at ${_archiveDir}`);

	// Plan 104-04: speaker tracker — fed by meet.speaker.changed events from
	// the DOM MutationObserver in content-isolated.js. The transcriber reads
	// getSpeaker() at each flush to tag chunks with the live best-guess.
	_tracker = createSpeakerTracker();

	const cfg = _currentCtx?.getConfig?.() ?? {};
	// Plan 104-06: participant-mode wake-word + FSM. Only arm these in
	// participant mode so observer-mode joins have zero wake-word overhead.
	// Scanner default phrases "hey tek", "tek join in" per CONTEXT D-08.
	if (mode === "participant") {
		const rawPhrases = cfg.wakeWordPhrases;
		const phrases = Array.isArray(rawPhrases)
			? rawPhrases
			: typeof rawPhrases === "string" && rawPhrases.length > 0
				? rawPhrases
						.split(",")
						.map((s) => s.trim())
						.filter(Boolean)
				: ["hey tek", "tek join in"];
		_scanner = createWakeWordScanner({ phrases });
		_fsm = createMeetFsm();
		_fsm.transition("join");
		_logger.info?.(
			`${LOG_PREFIX} participant mode armed — phrases=[${phrases.join(", ")}]`,
		);
	}

	const modelPath = resolveWhisperModelPath(cfg.whisperModelPath);
	// Final shutdown chunks still belong to this archive after stop invalidates
	// the live meeting. They never enter a replacement archive or wake scanner.
	const archive = {
		accepting: true,
		dir: _archiveDir,
		meetingId: _meetingId,
		tracker: _tracker,
	};
	try {
		const transcriber = await createTranscriber({
			modelPath,
			getSpeaker: () => archive.tracker?.getCurrent().name ?? null,
			emitChunk: (chunk) => {
				if (!archive.accepting) return;
				chunk.meetingId = archive.meetingId;
				try {
					appendChunk(archive.dir, chunk);
				} catch (e) {
					_logger.warn?.(
						`${LOG_PREFIX} raw.jsonl append failed: ${e?.message || e}`,
					);
				}
				// Plan 104-05 reads raw.jsonl to build transcript.md.
				// A future gateway push API (phase 108) will broadcast
				// meet.transcript.chunk to the desktop status chip.
				_logger.debug?.(
					`${LOG_PREFIX} chunk: ${String(chunk.text || "").slice(0, 80)}`,
				);
				// Plan 104-06: scan chunks for wake-words ONLY while we're in
				// the observing state (the FSM ignores chunks in other states
				// anyway, but gating here is cheaper). Skip self-echo chunks
				// (plan 104-03 tags these during the bot's own TTS playback).
				if (
					op.generation === _generation &&
					_operation?.kind !== "end" &&
					_scanner &&
					_fsm?.currentState() === STATES.OBSERVING &&
					chunk.source !== "self-echo" &&
					chunk.transcribe !== false
				) {
					const r = _scanner.processChunk({
						text: chunk.text,
						t_end_ms: chunk.t_end_ms,
					});
					if (r.matched) {
						_logger.info?.(`${LOG_PREFIX} wake-word '${r.phrase}' detected`);
						handleWakeWord({
							text: chunk.text,
							matchedPhrase: r.phrase,
						}).catch((e) =>
							_logger.warn?.(`${LOG_PREFIX} wake handler: ${e?.message || e}`),
						);
					}
				}
			},
		});
		_transcriberArchives.set(transcriber, archive);
		if (op.generation !== _generation) {
			await shutdownTranscriber(transcriber);
			throw cancelledError();
		}
		_transcriber = transcriber;
	} catch (e) {
		archive.accepting = false;
		assertCurrent(op);
		_logger.warn?.(
			`${LOG_PREFIX} transcriber init failed (whisper model missing?): ${e?.message || e}`,
		);
		// Continue without transcriber — meeting still joins, audio frames
		// will be silently dropped but Chrome + archive dir are still set up.
		_transcriber = null;
		_transcriptionError = `Local transcription is unavailable: ${e?.message || e}`;
	}

	// Spawn bot Chrome pointed at about:blank first so the main-world content
	// script has a chance to run before Meet loads (RESEARCH Pitfall 1).
	// Plan 104-04 now drives navigation + transparency announce after the
	// WS handshake completes.
	await spawnForOperation(op, { meetUrl: url, logger: _logger });

	// Plan 104-04: wait up to 30s for the extension SW WS handshake so we can
	// drive it via _rpc. First-install users may take longer to load the
	// unpacked extension + paste meta in the popup — in that case we fail
	// soft and let the user retry join.
	const handshakeWaitStart = Date.now();
	while (!_sock && Date.now() - handshakeWaitStart < 30_000) {
		await waitForOperation(op, 500);
	}
	if (!_sock) {
		_logger.warn?.(
			`${LOG_PREFIX} extension handshake timed out — navigate + announce skipped`,
		);
		return {
			ok: false,
			reason: "extension-handshake-timeout",
			meetingId: _meetingId,
			archiveDir: _archiveDir,
		};
	}

	// Plan 104-04: navigate the bot's about:blank tab to the Meet URL via
	// chrome.tabs.update (SW-side). The returned tabId is what we'll attach
	// chrome.debugger to for the chat announce.
	try {
		const navR = await _rpc("meet.navigate", { url }, 15_000);
		assertCurrent(op);
		_meetTabId = navR?.tabId ?? null;
	} catch (e) {
		assertCurrent(op);
		_logger.warn?.(
			`${LOG_PREFIX} meet.navigate failed: ${e?.message || e} — continuing without chat announce`,
		);
	}

	// A Chrome window is not proof that capture has permission or started.
	// Attempt once; a denied user-invocation grant requires an explicit click
	// in the extension popup, whose owned state push updates readiness later.
	setCaptureState("starting");
	const captureRevision = _captureRevision;
	try {
		const captureResult = await _rpc(
			"meet.start-capture",
			{ tabId: _meetTabId, meetingId: _meetingId },
			60_000,
		);
		assertCurrent(op);
		if (_captureRevision === captureRevision) {
			if (captureResult?.ok === true && captureResult.meetingId === _meetingId)
				setCaptureState("active");
			else captureFailure(captureResult);
		}
	} catch (e) {
		assertCurrent(op);
		if (_captureRevision === captureRevision)
			captureFailure({ code: e?.code, error: e?.message || String(e) });
		_logger.warn?.(
			`${LOG_PREFIX} meet.start-capture RPC failed: ${e?.message || e}`,
		);
	}

	// Plan 104-04: give Meet ~8s to reach the in-call UI (load, click-through,
	// waiting-room resolution), then post the D-18 transparency message. The
	// content-isolated.js MutationObserver is already watching for the
	// waiting-room state; if we're still in the waiting room when we try to
	// announce, chrome.debugger selectors will no-op (no chat panel yet) and
	// postTransparencyMessage returns {ok:false}. That's acceptable — the
	// meeting is already joined, just without the announce.
	if (_meetTabId != null) {
		await waitForOperation(op, 8000);
		const userName = resolveUserDisplayName(_currentCtx);
		try {
			const annR = await _rpc(
				"meet.announce",
				{ tabId: _meetTabId, userName },
				30_000,
			);
			assertCurrent(op);
			_logger.info?.(
				`${LOG_PREFIX} transparency announce ok=${annR?.ok} text=${JSON.stringify(annR?.text || "")}`,
			);
		} catch (e) {
			assertCurrent(op);
			_logger.warn?.(`${LOG_PREFIX} meet.announce failed: ${e?.message || e}`);
		}
	}

	const ready = _capture.state === "active" && _transcriber !== null;
	return {
		ok: ready,
		meetingId: _meetingId,
		mode,
		voiceProfileId: voiceProfileId ?? null,
		archiveDir: _archiveDir,
		tabId: _meetTabId,
		capture: { ..._capture },
		transcriptionReady: _transcriber !== null,
		...(!ready
			? {
					code:
						_capture.state !== "active"
							? (_capture.code ?? "MEET_CAPTURE_NOT_ACTIVE")
							: "MEET_TRANSCRIBER_UNAVAILABLE",
					error:
						_capture.state !== "active"
							? (_capture.error ?? "Audio capture is not active.")
							: _transcriptionError,
					guidance:
						_capture.state === "needs-user"
							? CAPTURE_GUIDANCE
							: "The bot window may still be open. Check capture/transcription setup before continuing, or use Stop to close it. Do not repeat the join automatically.",
				}
			: {}),
		note: ready
			? "Audio capture and local transcription are ready; transparency announce was attempted. Meet admission is separate and may still require the host."
			: "The bot window is open, but capture/transcription readiness is incomplete.",
	};
}

/**
 * Plan 104-06 / 104-09: handle a wake-word hit. Drives the FSM through the
 * full participant-mode cycle: observing → wake-detected → thinking →
 * speaking → observing.
 *
 * Plan 104-09 made ctx.generateReply + ctx.generateTts part of the core
 * PluginContext contract (gated by "parent-agent" permission — declared in
 * this plugin's plugin.json). The previous optional-chain with a default
 * fallback from 104-06 is removed — if the gateway is on an older build
 * that doesn't yet expose these helpers, the handler logs a clear error
 * and drops back to `observing` via llm-error. The FSM still flips visibly.
 */
async function handleWakeWord({ text, matchedPhrase }) {
	const generation = _generation;
	const fsm = _fsm;
	const scanner = _scanner;
	const ctx = _currentCtx;
	const meetingId = _meetingId;
	const current = () =>
		generation === _generation && fsm === _fsm && _operation?.kind !== "end";
	if (!fsm || !current()) return;
	try {
		fsm.transition("wake");
		// MVP: the current chunk's text IS the utterance. Strip the wake phrase
		// and use whatever remains (or a brief-answer prompt if nothing does).
		const utterance =
			String(text || "")
				.toLowerCase()
				.replace(String(matchedPhrase || "").toLowerCase(), "")
				.trim() || "Please answer briefly.";
		fsm.transition("utterance-end");

		// Guard against an older gateway that predates plan 104-09 — the plugin
		// can still load but the helper simply isn't on the context. The meet
		// plugin requires "parent-agent" permission, which means the sandbox
		// WILL expose generateReply/generateTts as long as the gateway is at
		// 104-09 or later.
		if (typeof ctx?.generateReply !== "function") {
			_logger.error?.(
				`${LOG_PREFIX} PluginContext.generateReply not available — gateway must be on phase 104-09 or later`,
			);
			try {
				fsm.transition("llm-error");
			} catch {
				// ignore — FSM may have been reset mid-flight
			}
			return;
		}

		let llmResponse = null;
		try {
			llmResponse = await ctx.generateReply({
				prompt: utterance,
				systemContext: `You are attending a Google Meet as a voice assistant. Meeting id: ${meetingId}. Reply briefly and conversationally. Avoid reading long lists.`,
			});
		} catch (e) {
			_logger.warn?.(
				`${LOG_PREFIX} ctx.generateReply threw: ${e?.message || e}`,
			);
		}
		if (!current()) return;
		if (!llmResponse?.text) {
			_logger.warn?.(
				`${LOG_PREFIX} participant response skipped — generateReply returned no text`,
			);
			// No LLM output — graceful-fail back to observing so the next
			// wake-word is still detected.
			try {
				fsm.transition("llm-error");
			} catch {
				// ignore — FSM may have been reset mid-flight
			}
			return;
		}

		if (typeof ctx?.generateTts !== "function") {
			_logger.error?.(
				`${LOG_PREFIX} PluginContext.generateTts not available — gateway must be on phase 104-09 or later`,
			);
			try {
				fsm.transition("llm-error");
			} catch {
				// ignore
			}
			return;
		}

		let tts = null;
		try {
			tts = await ctx.generateTts({
				text: llmResponse.text,
				sampleRate: 24000,
			});
		} catch (e) {
			_logger.warn?.(`${LOG_PREFIX} ctx.generateTts threw: ${e?.message || e}`);
		}
		if (!current()) return;
		if (!tts?.pcmBase64) {
			_logger.warn?.(
				`${LOG_PREFIX} generateTts returned null — voice-output-tts not installed or failed; reverting to observing`,
			);
			try {
				fsm.transition("llm-error");
			} catch {
				// ignore
			}
			return;
		}

		fsm.transition("tts-ready");

		// Suppress wake-word + whisper for the TTS duration + 500 ms safety so
		// we don't self-trigger on echo of our own voice.
		// pcmBase64.length * 0.75 → approx bytes; /2 → int16 samples; /24000
		// → seconds. +500 ms safety.
		const approxBytes = Math.ceil(tts.pcmBase64.length * 0.75);
		const approxSamples = Math.floor(approxBytes / 2);
		const durMs = Math.round((approxSamples / 24000) * 1000) + 500;
		scanner?.setSuppressUntil(Date.now() + durMs);

		try {
			await _rpc(
				"meet.play-tts",
				{ pcmBase64: tts.pcmBase64, sampleRate: 24000 },
				60_000,
			);
		} catch (e) {
			_logger.warn?.(`${LOG_PREFIX} meet.play-tts failed: ${e?.message || e}`);
			if (!current()) return;
			try {
				fsm.transition("tts-end");
			} catch {
				// ignore
			}
			return;
		}

		if (!current()) return;
		try {
			fsm.transition("tts-end");
		} catch {
			// ignore — FSM may have been reset mid-flight
		}

		// Silence timer: N seconds after speech, log + stay in observing.
		// CONTEXT D-09 default 15 s, overridable via config.
		const silenceTimeoutMs =
			Number(ctx?.getConfig?.()?.silenceTimeoutMs) || 15_000;
		if (_silenceTimer) clearTimeout(_silenceTimer);
		_silenceTimer = setTimeout(() => {
			if (!current()) return;
			_logger.info?.(
				`${LOG_PREFIX} silence timeout; staying in observing for next wake-word`,
			);
		}, silenceTimeoutMs);
	} catch (e) {
		if (!current()) return;
		_logger.warn?.(`${LOG_PREFIX} wake handler error: ${e?.message || e}`);
		try {
			fsm?.transition("llm-error");
		} catch {
			// ignore
		}
	}
}

/**
 * Plan 104-04: best-effort bot display-name resolver for the D-18 announce.
 * Pulls from plugin config (`botDisplayName`), falling back to the ctx's
 * own user-name helper (if the plugin sandbox exposes one), finally to a
 * generic "Tek user". Plan 104-07 will wire this to the real desktop user
 * config — for now this is a deliberate stub so joinMeet doesn't block on
 * identity resolution.
 */
function resolveUserDisplayName(ctx) {
	try {
		const cfg = ctx?.getConfig?.() ?? {};
		if (
			typeof cfg.botDisplayName === "string" &&
			cfg.botDisplayName.length > 0
		) {
			return cfg.botDisplayName;
		}
		const fromCtx =
			typeof ctx?.getUserName === "function" ? ctx.getUserName() : null;
		if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
	} catch {
		// ignore
	}
	return "Tek user";
}

/**
 * Plan 104-05: post-meeting pipeline driven by the end-of-meeting hook.
 *
 * Called from two places:
 *   1. The content-script-driven WS event {kind:"meet.in-call-ended"} — Meet
 *      URL no longer matches the in-call shape, or the "Leave call" button
 *      disappeared. This is the normal path.
 *   2. The cleanup() export, as a fallback for graceful plugin unload.
 *
 * Produces (in order, each step non-fatal):
 *   1. transcript.md + meta.json via archive-writer.finalize() — synchronous
 *      I/O over raw.jsonl. Must complete before the Doc call so we have
 *      something to embed.
 *   2. summary.md via summarize.writeSummaryMd() — placeholder per deviation
 *      policy; real LLM wiring lands in plan 104-09.
 *   3. Google Doc via doc-creator.createMeetingDoc() — best-effort. Today
 *      the plugin sandbox does NOT expose ctx.getGoogleAuth(); this call
 *      is a no-op + warn log. Plan 104-09 wires the real auth path.
 *   4. End-of-meeting chat post in Meet via the existing meet.announce RPC —
 *      best-effort; fails silently if the tab is already gone.
 *   5. startReconciliation() — fire-and-forget background job; does NOT block
 *      onMeetingEnd's return.
 *
 * After all of the above, clears meeting state so a stale onMeetingEnd
 * doesn't double-finalize.
 */
async function onMeetingEnd(options = {}) {
	const generation = _generation;
	if (_operation?.kind === "join") {
		const joining = _operation;
		joining.endRequested ??= joining.done.then(() => {
			if (generation === _generation) return onMeetingEnd(options);
		});
		return joining.endRequested;
	}
	if (_operation || !_meetingId) return;
	return runOperation("end", (op) => finishMeeting(options, op));
}

async function finishMeeting({ endedAt = new Date() } = {}, op) {
	if (!_archiveDir || !_meetingId || !_startedAt) {
		_logger.warn?.(
			`${LOG_PREFIX} onMeetingEnd called without active meeting state`,
		);
		return;
	}
	const archiveDir = _archiveDir;
	const meetingId = _meetingId;
	const startedAt = _startedAt;
	const ctx = _currentCtx;
	const tabId = _meetTabId;
	const transcriber = _transcriber;

	_logger.info?.(`${LOG_PREFIX} meeting ended; finalizing ${archiveDir}`);

	const meetUrl = _meetUrl || "";
	const title = _meetingTitle || "";
	const participants =
		_tracker
			?.history()
			.map((h) => h.name)
			.filter(Boolean)
			.filter((v, i, a) => a.indexOf(v) === i) || [];

	if (_sock && _capture.state !== "idle" && _capture.state !== "stopped") {
		try {
			const stopped = await _rpc(
				"meet.stop-capture",
				{ expectedMeetingId: meetingId },
				10_000,
			);
			assertCurrent(op);
			if (stopped?.ok !== true)
				throw new Error(
					stopped?.error || "The extension did not confirm capture stopped.",
				);
			setCaptureState("stopped");
		} catch (e) {
			assertCurrent(op);
			setCaptureState("unknown", {
				code: "MEET_CAPTURE_STOP_UNCONFIRMED",
				error: e?.message || String(e),
			});
			// Preserve the meeting for explicit emergency stop instead of
			// allowing replacement capture over an unconfirmed old stream.
			throw e;
		}
	}

	// Include the final owned chunks in the archive before finalization.
	await shutdownTranscriber(transcriber).catch(() => {});
	assertCurrent(op);

	// Step 1 — archive-writer.finalize
	let archiveResult = null;
	try {
		archiveResult = await finalizeArchive({
			archiveDir: archiveDir,
			meta: {
				meetUrl,
				meetCode: meetingId,
				title,
				startedAt: startedAt.getTime(),
				endedAt: endedAt.getTime(),
				participants,
			},
		});
	} catch (e) {
		_logger.warn?.(`${LOG_PREFIX} finalize failed: ${e?.message || e}`);
	}

	assertCurrent(op);
	// Step 2 — summary placeholder
	try {
		writeSummaryMd(archiveDir, {
			title,
			startedAt: startedAt.getTime(),
			endedAt: endedAt.getTime(),
			groups: archiveResult?.groups || [],
			chunks: archiveResult?.chunks || [],
		});
	} catch (e) {
		_logger.warn?.(`${LOG_PREFIX} writeSummaryMd failed: ${e?.message || e}`);
	}

	// Step 3 — Google Doc (best-effort). ctx.getGoogleAuth is scheduled for plan 104-09.
	let docUrl = null;
	try {
		const auth = await ctx?.getGoogleAuth?.();
		assertCurrent(op);
		if (auth) {
			const summaryMd = readFileSync(join(archiveDir, "summary.md"), "utf8");
			const transcriptMd = readFileSync(
				join(archiveDir, "transcript.md"),
				"utf8",
			);
			const dateSlice = startedAt.toISOString().slice(0, 10);
			const docTitle = `${title || meetingId} — ${dateSlice}`;
			const { documentId, url } = await createMeetingDoc({
				auth,
				title: docTitle,
				summaryMd,
				transcriptMd,
			});
			docUrl = url;
			_logger.info?.(`${LOG_PREFIX} created doc ${documentId}`);
		} else {
			_logger.warn?.(
				`${LOG_PREFIX} no google auth available — skipping Doc creation (plan 104-09 will wire ctx.getGoogleAuth)`,
			);
		}
	} catch (e) {
		_logger.warn?.(`${LOG_PREFIX} Doc creation failed: ${e?.message || e}`);
	}

	assertCurrent(op);
	// Step 4 — end-of-meeting chat post. meet.announce only knows how to post
	// the D-18 transparency text today; re-posting it at meeting end leaves a
	// visible marker in Meet chat that the bot wrote the archive. A future
	// SW-side extension of the announce handler can accept an override text
	// (archive + docUrl) — tracked for plan 104-09.
	if (tabId != null) {
		try {
			await _rpc(
				"meet.announce",
				{ tabId: tabId, userName: "Tek" },
				10_000,
			).catch(() => {});
		} catch {
			// ignore — meet.announce is best-effort
		}
	}
	assertCurrent(op);
	_logger.info?.(
		`${LOG_PREFIX} archive at ${archiveDir}${docUrl ? ` · Doc: ${docUrl}` : ""}`,
	);

	// Step 5 — async reconciliation (fire-and-forget).
	if (typeof ctx?.getGoogleAuth === "function") {
		const archiveDirSnapshot = archiveDir;
		const meetingCodeSnapshot = meetingId;
		const startedAtSnapshot = startedAt;
		ctx
			.getGoogleAuth()
			.then((auth) => {
				if (!auth || op.controller.signal.aborted) return;
				return startReconciliation({
					meetingCode: meetingCodeSnapshot,
					startedAt: startedAtSnapshot,
					archiveDir: archiveDirSnapshot,
					auth,
				}).then(({ promise }) =>
					promise
						.then((r) =>
							_logger.info?.(`${LOG_PREFIX} reconciliation: ${r.status}`),
						)
						.catch((e) =>
							_logger.warn?.(
								`${LOG_PREFIX} reconciliation error: ${e?.message || e}`,
							),
						),
				);
			})
			.catch(() => {});
	}

	assertCurrent(op);
	// Invalidate late transcriber/wake-word callbacks after a normal end too.
	_generation++;
	detachAllSockets();
	clearMeetingState();
}

export async function register(ctx) {
	if (_registration)
		throw new Error(
			"Meet is already registered or still unloading. Wait for cleanup before reloading.",
		);
	_unloading = false;
	_currentCtx = ctx;
	_logger = ctx.logger ?? ctx.log ?? console;
	const cfg = ctx.getConfig?.() ?? {};
	const port = Number(cfg.wsPort) || 52881;
	const token = getOrCreateToken();

	// Persist { port, token } for the extension popup + desktop UI to read.
	mkdirSync(dirname(META_PATH), { recursive: true });
	writeFileSync(META_PATH, JSON.stringify({ port, token }, null, 2), {
		mode: 0o600,
	});
	try {
		chmodSync(META_PATH, 0o600);
	} catch {
		// ignore
	}

	_wss = new WebSocketServer({
		host: "127.0.0.1",
		port,
		verifyClient: (info, cb) => {
			const r = checkConnection(
				info.req.socket.remoteAddress,
				info.req.url,
				token,
			);
			if (!r.ok) {
				_logger.warn?.(`${LOG_PREFIX} rejected connection: ${r.reason}`);
				return cb(false, r.code, r.reason);
			}
			cb(true);
		},
	});

	const registration = { server: _wss, unload: null };
	_registration = registration;
	_wss.on("connection", (sock) => {
		if (
			_registration !== registration ||
			_unloading ||
			_operation?.kind === "stop"
		) {
			sock.close();
			return;
		}
		const connection = { generation: _generation, role: null };
		_connections.set(sock, connection);
		sock.send(JSON.stringify({ kind: "welcome", serverVersion: "0.1.1" }));

		sock.on("message", (raw) => {
			if (
				_connections.get(sock) !== connection ||
				connection.generation !== _generation
			)
				return;
			_lastHandshakeAt = Date.now();
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (!msg || typeof msg !== "object") return;
			if (msg.kind === "hello") {
				if (connection.role && connection.role !== "control") return;
				connection.role = "control";
				if (_sock && _sock !== sock) detachSocket(_sock);
				_sock = sock;
				_logger.info?.(`${LOG_PREFIX} control extension connected`);
				return;
			}
			if (msg.kind === "hello-offscreen") {
				if (connection.role || msg.role !== "audio-source") return;
				connection.role = "audio";
				return;
			}
			if (connection.role === "audio") {
				if (
					msg.kind === "meet.audio.frame" &&
					_meetingId &&
					msg.meetingId === _meetingId &&
					_transcriber
				) {
					_transcriber
						.ingestFrame(msg.frame, msg.t, msg.suppressed === true)
						.catch((e) =>
							_logger.warn?.(`${LOG_PREFIX} ingestFrame: ${e?.message || e}`),
						);
				}
				return;
			}
			if (connection.role !== "control" || _sock !== sock) return;
			if (msg.kind === "result" && typeof msg.id === "number") {
				const p = _pending.get(msg.id);
				if (!p || p.sock !== sock) return;
				_pending.delete(msg.id);
				if (msg.error)
					p.reject(
						Object.assign(
							new Error(msg.error),
							typeof msg.code === "string" ? { code: msg.code } : {},
						),
					);
				else p.resolve(msg.value);
				return;
			}
			// Extension events that identify a meeting must match it. Legacy
			// events without an ID still require an active, owned connection.
			if (
				!_meetingId ||
				(msg.meetingId != null && msg.meetingId !== _meetingId)
			)
				return;
			if (msg.kind === "meet.capture.state") {
				if (
					msg.meetingId !== _meetingId ||
					!["starting", "active", "stopped", "needs-user", "failed"].includes(
						msg.state,
					)
				)
					return;
				setCaptureState(msg.state, {
					...(typeof msg.error === "string" ? { error: msg.error } : {}),
					...(typeof msg.code === "string" ? { code: msg.code } : {}),
				});
				return;
			}

			// Plan 104-04: DOM-scraped active-speaker update from
			// content-isolated.js via the SW. Feeds the tracker; subsequent
			// whisper flushes read tracker.getCurrent().name for speakerGuess.
			// msg.name may be null — that's correct (no selector matched →
			// speakerGuess:null is the honest signal).
			if (msg.kind === "meet.speaker.changed") {
				const at = typeof msg.at === "number" ? msg.at : Date.now();
				_tracker?.setCurrent(msg.name ?? null, at);
				return;
			}
			// Plan 104-04: Meet waiting-room state — the bot landed in the
			// "Asking to join / host will let you in" UI. We do NOT force-click
			// Ask-to-join (that's a user action). Plan 104-07's desktop status
			// chip will surface this so the user can approve or decline.
			if (msg.kind === "meet.waiting-room") {
				_logger.info?.(
					`${LOG_PREFIX} waiting-room detected (meetingId=${msg.meetingId || _meetingId || "?"})`,
				);
				return;
			}
			// Plan 104-05: Meet in-call state ended — content-isolated.js detected
			// the "Leave call" button vanished or the URL changed back to the
			// meet.google.com base. Drives the post-meeting pipeline (finalize +
			// summary + Doc + reconciler). Fire-and-forget so the socket stays
			// responsive to in-flight responses.
			if (msg.kind === "meet.in-call-ended") {
				const endedAt = msg.at ? new Date(msg.at) : new Date();
				onMeetingEnd({ endedAt }).catch((e) =>
					_logger.warn?.(`${LOG_PREFIX} onMeetingEnd: ${e?.message || e}`),
				);
				return;
			}
			// Plans 104-06 handle additional push events (wake-word, TTS ack, etc.).
		});

		sock.on("close", () => {
			const ownedAudio =
				_connections.get(sock) === connection &&
				connection.role === "audio" &&
				connection.generation === _generation;
			_connections.delete(sock);
			if (ownedAudio && _meetingId && _capture.state === "active")
				setCaptureState("unknown", {
					error:
						"The audio extension disconnected; current audio delivery is unknown.",
				});
			if (_sock === sock) {
				_sock = null;
				if (_meetingId && _capture.state === "active")
					setCaptureState("unknown", {
						error:
							"The control extension disconnected; current capture state is unknown.",
					});
			}
			rejectSocketCalls(sock, new Error("meet extension disconnected"));
			_logger.info?.(`${LOG_PREFIX} extension disconnected`);
		});
	});

	_logger.info?.(`${LOG_PREFIX} WS server listening on 127.0.0.1:${port}`);

	// Register the two agent tools with ASYMMETRIC approval tiers per CONTEXT D-02
	// + checker blocker-3. Observer = "session" (tab audio only, no mic exposure,
	// one approval per work session). Participant = "always" (mic exposure when
	// wake-word fires — approve every use).
	ctx.addTool(
		"join_observer",
		{
			description:
				"Join a Google Meet URL as a silent observer. The bot transcribes locally, announces itself in Meet chat, writes a transcript archive to ~/.config/tek/meet-transcripts/, creates a Google Doc with summary, and leaves cleanly at meeting end. Captures tab audio only — no mic exposure.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string", description: "Full meet.google.com URL" },
				},
				required: ["url"],
			},
			execute: async (args) =>
				_registration === registration
					? joinMeet(args, "observer")
					: busyError(),
		},
		{ approvalTier: "session" },
	);

	ctx.addTool(
		"join_participant",
		{
			description:
				"Join a Google Meet URL as a wake-word participant. Starts in passive observer mode; flips to active on wake-word phrase ('hey tek' by default) and speaks responses via a synthetic mic. Returns to passive after 15s of silence. Everything observer does is also done. MIC EXPOSURE — always-approve tier because bot can speak into the meeting.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string" },
					voiceProfileId: {
						type: "string",
						description:
							"Optional voice profile id from config.voiceProfiles[]",
					},
				},
				required: ["url"],
			},
			execute: async (args) =>
				_registration === registration
					? joinMeet(args, "participant")
					: busyError(),
		},
		{ approvalTier: "always" },
	);

	// Desktop status chip + agent introspection via plugin.meet.status WS handler.
	const statusHandler = async (msg) => {
		const m = msg && typeof msg === "object" ? msg : {};
		return {
			type: "plugin.meet.status.result",
			id: m.id,
			requestId: m.id,
			conditionalControlsVersion: 1,
			operation: _operation?.kind ?? (_stopEvidence ? "stop-failed" : null),
			connected: _sock !== null,
			meetingId: _stopEvidence?.meetingId ?? _meetingId,
			mode: _stopEvidence?.mode ?? _mode,
			capture: _stopEvidence
				? { state: "unknown", error: "Stop has not yet confirmed all cleanup." }
				: { ..._capture },
			transcriptionReady: _transcriber !== null,
			...(_transcriptionError
				? { transcriptionError: _transcriptionError }
				: {}),
			lastHandshakeAt: _lastHandshakeAt,
			port,
		};
	};
	if (typeof ctx.addWsHandler === "function") {
		// Namespaced to plugin.meet.status by sandbox.
		ctx.addWsHandler("status", statusHandler);

		// Plan 104-07: desktop-initiated kick. The always-visible status chip
		// exposes a "Kick bot" button — clicking it ends the current meeting
		// immediately (best-effort), kills the bot Chrome profile, and resets
		// module state. NO approval guard here: kick is a user-initiated
		// cleanup from the desktop (the chip IS the user's approval) and must
		// NOT route through the agent-tool approvalTier ladder.
		ctx.addWsHandler("kick", async (msg) => {
			const m = msg && typeof msg === "object" ? msg : {};
			const result =
				(_registration !== registration ? busyError() : null) ||
				expectedMeetingError(m) ||
				(await stopMeeting());
			return {
				type: "plugin.meet.kick.result",
				id: m.id,
				requestId: m.id,
				...result,
			};
		});

		// Plan 104-07: desktop-initiated first-run bot sign-in. Spawns the bot
		// Chrome profile pointed at accounts.google.com so the user can sign
		// the bot into a Google account once. The about:blank default is
		// deliberate for normal Meet joins (RESEARCH Pitfall 1 — MAIN-world
		// content script must run before Meet loads) but is wrong for sign-in;
		// this handler navigates the freshly-spawned Chrome tab to the
		// accounts page immediately after spawn.
		ctx.addWsHandler("open-signin", async (msg) => {
			const m = msg && typeof msg === "object" ? msg : {};
			const refusal =
				(_registration !== registration ? busyError() : null) ||
				expectedMeetingError(m) ||
				(_unloading || _operation || _stopEvidence || _meetingId !== null
					? busyError()
					: null);
			const result =
				refusal ||
				(await runOperation("signin", async (op) => {
					await spawnForOperation(op, {
						meetUrl: "https://accounts.google.com/signin",
						logger: _logger,
						startUrl: "https://accounts.google.com/signin",
					});
					if (_sock) {
						await _rpc("meet.open-signin", {}, 10_000);
						assertCurrent(op);
					}
					return { ok: true };
				}));
			return {
				type: "plugin.meet.open-signin.result",
				id: m.id,
				requestId: m.id,
				...result,
			};
		});
	} else {
		_logger.warn?.(
			`${LOG_PREFIX} ctx.addWsHandler unavailable — desktop status/kick poll will be disabled`,
		);
	}

	return { cleanup: () => unload(registration, false) };
}

function unload(registration, finalize) {
	if (!registration || _registration !== registration) return Promise.resolve();
	if (registration.unload) return registration.unload;
	_unloading = true;
	registration.unload = (async () => {
		// Exported unload finalizes; registered cleanup remains stop-only.
		if (finalize) await onMeetingEnd().catch(() => {});
		if (_operation?.kind === "stop") await _operation.done;
		else await stopMeeting();
		try {
			registration.server.close();
		} catch {
			/* best-effort */
		}
		if (_registration === registration) {
			_wss = null;
			_registration = null;
			_lastHandshakeAt = null;
		}
	})();
	return registration.unload;
}

export async function cleanup() {
	await unload(_registration, true);
}

// Plan 104-09: test-only entry point. Lets wake-word-scanner.test.js exercise
// handleWakeWord with a mocked ctx without spinning up a real Meet / WS / FSM.
// Not part of the plugin's runtime contract — callers outside tests MUST NOT
// rely on __test__ staying stable across versions.
export const __test__ = {
	handleWakeWord,
	_getFsm: () => _fsm,
	_getScanner: () => _scanner,
	_setCtx: (c) => {
		_currentCtx = c;
	},
	_setFsm: (f) => {
		_fsm = f;
	},
	_setMeetingId: (id) => {
		_meetingId = id;
	},
};
