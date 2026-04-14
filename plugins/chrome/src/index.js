/**
 * Chrome Control Plugin — drives your real Chrome browser via a local MV3 extension
 * over a loopback WebSocket. The gateway-side plugin owns the WS server, authenticates
 * the extension handshake, and exposes chrome__* tools that proxy RPCs through to the
 * extension's offscreen document (which uses chrome.debugger / scripting / tabs APIs).
 *
 * Plan 03 — WS server + pairing handshake (this file)
 * Plan 04 — tabs/navigation/read/find/click/type tools
 * Plan 05 — screenshot + javascript_tool
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

const TOKEN_PATH = join(homedir(), ".config", "tek", "chrome-control.token");
const META_PATH = join(homedir(), ".config", "tek", "chrome-control.json");

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

function isLoopback(addr) {
	return (
		addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1"
	);
}

/**
 * Pure connection-check logic — exported for unit testing without a live WS server.
 * Enforces loopback origin + token equality. Returns { ok } on success or
 * { ok: false, code, reason } on rejection.
 */
export function checkConnection(remoteAddress, urlString, expectedToken) {
	if (!isLoopback(remoteAddress)) {
		return { ok: false, code: 403, reason: "non-loopback" };
	}
	let token = null;
	try {
		const u = new URL(urlString, "http://127.0.0.1");
		token = u.searchParams.get("token");
	} catch {
		// fall through — token stays null
	}
	if (!token || token !== expectedToken) {
		return { ok: false, code: 401, reason: "unauthorized" };
	}
	return { ok: true };
}

// Module-level state for cleanup + RPC tracking
let _wss = null;
let _sock = null;
let _lastHandshakeAt = null; // ms timestamp — updated on every inbound message
const _pending = new Map();
let _seq = 0;

export function _getActiveSocket() {
	return _sock;
}

export function _rpc(tool, args, timeoutMs = 30_000) {
	if (!_sock)
		return Promise.reject(new Error("chrome extension not connected"));
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
		});
	});
}

export async function register(ctx) {
	const cfg = ctx.getConfig?.() ?? {};
	const port = Number(cfg.wsPort) || 52871;
	const token = getOrCreateToken();

	// Persist { port, token } for desktop UI to display (plan 06 reads this)
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
			const result = checkConnection(
				info.req.socket.remoteAddress,
				info.req.url,
				token,
			);
			if (!result.ok) {
				ctx.logger?.warn?.(
					`chrome-control rejected connection: ${result.reason} from ${info.req.socket.remoteAddress}`,
				);
				return cb(false, result.code, result.reason);
			}
			cb(true);
		},
	});

	_wss.on("connection", (ws) => {
		_sock = ws;
		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(raw.toString());
			} catch {
				return;
			}
			_lastHandshakeAt = Date.now(); // any inbound message counts as "alive"
			if (msg.kind === "hello") {
				ctx.logger?.info?.(
					`chrome-control connected: ext=${msg.extensionId} v${msg.version} chrome=${msg.chromeVersion} caps=[${(msg.capabilities || []).join(",")}]`,
				);
				ws.send(
					JSON.stringify({
						kind: "welcome",
						gatewayVersion: process.env.TEK_VERSION || "dev",
						serverTime: Date.now(),
					}),
				);
				return;
			}
			if (msg.kind === "result") {
				const p = _pending.get(msg.id);
				if (p) {
					_pending.delete(msg.id);
					if (msg.error) p.reject(new Error(msg.error));
					else p.resolve(msg.result);
				}
			}
		});
		ws.on("close", () => {
			if (_sock === ws) {
				_sock = null;
				_lastHandshakeAt = null;
			}
		});
	});

	ctx.logger?.info?.(
		`chrome-control listening on ws://127.0.0.1:${port} (token at ~/.config/tek/chrome-control.token)`,
	);

	// Register all 9 tool stubs that pipe through _rpc — schemas tightened in plans 04/05
	const TOOLS = [
		"tabs_list",
		"tabs_create",
		"navigate",
		"read_page",
		"find",
		"click",
		"form_input",
		"screenshot",
		"javascript_tool",
	];
	for (const t of TOOLS) {
		const opts =
			t === "javascript_tool" ? { approvalTier: "always" } : undefined;
		const timeout = t === "screenshot" ? 60_000 : 30_000;
		ctx.addTool(
			t,
			{
				description: `chrome ${t} (full schema in plans 04/05)`,
				parameters: {
					type: "object",
					properties: {},
					additionalProperties: true,
				},
				execute: (args) => _rpc(t, args ?? {}, timeout),
			},
			opts,
		);
	}

	// WS handler for desktop → gateway status polling. Plan 06 will poll this.
	// Note: plugin WS handlers are namespaced as plugin.{pluginId}.{type}, so this
	// registers as "plugin.chrome.status". Desktop (Plan 06) should send
	// type "plugin.chrome.status" to receive { connected, lastHandshakeAt, port }.
	// The logical name is chrome.status (W3: desktop Installed & connected badge).
	const statusHandler = async () => ({
		connected: _sock !== null && _lastHandshakeAt !== null,
		lastHandshakeAt: _lastHandshakeAt,
		port,
	});
	if (typeof ctx.addWsHandler === "function") {
		// Namespaced to plugin.chrome.status by sandbox — see comment above.
		ctx.addWsHandler("status", statusHandler);
	} else if (typeof ctx.registerWsHandler === "function") {
		// Fallback for hypothetical non-namespaced API — chrome.status handler name.
		ctx.registerWsHandler("chrome.status", statusHandler);
	} else {
		ctx.logger?.warn?.(
			"ctx.addWsHandler unavailable — desktop status poll (chrome.status) will be disabled",
		);
	}
}

export async function cleanup() {
	if (_wss) {
		try {
			_wss.close();
		} catch {
			// ignore
		}
		_wss = null;
	}
	_sock = null;
	_lastHandshakeAt = null;
	_pending.clear();
}
