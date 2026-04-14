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
const SCREENSHOT_DIR = join(
	homedir(),
	".config",
	"tek",
	"plugins",
	"chrome",
	"data",
	"screenshots",
);
mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

	// Plan 04: tight schemas for the four navigation/read tools.
	ctx.addTool("tabs_list", {
		description:
			"List all open Chrome tabs across all windows. Returns array of { id, url, title, active, windowId }. Useful for finding the right tab before navigating or reading.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		execute: () => _rpc("tabs_list", {}),
	});

	ctx.addTool("tabs_create", {
		description:
			"Open a new Chrome tab. Returns { id, url, windowId }.",
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description:
						"URL to open (must include scheme, e.g. https://)",
				},
				active: {
					type: "boolean",
					description:
						"Whether the new tab should become active. Default true.",
					default: true,
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
		execute: (args) => _rpc("tabs_create", args),
	});

	ctx.addTool("navigate", {
		description:
			"Navigate a tab to a URL and wait for load to complete. Returns { tabId, url, title }.",
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "Target URL (must include scheme)",
				},
				tabId: {
					type: "number",
					description:
						"Tab to navigate. Defaults to active tab in current window.",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
		execute: (args) => _rpc("navigate", args),
	});

	ctx.addTool("read_page", {
		description:
			"Read a tab's visible text and pruned accessibility tree. Returns { text, axTree, truncated, totalNodes }. axTree nodes have axNodeId usable with chrome__find / chrome__click. text is innerText (max 50 KB).",
		parameters: {
			type: "object",
			properties: {
				tabId: {
					type: "number",
					description: "Tab to read. Defaults to active tab.",
				},
			},
			additionalProperties: false,
		},
		execute: (args) => _rpc("read_page", args),
	});

	// Plan 05: explicit schemas for find / click / form_input / screenshot / javascript_tool.
	ctx.addTool("find", {
		description:
			"Find elements on a page by CSS selector OR accessibility query (text + optional role). Returns { matches: [{ axNodeId, role, name, boundingBox }] } capped at 50. Prefer query+role for natural-language lookups; use selector for precision.",
		parameters: {
			type: "object",
			properties: {
				tabId: { type: "number", description: "Target tab. Defaults to active tab." },
				selector: { type: "string", description: "CSS selector (mutually exclusive with query)" },
				query: {
					type: "string",
					description: "Case-insensitive substring of the accessible name",
				},
				role: {
					type: "string",
					description:
						"ARIA role filter used with query (e.g. 'button', 'link', 'textbox')",
				},
			},
			additionalProperties: false,
		},
		execute: (args) => _rpc("find", args ?? {}),
	});

	ctx.addTool("click", {
		description:
			"Click an element. Pass either selector OR axNodeId (from chrome__find / chrome__read_page). Returns { ok, reason?, x, y }. Uses trusted CDP Input events so event.isTrusted checks pass.",
		parameters: {
			type: "object",
			properties: {
				tabId: { type: "number", description: "Target tab. Defaults to active tab." },
				selector: { type: "string" },
				axNodeId: {
					type: "number",
					description: "backendDOMNodeId returned by chrome__find or chrome__read_page",
				},
			},
			additionalProperties: false,
		},
		execute: (args) => _rpc("click", args ?? {}),
	});

	ctx.addTool("form_input", {
		description:
			"Type text into an input. Focuses the element first by clicking (same selector/axNodeId semantics as chrome__click). Returns { ok, reason? }.",
		parameters: {
			type: "object",
			properties: {
				tabId: { type: "number" },
				selector: { type: "string" },
				axNodeId: { type: "number" },
				text: { type: "string", description: "Text to insert" },
				clear: {
					type: "boolean",
					description: "If true, select-all + delete before inserting",
					default: false,
				},
			},
			required: ["text"],
			additionalProperties: false,
		},
		execute: (args) => _rpc("form_input", args ?? {}),
	});

	ctx.addTool("screenshot", {
		description:
			"Capture a PNG screenshot of a tab's visible viewport. The image renders inline in chat via the image.generated side-channel; the tool result contains ONLY { path, width, height } — no base64 — so it won't blow up LLM context.",
		parameters: {
			type: "object",
			properties: {
				tabId: { type: "number", description: "Target tab. Defaults to active tab." },
				maxWidth: {
					type: "number",
					description:
						"Downscale to at most this width before save (default: plugin cfg.screenshotMaxWidth or 1920)",
				},
			},
			additionalProperties: false,
		},
		// Vercel AI SDK invokes plugin tools directly with (args, execOptions).
		// execOptions.toolCallId is mandatory per the AI SDK contract and is what
		// correlates the image.generated side-channel to the inline placeholder.
		// Precedent: packages/gateway/src/tools/generate-image.ts (lines 101+169).
		execute: async (args, execOptions) => {
			const maxWidth = Number(args?.maxWidth) || Number(cfg.screenshotMaxWidth) || 1920;
			const result = await _rpc("screenshot", { ...(args ?? {}), maxWidth }, 60_000);
			const ts = Date.now();
			const filename = `chrome-${ts}.png`;
			const fullPath = join(SCREENSHOT_DIR, filename);
			writeFileSync(fullPath, Buffer.from(result.base64, "base64"));
			const toolCallId = execOptions?.toolCallId || `chrome-screenshot-${ts}`;
			try {
				ctx.send?.({
					kind: "image.generated",
					toolCallId,
					path: fullPath,
					thumbnailBase64: result.base64,
					width: result.width,
					height: result.height,
					prompt: `Chrome screenshot (tab ${args?.tabId ?? "active"})`,
				});
			} catch (e) {
				ctx.logger?.warn?.(
					`chrome-control: failed to emit image.generated: ${e?.message ?? e}`,
				);
			}
			// NEVER include base64 in the tool result (CONTEXT: image data must not enter LLM results)
			return { path: fullPath, width: result.width, height: result.height };
		},
	});

	ctx.addTool(
		"javascript_tool",
		{
			description:
				"Evaluate a JavaScript expression in the page's MAIN world. Returns { value, type, subtype } on success or { error: { name, message, stack } } on exception. DANGEROUS — every call requires user approval.",
			parameters: {
				type: "object",
				properties: {
					tabId: { type: "number" },
					expression: {
						type: "string",
						description: "JavaScript expression to evaluate (await supported)",
					},
				},
				required: ["expression"],
				additionalProperties: false,
			},
			execute: (args) => _rpc("javascript_tool", args ?? {}, 30_000),
		},
		{ approvalTier: "always" },
	);

	// WS handler for desktop → gateway status polling. Plan 06 will poll this.
	// Note: plugin WS handlers are namespaced as plugin.{pluginId}.{type}, so this
	// registers as "plugin.chrome.status". Desktop (Plan 06) should send
	// type "plugin.chrome.status" to receive { connected, lastHandshakeAt, port }.
	// The logical name is chrome.status (W3: desktop Installed & connected badge).
	// Echoes requestId back for desktop RPC correlation (Plan 06 gateway-rpc pattern).
	const statusHandler = async (msg) => {
		const m = msg && typeof msg === "object" ? msg : {};
		return {
			type: "plugin.chrome.status.result",
			id: m.id,
			requestId: m.id,
			connected: _sock !== null && _lastHandshakeAt !== null,
			lastHandshakeAt: _lastHandshakeAt,
			port,
		};
	};
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
