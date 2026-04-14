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

function currentStatus() {
	return {
		connected: state === "connected",
		state,
		reason,
		gatewayVersion,
		serverTime,
	};
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
	const { auth, wsPort } = await chrome.storage.local.get(["auth", "wsPort"]);
	// CONTEXT D-12: token is stored under auth.token. Back-compat: accept plain string too.
	const token =
		typeof auth === "string" ? auth : auth && typeof auth === "object" ? auth.token ?? null : null;
	const port =
		typeof wsPort === "number" && wsPort > 0 ? wsPort : DEFAULT_PORT;
	return { token, port };
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

	try {
		ws = new WebSocket(url);
	} catch (err) {
		console.warn("[tek] WS construct failed", err);
		setState("disconnected", "connect-error");
		scheduleReconnect();
		return;
	}

	ws.onopen = () => {
		console.log("[tek] WS open", url);
		// Send hello handshake — gateway will reply with welcome
		const hello = {
			kind: "hello",
			version: chrome.runtime.getManifest().version || "0.1.0",
			chromeVersion: getChromeVersion(),
			extensionId: chrome.runtime.id,
			capabilities: ["tabs", "debugger", "scripting", "screenshot"],
		};
		try {
			ws.send(JSON.stringify(hello));
		} catch (err) {
			console.warn("[tek] hello send failed", err);
		}
	};

	ws.onmessage = async (event) => {
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
			return;
		}
		if (msg.kind === "call") {
			// Forward RPC call to SW for dispatch (plan 04/05 fill bodies)
			try {
				const result = await chrome.runtime.sendMessage({
					kind: "call",
					id: msg.id,
					tool: msg.tool,
					args: msg.args,
				});
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(JSON.stringify(result ?? { id: msg.id, kind: "result", error: "no-sw-response" }));
				}
			} catch (err) {
				if (ws && ws.readyState === WebSocket.OPEN) {
					ws.send(
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

	ws.onerror = (event) => {
		console.warn("[tek] WS error", event);
	};

	ws.onclose = (event) => {
		console.log("[tek] WS close", event.code, event.reason);
		ws = null;
		// 4401 = unauthorized (bad/missing token). Still reconnect — user may paste a new token.
		const closeReason = event.code === 4401 ? "unauthorized" : "closed";
		setState("disconnected", closeReason);
		scheduleReconnect();
	};
}

async function setToken(tokenValue) {
	// CONTEXT D-12: persist as auth.token object shape
	await chrome.storage.local.set({ auth: { token: tokenValue } });
	attempt = 0; // reset backoff — user just fixed auth
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	connect();
}

async function reset() {
	attempt = 0;
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	if (ws) {
		try {
			ws.close();
		} catch {
			// ignore
		}
		ws = null;
	}
	// Immediately reconnect — will short-circuit to no-token if none saved.
	connect();
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind === "set-token" && typeof msg.token === "string") {
		setToken(msg.token).then(() => sendResponse({ ok: true }));
		return true;
	}
	if (msg.kind === "reset") {
		reset().then(() => sendResponse({ ok: true }));
		return true;
	}
	if (msg.kind === "status") {
		sendResponse({ kind: "status", ...currentStatus() });
		return true;
	}
	return undefined;
});

// Kick off initial connection attempt.
connect();
