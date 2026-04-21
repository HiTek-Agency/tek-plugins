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
import { runKeepaliveCycle, KEEPALIVE_INTERVAL_MS } from "./keepalive.js";
import { buildChatPostCommands, buildTransparencyText } from "./chat-post.js";

const EXT_VERSION = "0.1.0";
const STORAGE_KEY = "tek_meet_connection";
const OFFSCREEN_URL = "offscreen.html";
const KEEPALIVE_ALARM = "tek-meet-keepalive";

let ws = null;
let backoff = 1000;
let connected = false;

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

async function saveMeta(meta) {
	await chrome.storage.local.set({ [STORAGE_KEY]: meta });
}

function parseChromeVersion() {
	const m = (self.navigator?.userAgent || "").match(/Chrome\/([\d.]+)/);
	return m ? m[1] : "unknown";
}

function scheduleReconnect(meta) {
	const delay = Math.min(backoff, 30_000);
	setTimeout(() => connect(meta), delay);
	backoff = Math.min(backoff * 2, 30_000);
}

function connect(meta) {
	if (!meta?.port || !meta?.token) return;
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
		scheduleReconnect(meta);
		return;
	}
	ws.addEventListener("open", () => {
		console.log("[tek-meet] WS open");
		ws.send(
			JSON.stringify({
				kind: "hello",
				extVersion: EXT_VERSION,
				chromeVersion: parseChromeVersion(),
			}),
		);
	});
	ws.addEventListener("message", async (e) => {
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
			return;
		}
		// Plan 104-04: intercept specific tool calls BEFORE the pure
		// dispatcher's "not implemented" fallback kicks in. Plan 104-02's
		// dispatch.js is intentionally chrome-free (unit-testable); anything
		// that needs chrome.tabs or chrome.debugger lives here instead.
		if (msg.kind === "call" && typeof msg.tool === "string") {
			const sendResult = (payload) => {
				try {
					ws.send(JSON.stringify({ kind: "result", id: msg.id, ...payload }));
				} catch (err) {
					console.warn("[tek-meet] WS send failed", err);
				}
			};
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
		}
		await dispatch(msg, (out) => {
			try {
				ws.send(JSON.stringify(out));
			} catch (err) {
				console.warn("[tek-meet] WS send failed", err);
			}
		});
	});
	ws.addEventListener("close", () => {
		connected = false;
		console.log("[tek-meet] WS closed");
		scheduleReconnect(meta);
	});
	ws.addEventListener("error", (e) => {
		console.warn("[tek-meet] WS error", e);
	});
}

// Bootstrap: if pairing info is already saved, connect immediately.
(async () => {
	const meta = await loadMeta();
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
	if (msg.kind === "update-meta" && msg.meta) {
		saveMeta(msg.meta)
			.then(() => {
				backoff = 1000;
				connect(msg.meta);
				sendResponse({ ok: true });
			})
			.catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
		return true;
	}
	if (msg.kind === "reset") {
		chrome.storage.local
			.remove(STORAGE_KEY)
			.then(() => {
				try {
					if (ws) ws.close();
				} catch {
					// ignore
				}
				sendResponse({ ok: true });
			})
			.catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
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
	const meta = await loadMeta();
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
			return false;
		}
	}
	return false;
}

async function ensureOffscreen() {
	if (await hasOffscreenDoc()) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: ["USER_MEDIA"],
		justification: "Tek Meet tab audio capture + mic injection",
	});
}

async function startMeetCapture({ tabId, meetingId }) {
	currentMeetingTabId = tabId;
	currentMeetingId = meetingId;
	// chrome.tabCapture.getMediaStreamId is ONLY callable from the SW
	// (or the owner tab's content script) and must be resolved BEFORE the
	// offscreen doc calls getUserMedia.
	const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
	await ensureOffscreen();
	const meta = await loadMeta();
	// Offscreen doc listens on chrome.runtime.onMessage. Response is the ack
	// from startCapture().
	const ack = await chrome.runtime.sendMessage({
		kind: "start-capture",
		streamId,
		meetingId,
		meta,
	});
	if (!ack?.ok) {
		throw new Error(`offscreen start-capture failed: ${ack?.error || "no-ack"}`);
	}
	// chrome.alarms periodInMinutes minimum is normally 0.5 in production
	// Chrome but the keepalive value is 25 s. Chrome honors smaller values
	// only in unpacked / developer builds; the keepalive module guards the
	// ping/pong timing independently so an over-slow alarm just extends
	// the hibernation window — it doesn't corrupt state.
	chrome.alarms.create(KEEPALIVE_ALARM, {
		periodInMinutes: KEEPALIVE_INTERVAL_MS / 60_000,
	});
	return { ok: true, meetingId, streamId };
}

async function stopMeetCapture() {
	try {
		await chrome.runtime.sendMessage({ kind: "stop-capture" });
	} catch {
		// offscreen may already be gone
	}
	chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
	try {
		await chrome.offscreen.closeDocument();
	} catch {
		// ignore
	}
	currentMeetingTabId = null;
	currentMeetingId = null;
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
	if (alarm.name !== KEEPALIVE_ALARM) return;
	await runKeepaliveCycle({
		sendPing: () => chrome.runtime.sendMessage({ kind: "keepalive-ping" }),
		recreate: async () => {
			try {
				await chrome.offscreen.closeDocument();
			} catch {
				// ignore — may already be gone
			}
			if (currentMeetingTabId != null && currentMeetingId != null) {
				await startMeetCapture({
					tabId: currentMeetingTabId,
					meetingId: currentMeetingId,
				});
			}
		},
	});
});

// Route inbound gateway-triggered capture starts through this handler.
// The gateway calls _rpc("meet.start-capture", {tabId, meetingId}); the pure
// dispatcher forwards unknown tools as { kind:"call", tool, args } — we
// short-circuit "meet.start-capture" here before it reaches dispatch.js.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind === "meet.start-capture") {
		startMeetCapture({ tabId: msg.tabId, meetingId: msg.meetingId })
			.then((r) => sendResponse(r))
			.catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
		return true;
	}
	if (msg.kind === "meet.stop-capture") {
		stopMeetCapture()
			.then(() => sendResponse({ ok: true }))
			.catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
		return true;
	}
	return undefined;
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
	if (typeof url !== "string" || !url.includes("meet.google.com/")) {
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
