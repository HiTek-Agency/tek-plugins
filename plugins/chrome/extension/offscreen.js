/**
 * Tek Chrome Control — offscreen document.
 *
 * Hosts the persistent WebSocket connection to the Tek gateway on
 * ws://127.0.0.1:<port>/?token=<token>. Token MUST be passed via URL query —
 * the browser WebSocket constructor does NOT accept custom request metadata
 * beyond the URL and sub-protocols; options objects are a Node-ws extension.
 *
 * Plan 03 — full handshake + exponential backoff + ping + popup token paste.
 * Plans 04/05 fill the "call" dispatch via chrome.runtime.sendMessage to SW.
 */

const DEFAULT_PORT = 52871;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
const HEARTBEAT_MS = 15_000;
const STALE_CONNECTION_MS = 45_000;
// Offscreen WORKERS context doesn't expose chrome.runtime.getManifest.
// Keep in sync with manifest.json "version".
const EXT_VERSION = "0.3.0";

/** @type {WebSocket | null} */
let ws = null;
/** connecting | connected | disconnected */
let state = "disconnected";
let reason = "starting";
let gatewayVersion = null;
let serverTime = null;
let attempt = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let heartbeatTimer = null;
let lastServerMessageAt = 0;
let controlState = { paused: true, grantedTabCount: 0 };

function currentStatus() {
	return {
		connected: state === "connected",
		state,
		reason,
		gatewayVersion,
		serverTime,
		control: controlState,
	};
}

function stopHeartbeat() {
	if (heartbeatTimer) clearInterval(heartbeatTimer);
	heartbeatTimer = null;
}

function startHeartbeat() {
	stopHeartbeat();
	heartbeatTimer = setInterval(() => {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		if (lastServerMessageAt && Date.now() - lastServerMessageAt > STALE_CONNECTION_MS) {
			ws.close(4003, "stale");
			return;
		}
		ws.send(JSON.stringify({ kind: "ping", at: Date.now() }));
	}, HEARTBEAT_MS);
}

function broadcastStatus() {
	try {
		chrome.runtime
			.sendMessage({ kind: "status", ...currentStatus() })
			.catch(() => {});
	} catch {
		// popup may not be open — ignore
	}
}

function setState(nextState, nextReason) {
	state = nextState;
	if (nextReason) reason = nextReason;
	broadcastStatus();
}

async function loadAuth() {
	// Offscreen docs (reason: WORKERS) can't access chrome.storage.
	// SW owns storage and replies to kind: "get-auth".
	try {
		const res = await chrome.runtime.sendMessage({ kind: "get-auth" });
		return {
			token: res?.token ?? null,
			port: typeof res?.port === "number" && res.port > 0 ? res.port : DEFAULT_PORT,
		};
	} catch {
		return { token: null, port: DEFAULT_PORT };
	}
}

function scheduleReconnect() {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	// Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
	const delay = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * Math.pow(2, attempt));
	attempt++;
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, delay);
}

function getChromeVersion() {
	const m = navigator.userAgent.match(/Chrome\/([\d.]+)/);
	return m?.[1] ?? "unknown";
}

async function connect() {
	const { token, port } = await loadAuth();
	if (!token) {
		setState("disconnected", "no-token");
		return;
	}

	// Clean up any prior socket
	if (ws) {
		try {
			ws.close();
		} catch {
			// ignore
		}
		ws = null;
	}

	const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
	setState("connecting", "connecting");

	let socket;
	try {
		socket = new WebSocket(url);
		ws = socket;
	} catch (err) {
		console.warn("[tek] WS construct failed", err);
		setState("disconnected", "connect-error");
		scheduleReconnect();
		return;
	}

	socket.onopen = async () => {
		if (ws !== socket) return;
		console.log("[tek] WS open", url);
		let extensionId = null;
		try {
			extensionId = chrome?.runtime?.id ?? null;
		} catch (err) {
			console.warn("[tek] chrome.runtime.id unavailable", err);
		}
		const hello = {
			kind: "hello",
			protocolVersion: 1,
			version: EXT_VERSION,
			chromeVersion: getChromeVersion(),
			extensionId,
			capabilities: ["tabs", "debugger", "scripting", "screenshot", "control-lease"],
		};
		try {
			const status = await chrome.runtime.sendMessage({ kind: "get-control-status" });
			if (status?.ok) {
				controlState = {
					paused: status.paused === true,
					grantedTabCount: Number(status.grantedTabCount) || 0,
				};
				hello.control = controlState;
			}
		} catch {
			// The service worker will publish the state after it wakes.
		}
		try {
			socket.send(JSON.stringify(hello));
			console.log("[tek] hello sent", hello);
		} catch (err) {
			console.warn("[tek] hello send failed", err);
		}
	};

	socket.onmessage = async (event) => {
		if (ws !== socket) return;
		lastServerMessageAt = Date.now();
		let msg;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}
		if (msg.kind === "welcome") {
			gatewayVersion = msg.gatewayVersion ?? null;
			serverTime = msg.serverTime ?? null;
			attempt = 0; // reset backoff on successful handshake
			setState("connected", "open");
			startHeartbeat();
			return;
		}
		if (msg.kind === "pong") return;
		if (msg.kind === "call") {
			// Forward RPC call to SW for dispatch (plan 04/05 fill bodies)
			try {
				const result = await chrome.runtime.sendMessage({
					kind: "call",
					id: msg.id,
					tool: msg.tool,
					args: msg.args,
				});
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(JSON.stringify(result ?? { id: msg.id, kind: "result", error: "no-sw-response" }));
				}
			} catch (err) {
				if (socket.readyState === WebSocket.OPEN) {
					socket.send(
						JSON.stringify({
							id: msg.id,
							kind: "result",
							error: String(err?.message || err),
						}),
					);
				}
			}
		}
	};

	socket.onerror = (event) => {
		if (ws !== socket) return;
		console.warn("[tek] WS error", event);
	};

	socket.onclose = (event) => {
		if (ws !== socket) return;
		console.log("[tek] WS close", event.code, event.reason);
		ws = null;
		stopHeartbeat();
		lastServerMessageAt = 0;
		// 4401 = unauthorized (bad/missing token). Still reconnect — user may paste a new token.
		const closeReason = event.code === 4401 ? "unauthorized" : "closed";
		setState("disconnected", closeReason);
		scheduleReconnect();
	};
}

async function reconnectNow() {
	attempt = 0;
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (ws) {
		try { ws.close(); } catch {}
		ws = null;
	}
	connect();
}

/* ---------------- image downscaling (Plan 05 — chrome__screenshot) ----------------
 * The SW captures PNGs via CDP Page.captureScreenshot but OffscreenCanvas is not
 * available in service workers (as of Chrome 125 — createImageBitmap exists in SW
 * but OffscreenCanvas.convertToBlob does not). We do the downscale here instead.
 */
async function downscaleBase64PNG(b64, maxWidth) {
	const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
	const bitmap = await createImageBitmap(blob);
	const ratio = bitmap.width > maxWidth ? maxWidth / bitmap.width : 1;
	const w = Math.round(bitmap.width * ratio);
	const h = Math.round(bitmap.height * ratio);
	const canvas = new OffscreenCanvas(w, h);
	const ctx = canvas.getContext("2d");
	ctx.drawImage(bitmap, 0, 0, w, h);
	const outBlob = await canvas.convertToBlob({ type: "image/png" });
	const buf = await outBlob.arrayBuffer();
	const bytes = new Uint8Array(buf);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return { base64: btoa(bin), width: w, height: h };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind === "control-state-changed") {
		controlState = {
			paused: msg.control?.paused === true,
			grantedTabCount: Array.isArray(msg.control?.allowedTabIds)
				? msg.control.allowedTabIds.length
				: 0,
		};
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ kind: "control_state", control: controlState }));
		}
		broadcastStatus();
		sendResponse({ ok: true });
		return true;
	}
	if (msg.kind === "auth-updated") {
		reconnectNow();
		sendResponse({ ok: true });
		return true;
	}
	if (msg.kind === "status") {
		sendResponse({ kind: "status", ...currentStatus() });
		return true;
	}
	if (msg.kind === "downscale" && typeof msg.base64 === "string") {
		downscaleBase64PNG(msg.base64, Number(msg.maxWidth) || 1920)
			.then((r) => sendResponse(r))
			.catch((e) => sendResponse({ error: String(e?.message ?? e) }));
		return true;
	}
	return undefined;
});

// Kick off initial connection attempt.
connect();
