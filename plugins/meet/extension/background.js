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

const EXT_VERSION = "0.1.0";
const STORAGE_KEY = "tek_meet_connection";

let ws = null;
let backoff = 1000;
let connected = false;

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
