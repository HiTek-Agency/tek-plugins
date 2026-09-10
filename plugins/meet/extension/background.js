/**
 * Tek Meet — MV3 Service Worker (Plan 104-02).
 *
 * Responsibilities:
 *   - Persist {port, token} in chrome.storage.local under tek_meet_connection
 *     (populated via the popup from ~/.config/tek/meet.json).
 *   - Open a WebSocket to ws://127.0.0.1:<port>?token=<hex> when pairing
 *     info is available; exchange hello/welcome with the gateway.
 *   - Reconnect with exponential backoff (1s → 30s) on close/error.
 *   - Dispatch incoming messages via the pure ./dispatch.js module so the
 *     dispatcher stays unit-testable without chrome.* APIs.
 *
 * Plans 104-03..104-06 will add offscreen-document lifecycle, tabCapture.
 * getMediaStreamId handoff, and real tool handlers on top of this channel.
 */

import { dispatch } from "./dispatch.js";
import { openBotSignin } from "./open-signin.js";
import { observeCaptureTarget } from "./capture-guards.js";
import { createCaptureController } from "./capture-controller.js";
import { runKeepaliveCycle, KEEPALIVE_INTERVAL_MS } from "./keepalive.js";
import { buildChatPostCommands, buildTransparencyText } from "./chat-post.js";
import { isMeetUrl } from "./meet-url.js";

const EXT_VERSION = "0.1.2";
const STORAGE_KEY = "tek_meet_connection";
const OFFSCREEN_URL = "offscreen.html";
const KEEPALIVE_ALARM = "tek-meet-keepalive";

let ws = null;
let backoff = 1000;
let connected = false;
let connectionRevision = 0;
let reconnectTimer = null;
let pairingChangeInFlight = false;
let metaWriteTail = Promise.resolve();

// Plan 104-03: tabCapture + offscreen-doc lifecycle state.
// currentMeetingTabId survives SW restarts via chrome.storage? — NO, we rely
// on the keepalive cycle to detect drops and the gateway to re-issue a
// meet.start-capture call if the SW was reaped mid-meeting. Keeping it
// module-local is fine for the MVP.
let currentMeetingTabId = null;
let currentMeetingId = null;

async function loadMeta() {
	const r = await chrome.storage.local.get(STORAGE_KEY);
	return r[STORAGE_KEY] || null;
}

function mutateMeta(write) {
	const operation = metaWriteTail.catch(() => {}).then(write);
	metaWriteTail = operation;
	return operation;
}
function saveMeta(meta) {
	return mutateMeta(() => chrome.storage.local.set({ [STORAGE_KEY]: meta }));
}

function parseChromeVersion() {
	const m = (self.navigator?.userAgent || "").match(/Chrome\/([\d.]+)/);
	return m ? m[1] : "unknown";
}

function scheduleReconnect(meta, revision) {
	if (revision !== connectionRevision) return;
	const delay = Math.min(backoff, 30_000);
	clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(() => { if (revision === connectionRevision) connect(meta); }, delay);
	backoff = Math.min(backoff * 2, 30_000);
}

function disconnectTransport() {
	++connectionRevision;
	clearTimeout(reconnectTimer);
	connected = false;
	const previous = ws;
	ws = null;
	try { previous?.close(); } catch { /* Already closed. */ }
}

function connect(meta) {
	if (!meta?.port || !meta?.token) return;
	const revision = ++connectionRevision;
	clearTimeout(reconnectTimer);
	connected = false;
	if (ws) {
		try {
			ws.close();
		} catch {
			// ignore
		}
	}
	try {
		ws = new WebSocket(`ws://127.0.0.1:${meta.port}?token=${meta.token}`);
	} catch (e) {
		console.error("[tek-meet] WS construction failed", e);
		scheduleReconnect(meta, revision);
		return;
	}
	const socket = ws;
	const current = () => revision === connectionRevision && ws === socket;
	socket.addEventListener("open", () => {
		if (!current()) return;
		console.log("[tek-meet] WS open");
		ws.send(
			JSON.stringify({
				kind: "hello",
				extVersion: EXT_VERSION,
				chromeVersion: parseChromeVersion(),
			}),
		);
	});
	socket.addEventListener("message", async (e) => {
		if (!current()) return;
		let msg;
		try {
			msg = JSON.parse(e.data);
		} catch {
			return;
		}
		if (msg.kind === "welcome") {
			connected = true;
			backoff = 1000;
			await saveMeta({ ...meta, connected: true, lastHandshakeAt: Date.now() });
			if (!current()) return;
			return;
		}
		// Plan 104-04: intercept specific tool calls BEFORE the pure
		// dispatcher's "not implemented" fallback kicks in. Plan 104-02's
		// dispatch.js is intentionally chrome-free (unit-testable); anything
		// that needs chrome.tabs or chrome.debugger lives here instead.
		if (msg.kind === "call" && typeof msg.tool === "string") {
			const sendResult = (payload) => {
				if (!current()) return;
				try {
					socket.send(JSON.stringify({ kind: "result", id: msg.id, ...payload }));
				} catch (err) {
					console.warn("[tek-meet] WS send failed", err);
				}
			};
			if (msg.tool === "meet.start-capture" || msg.tool === "meet.stop-capture") {
				const result = msg.tool === "meet.start-capture"
					? await capture.start(msg.args)
					: await capture.stop(msg.args);
				sendResult({ value: result });
				return;
			}
			if (msg.tool === "meet.open-signin") {
				try {
					const r = await openBotSignin(msg.args, chrome);
					sendResult({ value: r });
				} catch (e) {
					sendResult({ error: String(e?.message || e) });
				}
				return;
			}
			if (msg.tool === "meet.navigate") {
				try {
					const r = await navigateBotTab(msg.args || {});
					sendResult({ value: r });
				} catch (e) {
					sendResult({ error: String(e?.message || e) });
				}
				return;
			}
			if (msg.tool === "meet.announce") {
				try {
					const r = await postTransparencyMessage(msg.args || {});
					sendResult({ value: r });
				} catch (e) {
					sendResult({ error: String(e?.message || e) });
				}
				return;
			}
			// Plan 104-06: TTS playback entry point. The gateway sends
			// {pcmBase64, sampleRate}; we route it into the offscreen doc
			// (which sets the self-echo suppression window) AND forward it
			// to the MAIN world via content-isolated → window.postMessage
			// so the in-world AudioContext can play it through the synthetic
			// mic's MediaStreamDestinationNode. Two deliveries because
			// neither the SW nor the offscreen doc can construct the
			// MediaStream that Meet's getUserMedia override needs — only the
			// MAIN world can.
			if (msg.tool === "meet.play-tts") {
				try {
					const args = msg.args || {};
					// 1. Offscreen doc — mark suppression window.
					try {
						await chrome.runtime.sendMessage({
							kind: "play-tts",
							pcmBase64: args.pcmBase64,
							sampleRate: args.sampleRate,
						});
					} catch (e) {
						console.warn("[tek-meet] offscreen play-tts ack failed", e);
					}
					// 2. Bot tab — relay the chunk to MAIN world via
					// content-isolated for actual audio playback through
					// the synthetic mic stream.
					if (currentMeetingTabId != null) {
						try {
							await chrome.tabs.sendMessage(currentMeetingTabId, {
								kind: "tts-chunk",
								pcmBase64: args.pcmBase64,
								sampleRate: args.sampleRate,
							});
						} catch (e) {
							console.warn(
								"[tek-meet] tts-chunk relay failed",
								e,
							);
						}
					}
					sendResult({ value: { ok: true } });
				} catch (e) {
					sendResult({ error: String(e?.message || e) });
				}
				return;
			}
		}
		await dispatch(msg, (out) => {
			if (!current()) return;
			try {
				ws.send(JSON.stringify(out));
			} catch (err) {
				console.warn("[tek-meet] WS send failed", err);
			}
		});
	});
	socket.addEventListener("close", () => {
		if (!current()) return;
		connected = false;
		console.log("[tek-meet] WS closed");
		// Lost control ownership cannot authorize continued or restarted audio.
		void capture.stop();
		scheduleReconnect(meta, revision);
	});
	socket.addEventListener("error", (e) => {
		if (!current()) return;
		console.warn("[tek-meet] WS error", e);
	});
}

// Bootstrap: if pairing info is already saved, connect immediately.
(async () => {
	const revision = connectionRevision;
	const meta = await loadMeta();
	if (revision !== connectionRevision || pairingChangeInFlight) return;
	if (meta?.port && meta?.token) {
		connect(meta);
	} else {
		console.log("[tek-meet] no connection meta in storage — user must paste via popup");
	}
})();

// Popup → SW message bridge: popup pastes {port, token} and sends update-meta;
// SW stores and (re)connects with a fresh backoff.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if ((msg.kind === "update-meta" && msg.meta) || msg.kind === "reset") {
		if (_sender?.url !== chrome.runtime.getURL("popup.html")) {
			sendResponse({ok:false,error:"Open the Tek Meet popup to change pairing."});
			return false;
		}
		if (pairingChangeInFlight) { sendResponse({ok:false,error:"Another pairing change is still in progress."}); return false; }
		pairingChangeInFlight = true;
		// Detach the old control owner before awaiting media cleanup. A queued
		// close/message from it cannot restart transport or capture afterward.
		disconnectTransport();
		const revision = connectionRevision;
		(async () => {
			const result = await capture.stop();
			if (!result.ok) { sendResponse(result); return; }
			if (revision !== connectionRevision) { sendResponse({ok:false,error:"Pairing changed while this request was pending."}); return; }
			if (msg.kind === "reset") await mutateMeta(() => chrome.storage.local.remove(STORAGE_KEY));
			else {
				await saveMeta(msg.meta);
				if (revision !== connectionRevision) { sendResponse({ok:false,error:"Pairing changed while this request was pending."}); return; }
				backoff = 1000;
				connect(msg.meta);
			}
			sendResponse({ok:true});
		})().catch(() => sendResponse({ok:false,error:"Pairing could not be changed. Check audio status before retrying."})).finally(() => { pairingChangeInFlight = false; });
		return true;
	}
	if (msg.kind === "status") {
		sendResponse({ connected });
		return false;
	}
});

chrome.runtime.onInstalled.addListener(() => {
	console.log("[tek-meet] SW installed");
});
chrome.runtime.onStartup.addListener(async () => {
	const revision = connectionRevision;
	const meta = await loadMeta();
	if (revision !== connectionRevision || pairingChangeInFlight) return;
	if (meta?.port && meta?.token) connect(meta);
});

/* ---------------- Plan 104-03: tabCapture + offscreen doc lifecycle ---------------- */

async function hasOffscreenDoc() {
	if (typeof chrome.offscreen?.hasDocument === "function") {
		try {
			return await chrome.offscreen.hasDocument();
		} catch {
			// fall through
		}
	}
	if (typeof chrome.runtime?.getContexts === "function") {
		try {
			const contexts = await chrome.runtime.getContexts({
				contextTypes: ["OFFSCREEN_DOCUMENT"],
			});
			return Array.isArray(contexts) && contexts.length > 0;
		} catch {
			throw new Error("Offscreen status unavailable");
		}
	}
	throw new Error("Offscreen status unavailable");
}

async function ensureOffscreen() {
	if (await hasOffscreenDoc()) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: ["USER_MEDIA"],
		justification: "Tek Meet tab audio capture + mic injection",
	});
}

function publishCaptureState(state) {
	if (state.meetingId && ws?.readyState === 1) {
		try { ws.send(JSON.stringify({ kind:"meet.capture.state", ...state })); } catch { /* Gateway status will remain unconfirmed. */ }
	}
}
const capture = createCaptureController({
	chromeApi: chrome, loadMeta, ensureOffscreen, hasOffscreen: hasOffscreenDoc,
	alarmName: KEEPALIVE_ALARM, periodInMinutes: KEEPALIVE_INTERVAL_MS / 60_000,
	onState: state => {
		currentMeetingTabId = state.state === "active" ? state.tabId : null;
		currentMeetingId = state.state === "active" ? state.meetingId : null;
		publishCaptureState(state);
	},
});

observeCaptureTarget(chrome, capture);

chrome.alarms.onAlarm.addListener(async alarm => {
	if (alarm.name !== KEEPALIVE_ALARM || capture.snapshot().state !== "active") return;
	await runKeepaliveCycle({
		sendPing: () => chrome.runtime.sendMessage({ kind:"keepalive-ping" }),
		recreate: async () => { const result = await capture.recover(); if (!result.ok) throw new Error(result.error ?? "Capture recovery unavailable"); },
	});
});

// Opening the popup invokes the extension on the selected tab. Chrome still
// enforces activeTab when getMediaStreamId runs; runtime messages do not grant it.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || !["meet.capture.status", "meet.start-capture", "meet.stop-capture"].includes(msg.kind)) return;
	if (sender?.url !== chrome.runtime.getURL("popup.html")) {
		sendResponse({ok:false,code:"MEET_CAPTURE_INVALID",error:"Open the Tek Meet popup to control audio capture."});
		return false;
	}
	if (msg.kind === "meet.capture.status") { sendResponse(capture.snapshot()); return false; }
	const requested = capture.snapshot();
	if (msg.kind === "meet.start-capture" && (requested.tabId !== msg.tabId || requested.meetingId !== msg.meetingId)) {
		sendResponse({ok:false,code:"MEET_CONFLICT",error:"The requested meeting changed. Refresh the popup."});
		return false;
	}
	const operation = msg.kind === "meet.start-capture"
		? capture.start({tabId:msg.tabId,meetingId:msg.meetingId})
		: capture.stop({expectedMeetingId:msg.expectedMeetingId});
	operation.then(sendResponse);
	return true;
});

/* ---------- Plan 104-04: meet.navigate (CDP) + meet.announce (CDP chat post) ---------- */

/**
 * Drive the bot Chrome's about:blank tab to the Meet URL. The tab is chosen
 * from chrome.tabs.query({url:"about:blank"}) in the bot profile (the gateway
 * only ever spawns ONE Chrome window per meeting, so ambiguity is unlikely).
 * Returns { ok, tabId } so the gateway can remember tabId for the announce
 * step.
 */
async function navigateBotTab({ url }) {
	if (!isMeetUrl(url)) {
		throw new Error("meet.navigate: invalid url");
	}
	const tabs = await chrome.tabs.query({ url: "about:blank" });
	const tab = tabs?.[0];
	if (!tab) throw new Error("meet.navigate: no about:blank tab found");
	await chrome.tabs.update(tab.id, { url });
	return { ok: true, tabId: tab.id };
}

/**
 * Post the D-18 transparency message in Meet's built-in chat via CDP DOM
 * automation. Meet has no REST chat API (verified in RESEARCH §2.3) so DOM
 * automation is the only path. The command sequence is composed by the pure
 * chat-post.js module (unit-tested separately); this function only executes
 * it via chrome.debugger.
 *
 * Returns { ok: true } on success, { ok: false, error } on failure. Failures
 * are NON-FATAL — the meeting still proceeds. The gateway surfaces the
 * outcome via logs + the plugin.meet.status handler.
 */
async function postTransparencyMessage({ tabId, userName }) {
	if (typeof tabId !== "number") {
		return { ok: false, error: "meet.announce: tabId required" };
	}
	const text = buildTransparencyText(userName);
	const cmds = buildChatPostCommands(text);
	let attached = false;
	try {
		await chrome.debugger.attach({ tabId }, "1.3");
		attached = true;
		for (const cmd of cmds) {
			if (cmd.method === "_wait") {
				await new Promise((r) => setTimeout(r, cmd.params.ms));
				continue;
			}
			await chrome.debugger.sendCommand({ tabId }, cmd.method, cmd.params);
		}
		return { ok: true, text };
	} catch (e) {
		console.warn("[tek-meet] chat-post failed", e);
		return { ok: false, error: String(e?.message || e) };
	} finally {
		if (attached) {
			try {
				await chrome.debugger.detach({ tabId });
			} catch {
				// ignore — may already be detached
			}
		}
	}
}

/* -------- Plan 104-04: forward content-script events to the gateway -------- */
// content-isolated.js fires chrome.runtime.sendMessage({kind:"speaker.changed", ...})
// and {kind:"meet.waiting-room", ...}. We translate kind → meet.speaker.changed
// (gateway namespace) and meet.waiting-room, decorate with currentMeetingId,
// and forward over the WS established above.
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if (!ws || ws.readyState !== 1) return; // WS not up — drop event
	if (msg.kind === "speaker.changed") {
		try {
			ws.send(
				JSON.stringify({
					kind: "meet.speaker.changed",
					name: msg.name ?? null,
					matchedSelector: msg.matchedSelector ?? null,
					at: typeof msg.at === "number" ? msg.at : Date.now(),
					meetingId: currentMeetingId,
				}),
			);
		} catch (e) {
			console.warn("[tek-meet] speaker.changed forward failed", e);
		}
		return;
	}
	if (msg.kind === "meet.waiting-room") {
		try {
			ws.send(
				JSON.stringify({
					kind: "meet.waiting-room",
					at: typeof msg.at === "number" ? msg.at : Date.now(),
					meetingId: currentMeetingId,
				}),
			);
		} catch (e) {
			console.warn("[tek-meet] waiting-room forward failed", e);
		}
		return;
	}
});
