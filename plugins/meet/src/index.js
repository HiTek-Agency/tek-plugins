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
let _sock = null;
let _lastHandshakeAt = null;
let _meetingId = null;
let _mode = null; // "observer" | "participant" | null
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
	if (!_sock) return Promise.reject(new Error("meet extension not connected"));
	const id = ++_seq;
	_sock.send(JSON.stringify({ id, kind: "call", tool, args }));
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			_pending.delete(id);
			reject(new Error(`${tool} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		_pending.set(id, {
			resolve: (v) => {
				clearTimeout(t);
				resolve(v);
			},
			reject: (e) => {
				clearTimeout(t);
				reject(e);
			},
			timer: t,
		});
	});
}

function extractMeetCode(url) {
	const m = url.match(/meet\.google\.com\/([a-z0-9-]+)/i);
	return m ? m[1] : null;
}

async function joinMeet({ url, voiceProfileId }, mode) {
	if (typeof url !== "string" || !url.includes("meet.google.com/")) {
		return { ok: false, reason: "invalid-url" };
	}
	_meetingId = extractMeetCode(url);
	_mode = mode;
	_startedAt = new Date();
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
	const modelPath = resolveWhisperModelPath(cfg.whisperModelPath);
	try {
		_transcriber = await createTranscriber({
			modelPath,
			getSpeaker: () => _tracker?.getCurrent().name ?? null,
			emitChunk: (chunk) => {
				chunk.meetingId = _meetingId;
				try {
					appendChunk(_archiveDir, chunk);
				} catch (e) {
					_logger.warn?.(`${LOG_PREFIX} raw.jsonl append failed: ${e?.message || e}`);
				}
				// Plan 104-05 reads raw.jsonl to build transcript.md.
				// Plan 104-06 reads it for wake-word scanning.
				// A future gateway push API (phase 108) will broadcast
				// meet.transcript.chunk to the desktop status chip.
				_logger.debug?.(
					`${LOG_PREFIX} chunk: ${String(chunk.text || "").slice(0, 80)}`,
				);
			},
		});
	} catch (e) {
		_logger.warn?.(
			`${LOG_PREFIX} transcriber init failed (whisper model missing?): ${e?.message || e}`,
		);
		// Continue without transcriber — meeting still joins, audio frames
		// will be silently dropped but Chrome + archive dir are still set up.
		_transcriber = null;
	}

	// Spawn bot Chrome pointed at about:blank first so the main-world content
	// script has a chance to run before Meet loads (RESEARCH Pitfall 1).
	// Plan 104-04 now drives navigation + transparency announce after the
	// WS handshake completes.
	await spawnBotChrome({ meetUrl: url, logger: _logger });

	// Plan 104-04: wait up to 30s for the extension SW WS handshake so we can
	// drive it via _rpc. First-install users may take longer to load the
	// unpacked extension + paste meta in the popup — in that case we fail
	// soft and let the user retry join.
	const handshakeWaitStart = Date.now();
	while (!_sock && Date.now() - handshakeWaitStart < 30_000) {
		await new Promise((r) => setTimeout(r, 500));
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
		_meetTabId = navR?.tabId ?? null;
	} catch (e) {
		_logger.warn?.(
			`${LOG_PREFIX} meet.navigate failed: ${e?.message || e} — continuing without chat announce`,
		);
	}

	// Ask the extension to start tab-audio capture (plan 104-03 RPC).
	try {
		await _rpc(
			"meet.start-capture",
			{ tabId: _meetTabId, meetingId: _meetingId },
			60_000,
		);
	} catch (e) {
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
		await new Promise((r) => setTimeout(r, 8000));
		const userName = resolveUserDisplayName(_currentCtx);
		try {
			const annR = await _rpc(
				"meet.announce",
				{ tabId: _meetTabId, userName },
				30_000,
			);
			_logger.info?.(
				`${LOG_PREFIX} transparency announce ok=${annR?.ok} text=${JSON.stringify(annR?.text || "")}`,
			);
		} catch (e) {
			_logger.warn?.(
				`${LOG_PREFIX} meet.announce failed: ${e?.message || e}`,
			);
		}
	}

	return {
		ok: true,
		meetingId: _meetingId,
		mode,
		voiceProfileId: voiceProfileId ?? null,
		archiveDir: _archiveDir,
		tabId: _meetTabId,
		note: "Chrome spawned + audio pipeline armed + transparency announce attempted.",
	};
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
		if (typeof cfg.botDisplayName === "string" && cfg.botDisplayName.length > 0) {
			return cfg.botDisplayName;
		}
		const fromCtx = typeof ctx?.getUserName === "function" ? ctx.getUserName() : null;
		if (typeof fromCtx === "string" && fromCtx.length > 0) return fromCtx;
	} catch {
		// ignore
	}
	return "Tek user";
}

export async function register(ctx) {
	_currentCtx = ctx;
	_logger = ctx.logger ?? ctx.log ?? console;
	const cfg = ctx.getConfig?.() ?? {};
	const port = Number(cfg.wsPort) || 52881;
	const token = getOrCreateToken();

	// Persist { port, token } for the extension popup + desktop UI to read.
	mkdirSync(dirname(META_PATH), { recursive: true });
	writeFileSync(META_PATH, JSON.stringify({ port, token }, null, 2), { mode: 0o600 });
	try {
		chmodSync(META_PATH, 0o600);
	} catch {
		// ignore
	}

	_wss = new WebSocketServer({
		host: "127.0.0.1",
		port,
		verifyClient: (info, cb) => {
			const r = checkConnection(info.req.socket.remoteAddress, info.req.url, token);
			if (!r.ok) {
				_logger.warn?.(`${LOG_PREFIX} rejected connection: ${r.reason}`);
				return cb(false, r.code, r.reason);
			}
			cb(true);
		},
	});

	_wss.on("connection", (sock) => {
		_sock = sock;
		_lastHandshakeAt = Date.now();
		_logger.info?.(`${LOG_PREFIX} extension connected`);
		sock.send(JSON.stringify({ kind: "welcome", serverVersion: "0.1.0" }));

		sock.on("message", (raw) => {
			_lastHandshakeAt = Date.now();
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			if (msg.kind === "hello") {
				_logger.info?.(
					`${LOG_PREFIX} hello from ext v${msg.extVersion} chrome ${msg.chromeVersion}`,
				);
				return;
			}
			if (msg.kind === "result" && typeof msg.id === "number") {
				const p = _pending.get(msg.id);
				if (!p) return;
				_pending.delete(msg.id);
				if (msg.error) p.reject(new Error(msg.error));
				else p.resolve(msg.value);
				return;
			}
			// Plan 104-03: inbound audio frames from the extension's offscreen
			// doc. Fire-and-forget — ingestFrame buffers internally.
			if (msg.kind === "meet.audio.frame") {
				if (_transcriber) {
					_transcriber
						.ingestFrame(msg.frame, msg.t, msg.suppressed === true)
						.catch((e) =>
							_logger.warn?.(
								`${LOG_PREFIX} ingestFrame: ${e?.message || e}`,
							),
						);
				}
				return;
			}
			// Plan 104-03: offscreen doc hello (role-advertising). Logged but
			// non-blocking — the main SW socket's hello remains the source of
			// truth for handshake state.
			if (msg.kind === "hello-offscreen") {
				_logger.info?.(
					`${LOG_PREFIX} offscreen connected (role=${msg.role || "unknown"})`,
				);
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
			// Plans 104-05 / 104-06 handle additional push events (wake-word,
			// TTS ack, etc.).
		});

		sock.on("close", () => {
			if (_sock === sock) _sock = null;
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
			execute: async (args) => joinMeet(args, "observer"),
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
						description: "Optional voice profile id from config.voiceProfiles[]",
					},
				},
				required: ["url"],
			},
			execute: async (args) => joinMeet(args, "participant"),
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
			connected: _sock !== null,
			meetingId: _meetingId,
			mode: _mode,
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
			_logger.info?.(`${LOG_PREFIX} kick requested by desktop`);
			let ok = true;
			let errs = [];
			// Best-effort: flush + release whisper transcriber.
			try {
				await _transcriber?.shutdown();
			} catch (e) {
				ok = false;
				errs.push(`transcriber: ${e?.message || e}`);
			}
			_transcriber = null;
			// Drop tracker state so the next join starts fresh.
			try {
				_tracker?.reset();
			} catch {
				// ignore
			}
			_tracker = null;
			_meetingId = null;
			_mode = null;
			_meetTabId = null;
			// Close the extension socket (if any) — triggers the content
			// side's onclose + reconnect, but Chrome is about to die anyway.
			try {
				_sock?.close();
			} catch {
				// ignore
			}
			_sock = null;
			try {
				await stopBotChrome();
			} catch (e) {
				ok = false;
				errs.push(`stopBotChrome: ${e?.message || e}`);
			}
			return {
				type: "plugin.meet.kick.result",
				id: m.id,
				requestId: m.id,
				ok,
				error: errs.length ? errs.join("; ") : undefined,
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
			_logger.info?.(`${LOG_PREFIX} open-signin requested by desktop`);
			try {
				await spawnBotChrome({
					meetUrl: "https://accounts.google.com/signin",
					logger: _logger,
					startUrl: "https://accounts.google.com/signin",
				});
				// If the extension is already handshaken (rare for a fresh
				// profile but possible on re-sign-in), navigate the about:blank
				// tab explicitly so the user lands on the sign-in page.
				if (_sock) {
					try {
						await _rpc(
							"meet.navigate",
							{ url: "https://accounts.google.com/signin" },
							10_000,
						);
					} catch (e) {
						_logger.warn?.(
							`${LOG_PREFIX} open-signin navigate skipped: ${e?.message || e}`,
						);
					}
				}
				return {
					type: "plugin.meet.open-signin.result",
					id: m.id,
					requestId: m.id,
					ok: true,
				};
			} catch (e) {
				return {
					type: "plugin.meet.open-signin.result",
					id: m.id,
					requestId: m.id,
					ok: false,
					error: e?.message || String(e),
				};
			}
		});
	} else {
		_logger.warn?.(
			`${LOG_PREFIX} ctx.addWsHandler unavailable — desktop status/kick poll will be disabled`,
		);
	}

	return {
		cleanup: async () => {
			// Plan 104-03: flush + release whisper BEFORE tearing down Chrome
			// so any tail audio in the buffer still lands in raw.jsonl.
			try {
				await _transcriber?.shutdown();
			} catch (e) {
				_logger.warn?.(`${LOG_PREFIX} transcriber shutdown: ${e?.message || e}`);
			}
			_transcriber = null;
			_archiveDir = null;
			_startedAt = null;
			// Plan 104-04: drop tracker state so the next join starts fresh.
			_tracker?.reset();
			_tracker = null;
			_meetTabId = null;
			try {
				_wss?.close();
			} catch {
				// ignore
			}
			_wss = null;
			_sock = null;
			_lastHandshakeAt = null;
			_pending.clear();
			await stopBotChrome().catch(() => {});
		},
	};
}

export async function cleanup() {
	try {
		await _transcriber?.shutdown();
	} catch {
		// ignore — cleanup path is best-effort
	}
	_transcriber = null;
	_archiveDir = null;
	_startedAt = null;
	// Plan 104-04: drop tracker state.
	_tracker?.reset();
	_tracker = null;
	_meetTabId = null;
	try {
		_wss?.close();
	} catch {
		// ignore
	}
	_wss = null;
	_sock = null;
	_lastHandshakeAt = null;
	_pending.clear();
	await stopBotChrome().catch(() => {});
}
