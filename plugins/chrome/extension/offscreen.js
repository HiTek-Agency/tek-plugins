/**
 * Tek Chrome Control — offscreen document.
 *
 * Hosts the persistent WebSocket connection to the Tek gateway on
 * ws://127.0.0.1:<port>/?token=<token>. The token MUST be passed via the URL
 * query string — the browser WebSocket constructor does NOT accept custom
 * request metadata beyond the URL and sub-protocols; options objects are a
 * Node-ws extension only and are not available in MV3 service workers /
 * offscreen docs.
 *
 * Plan 02 responsibilities:
 *   - Read token + port from chrome.storage.local
 *   - If token present: attempt connect; on close, exponential-backoff reconnect
 *   - If missing: broadcast status { connected: false, reason: "no-token" }
 *   - Accept { kind: "set-token" } / { kind: "reset" } / { kind: "status" } from popup
 *
 * Plan 03 replaces this stub with a full handshake + ping/pong + resume logic.
 */

const DEFAULT_PORT = 52871;
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** @type {WebSocket | null} */
let ws = null;
let backoff = MIN_BACKOFF_MS;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let status = { connected: false, reason: "starting" };

async function loadAuth() {
	const { auth, wsPort } = await chrome.storage.local.get(["auth", "wsPort"]);
	return {
		token: typeof auth === "string" ? auth : auth?.token ?? null,
		port: typeof wsPort === "number" && wsPort > 0 ? wsPort : DEFAULT_PORT,
	};
}

function broadcastStatus(next) {
	status = { ...status, ...next };
	try {
		chrome.runtime.sendMessage({ kind: "status", ...status }).catch(() => {});
	} catch {
		// popup may not be open — ignore
	}
}

function scheduleReconnect() {
	if (reconnectTimer) clearTimeout(reconnectTimer);
	reconnectTimer = setTimeout(() => {
		reconnectTimer = null;
		connect();
	}, backoff);
	backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
}

async function connect() {
	const { token, port } = await loadAuth();
	if (!token) {
		broadcastStatus({ connected: false, reason: "no-token" });
		return;
	}

	// Clean up any prior socket.
	if (ws) {
		try {
			ws.close();
		} catch {
			// ignore
		}
		ws = null;
	}

	const url = `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
	broadcastStatus({ connected: false, reason: "connecting" });

	try {
		ws = new WebSocket(url);
	} catch (err) {
		console.warn("[tek] WS construct failed", err);
		broadcastStatus({ connected: false, reason: "connect-error" });
		scheduleReconnect();
		return;
	}

	ws.onopen = () => {
		console.log("[tek] WS open", url);
		backoff = MIN_BACKOFF_MS;
		broadcastStatus({ connected: true, reason: "open" });
	};

	ws.onmessage = (event) => {
		// Plan 03+ will parse and dispatch handshake + RPC messages.
		console.log("[tek] WS message", event.data);
	};

	ws.onerror = (event) => {
		console.warn("[tek] WS error", event);
	};

	ws.onclose = (event) => {
		console.log("[tek] WS close", event.code, event.reason);
		ws = null;
		broadcastStatus({ connected: false, reason: "closed" });
		scheduleReconnect();
	};
}

async function setToken(token) {
	await chrome.storage.local.set({ auth: token });
	backoff = MIN_BACKOFF_MS;
	if (reconnectTimer) {
		clearTimeout(reconnectTimer);
		reconnectTimer = null;
	}
	connect();
}

async function reset() {
	await chrome.storage.local.remove(["auth"]);
	if (ws) {
		try {
			ws.close();
		} catch {
			// ignore
		}
		ws = null;
	}
	broadcastStatus({ connected: false, reason: "no-token" });
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
		sendResponse({ kind: "status", ...status });
		return true;
	}
	return undefined;
});

// Kick off initial connection attempt.
connect();
