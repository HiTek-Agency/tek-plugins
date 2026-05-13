/**
 * Tek Chrome Control — background service worker (MV3).
 *
 * Responsibilities:
 *   - Keep an offscreen document alive that hosts the persistent WebSocket
 *     connection to the Tek gateway (SWs are killed aggressively, so the
 *     long-lived socket lives in the offscreen doc).
 *   - chrome.alarms keepalive ping — if SW wakes, re-ensure offscreen doc.
 *   - Dispatch RPC requests from the offscreen doc (kind: "call") to per-tool
 *     handlers. Plan 04 implements tabs_list, tabs_create, navigate, read_page
 *     using chrome.tabs.* and chrome.debugger CDP (Accessibility.getFullAXTree).
 *     Plan 05 will fill find/click/form_input/screenshot/javascript_tool.
 */

import { pruneAxTree } from "./ax-prune.js";

const OFFSCREEN_URL = "offscreen.html";

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
	try {
		if (await hasOffscreenDoc()) return;
		await chrome.offscreen.createDocument({
			url: OFFSCREEN_URL,
			reasons: ["WORKERS"],
			justification: "Host persistent WebSocket to Tek gateway",
		});
	} catch (err) {
		// Creating when one already exists throws — treat as success.
		if (!String(err?.message || err).includes("Only a single offscreen")) {
			console.warn("[tek] ensureOffscreen failed:", err);
		}
	}
}

chrome.runtime.onInstalled.addListener(() => {
	ensureOffscreen();
	chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
});

chrome.runtime.onStartup.addListener(() => {
	ensureOffscreen();
	chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
});

chrome.alarms.onAlarm.addListener((alarm) => {
	if (alarm.name === "keepalive") {
		ensureOffscreen();
	}
});

/* ---------------- CDP attach lifecycle ---------------- */

const attached = new Map(); // tabId -> { domains: string[] }

async function ensureAttached(tabId) {
	if (attached.has(tabId)) return;
	await chrome.debugger.attach({ tabId }, "1.3");
	const target = { tabId };
	await chrome.debugger.sendCommand(target, "Page.enable");
	await chrome.debugger.sendCommand(target, "DOM.enable");
	await chrome.debugger.sendCommand(target, "Runtime.enable");
	await chrome.debugger.sendCommand(target, "Accessibility.enable");
	// Input domain is required for dispatchMouseEvent / insertText / dispatchKeyEvent
	try {
		await chrome.debugger.sendCommand(target, "Input.enable");
	} catch {
		// Input.enable may not exist in all protocol versions; commands still work.
	}
	attached.set(tabId, { domains: ["Page", "DOM", "Runtime", "Accessibility", "Input"] });
}

chrome.tabs.onRemoved.addListener((tabId) => {
	if (attached.has(tabId)) {
		chrome.debugger.detach({ tabId }).catch(() => {});
		attached.delete(tabId);
	}
	mainWorldContexts.delete(tabId);
});

if (chrome.debugger?.onDetach) {
	chrome.debugger.onDetach.addListener((source, reason) => {
		console.log("[tek] debugger detached:", source, reason);
		if (source.tabId) {
			attached.delete(source.tabId);
			mainWorldContexts.delete(source.tabId);
		}
	});
}

/* ---------------- main-world execution context tracking ----------------
 * Runtime.evaluate without a contextId targets an arbitrary default — for
 * reliable main-world access we capture the contextId of the top-frame
 * default (isolated=false, auxData.isDefault=true) via executionContextCreated
 * events. Falls back to omitting contextId when we haven't seen one yet.
 */
const mainWorldContexts = new Map(); // tabId -> contextId (number)

if (chrome.debugger?.onEvent) {
	chrome.debugger.onEvent.addListener((source, method, params) => {
		if (!source?.tabId) return;
		if (method === "Runtime.executionContextCreated") {
			if (params?.context?.auxData?.isDefault === true) {
				mainWorldContexts.set(source.tabId, params.context.id);
			}
		} else if (method === "Runtime.executionContextDestroyed") {
			if (mainWorldContexts.get(source.tabId) === params?.executionContextId) {
				mainWorldContexts.delete(source.tabId);
			}
		} else if (method === "Runtime.executionContextsCleared") {
			mainWorldContexts.delete(source.tabId);
		}
	});
}

/* ---------------- tool helpers ---------------- */

/**
 * Capture a fresh page snapshot (pruned AX tree + innerText) after a settle delay.
 * Used by click/form_input/form_fill to return the post-action state in one
 * round trip — the agent doesn't need to immediately call read_page after every
 * interaction. Returns the same shape as read_page.
 */
async function capturePageDelta(tabId, settleMs = 250, includeText = false) {
	await new Promise((r) => setTimeout(r, settleMs));
	const target = { tabId };
	const ax = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree", {});
	const pruned = pruneAxTree(ax?.nodes || []);
	const out = {
		axTree: pruned.axTree,
		truncated: pruned.truncated,
		totalNodes: pruned.totalNodes,
	};
	if (includeText) {
		const evalRes = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
			expression: "document.body ? document.body.innerText : ''",
			returnByValue: true,
		});
		out.text = String(evalRes?.result?.value ?? "")
			.replace(/\s+\n/g, "\n")
			.trim()
			.slice(0, 50000);
	}
	return out;
}

async function resolveTabId(args) {
	if (typeof args?.tabId === "number") return args.tabId;
	const [tab] = await chrome.tabs.query({
		active: true,
		currentWindow: true,
	});
	if (!tab) throw new Error("no active tab");
	return tab.id;
}

async function waitForLoad(tabId, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			chrome.tabs.onUpdated.removeListener(listener);
			reject(new Error("navigation timed out"));
		}, timeoutMs);
		const listener = (id, info) => {
			if (id === tabId && info.status === "complete") {
				clearTimeout(timer);
				chrome.tabs.onUpdated.removeListener(listener);
				resolve();
			}
		};
		chrome.tabs.onUpdated.addListener(listener);
	});
}

/* ---------------- tool handlers ---------------- */

const TOOL_HANDLERS = {
	tabs_list: async () => {
		const tabs = await chrome.tabs.query({});
		return tabs.map((t) => ({
			id: t.id,
			url: t.url,
			title: t.title,
			active: t.active,
			windowId: t.windowId,
		}));
	},
	tabs_create: async ({ url, active = true } = {}) => {
		if (typeof url !== "string") throw new Error("url required");
		const tab = await chrome.tabs.create({ url, active });
		return { id: tab.id, url: tab.url, windowId: tab.windowId };
	},
	navigate: async (args = {}) => {
		const tabId = await resolveTabId(args);
		if (typeof args.url !== "string") throw new Error("url required");
		await chrome.tabs.update(tabId, { url: args.url });
		await waitForLoad(tabId);
		const tab = await chrome.tabs.get(tabId);
		return { tabId, url: tab.url, title: tab.title };
	},
	read_page: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		const target = { tabId };
		const ax = await chrome.debugger.sendCommand(
			target,
			"Accessibility.getFullAXTree",
			{},
		);
		const pruned = pruneAxTree(ax?.nodes || []);
		const evalRes = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
			expression: "document.body ? document.body.innerText : ''",
			returnByValue: true,
		});
		const text = String(evalRes?.result?.value ?? "")
			.replace(/\s+\n/g, "\n")
			.trim();
		return {
			text: text.slice(0, 50000),
			axTree: pruned.axTree,
			truncated: pruned.truncated,
			totalNodes: pruned.totalNodes,
		};
	},
	find: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		const target = { tabId };
		let matches = [];
		if (typeof args.selector === "string" && args.selector.length > 0) {
			const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
				expression: `(() => {
					const els = document.querySelectorAll(${JSON.stringify(args.selector)});
					return Array.from(els).slice(0, 50).map((el) => {
						const r = el.getBoundingClientRect();
						return {
							axNodeId: null,
							role: el.getAttribute("role") || el.tagName.toLowerCase(),
							name: (el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 100),
							boundingBox: { x: r.x, y: r.y, w: r.width, h: r.height },
						};
					});
				})()`,
				returnByValue: true,
			});
			matches = result?.value ?? [];
		} else {
			// Query mode: walk AX tree for name substring + optional role filter
			const ax = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree", {});
			const q = String(args.query || "").toLowerCase();
			const roleFilter = args.role;
			matches = (ax?.nodes || [])
				.filter((n) => {
					const nameValue = (n.name?.value || "").toLowerCase();
					if (roleFilter && n.role?.value !== roleFilter) return false;
					return q ? nameValue.includes(q) : Boolean(nameValue);
				})
				.slice(0, 50)
				.map((n) => ({
					axNodeId: n.nodeId,
					backendDOMNodeId: n.backendDOMNodeId,
					role: n.role?.value,
					name: n.name?.value,
					boundingBox: null,
				}));
		}

		// Auto-click shortcut: if the agent passed `click: true` and there is
		// exactly one match, click it in the same round trip and return the
		// post-action page state. This collapses the find→click pattern.
		if (args.click === true) {
			if (matches.length === 0) {
				return { matches, clicked: { ok: false, reason: "no-match" } };
			}
			if (matches.length > 1) {
				return {
					matches,
					clicked: { ok: false, reason: `ambiguous-${matches.length}-matches` },
				};
			}
			const only = matches[0];
			const clickArgs = { tabId };
			if (only.axNodeId != null) clickArgs.axNodeId = only.axNodeId;
			else if (typeof args.selector === "string") clickArgs.selector = args.selector;
			const clickRes = await TOOL_HANDLERS.click({
				...clickArgs,
				returnPage: args.returnPage !== false,
			});
			return { matches, clicked: clickRes };
		}

		return { matches };
	},

	click: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		const target = { tabId };
		let box;
		if (args.axNodeId != null) {
			try {
				const { object } = await chrome.debugger.sendCommand(target, "DOM.resolveNode", {
					backendNodeId: args.axNodeId,
				});
				const { model } = await chrome.debugger.sendCommand(target, "DOM.getBoxModel", {
					objectId: object.objectId,
				});
				const c = model.content;
				box = { x: (c[0] + c[4]) / 2, y: (c[1] + c[5]) / 2 };
			} catch (e) {
				return { ok: false, reason: `axNodeId-resolve-failed: ${e?.message ?? e}` };
			}
		} else if (typeof args.selector === "string") {
			const { result } = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
				expression: `(() => {
					const el = document.querySelector(${JSON.stringify(args.selector)});
					if (!el) return null;
					el.scrollIntoView({ block: "center" });
					const r = el.getBoundingClientRect();
					return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
				})()`,
				returnByValue: true,
			});
			if (!result?.value) return { ok: false, reason: "selector-not-found" };
			box = result.value;
		} else {
			return { ok: false, reason: "selector-or-axNodeId-required" };
		}
		await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
			type: "mouseMoved",
			x: box.x,
			y: box.y,
		});
		await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
			type: "mousePressed",
			x: box.x,
			y: box.y,
			button: "left",
			clickCount: 1,
		});
		await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
			type: "mouseReleased",
			x: box.x,
			y: box.y,
			button: "left",
			clickCount: 1,
		});
		const result = { ok: true, x: box.x, y: box.y };
		if (args.returnPage !== false) {
			try {
				result.page = await capturePageDelta(tabId, args.settleMs ?? 250, false);
			} catch (e) {
				// Don't fail the click if AX capture stumbles — just note it.
				result.pageError = String(e?.message ?? e);
			}
		}
		return result;
	},

	form_input: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		const target = { tabId };
		if (typeof args.text !== "string") return { ok: false, reason: "text-required" };
		// Focus element first via click — skip its page capture; we'll do one at the end.
		const clickRes = await TOOL_HANDLERS.click({ ...args, tabId, returnPage: false });
		if (!clickRes.ok) return { ok: false, reason: `focus-failed: ${clickRes.reason}` };
		if (args.clear) {
			// Best-effort select-all + delete
			try {
				await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
					type: "keyDown",
					modifiers: 4, // Meta on mac, Ctrl on others — 4 maps to Ctrl
					windowsVirtualKeyCode: 65, // 'A'
					key: "a",
					commands: ["selectAll"],
				});
				await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
					type: "keyDown",
					windowsVirtualKeyCode: 46, // Delete
					key: "Delete",
				});
			} catch {
				// clear is best-effort; continue with insert
			}
		}
		await chrome.debugger.sendCommand(target, "Input.insertText", { text: args.text });
		if (args.pressEnter) {
			try {
				await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
					type: "keyDown",
					windowsVirtualKeyCode: 13,
					key: "Enter",
				});
				await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
					type: "keyUp",
					windowsVirtualKeyCode: 13,
					key: "Enter",
				});
			} catch {
				// best-effort — ignore
			}
		}
		const result = { ok: true };
		if (args.returnPage !== false) {
			try {
				result.page = await capturePageDelta(tabId, args.settleMs ?? 250, false);
			} catch (e) {
				result.pageError = String(e?.message ?? e);
			}
		}
		return result;
	},

	form_fill: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		if (!Array.isArray(args.fields) || args.fields.length === 0) {
			return { ok: false, reason: "fields-required" };
		}
		const results = [];
		for (let i = 0; i < args.fields.length; i++) {
			const f = args.fields[i] || {};
			const r = await TOOL_HANDLERS.form_input({
				tabId,
				selector: f.selector,
				axNodeId: f.axNodeId,
				text: f.text,
				clear: f.clear,
				pressEnter: f.pressEnter,
				returnPage: false, // batch capture happens at the end
			});
			results.push({ index: i, ok: !!r?.ok, reason: r?.reason });
			if (!r?.ok && args.stopOnError !== false) {
				const out = { ok: false, results, failedAt: i, reason: r?.reason };
				if (args.returnPage !== false) {
					try {
						out.page = await capturePageDelta(tabId, args.settleMs ?? 250, false);
					} catch {
						// ignore
					}
				}
				return out;
			}
		}
		// Optionally click a submit button after the last field.
		let submitted;
		if (args.submit) {
			const submitArgs = { tabId, returnPage: false };
			if (typeof args.submit === "object") {
				if (args.submit.axNodeId != null) submitArgs.axNodeId = args.submit.axNodeId;
				if (typeof args.submit.selector === "string") submitArgs.selector = args.submit.selector;
			}
			if (submitArgs.axNodeId != null || submitArgs.selector) {
				submitted = await TOOL_HANDLERS.click(submitArgs);
			} else {
				submitted = { ok: false, reason: "submit-needs-axNodeId-or-selector" };
			}
		}
		const out = { ok: true, results };
		if (submitted) out.submitted = submitted;
		if (args.returnPage !== false) {
			try {
				out.page = await capturePageDelta(tabId, args.settleMs ?? 250, false);
			} catch (e) {
				out.pageError = String(e?.message ?? e);
			}
		}
		return out;
	},

	wait_for: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		const target = { tabId };
		const timeoutMs = Math.min(Math.max(Number(args.timeout) || 5000, 100), 30000);
		const wantHidden = args.hidden === true;

		// Selector mode: poll inside the page via MutationObserver. Resolves
		// quickly when the DOM mutates, which is much cheaper than re-fetching
		// the AX tree on the SW side every poll.
		if (typeof args.selector === "string" && args.selector.length > 0) {
			const selectorJson = JSON.stringify(args.selector);
			const expression = `new Promise((resolve) => {
				const sel = ${selectorJson};
				const wantHidden = ${wantHidden};
				const isVisible = (el) => !!el && el.offsetParent !== null;
				const check = () => {
					const el = document.querySelector(sel);
					if (wantHidden) {
						if (!el || !isVisible(el)) {
							resolve({ ok: true, vanished: true });
							return true;
						}
					} else if (isVisible(el)) {
						const r = el.getBoundingClientRect();
						resolve({ ok: true, x: r.x + r.width / 2, y: r.y + r.height / 2 });
						return true;
					}
					return false;
				};
				if (check()) return;
				const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
				obs.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
				setTimeout(() => { obs.disconnect(); resolve({ ok: false, reason: "timeout" }); }, ${timeoutMs});
			})`;
			const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
				expression,
				returnByValue: true,
				awaitPromise: true,
			});
			return res?.result?.value ?? { ok: false, reason: "no-result" };
		}

		// Text mode: poll innerText on a short interval.
		if (typeof args.text === "string" && args.text.length > 0) {
			const textJson = JSON.stringify(args.text.toLowerCase());
			const expression = `new Promise((resolve) => {
				const needle = ${textJson};
				const wantHidden = ${wantHidden};
				const check = () => {
					const present = (document.body?.innerText || "").toLowerCase().includes(needle);
					if (wantHidden ? !present : present) {
						resolve({ ok: true, present });
						return true;
					}
					return false;
				};
				if (check()) return;
				const obs = new MutationObserver(() => { if (check()) obs.disconnect(); });
				obs.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
				setTimeout(() => { obs.disconnect(); resolve({ ok: false, reason: "timeout" }); }, ${timeoutMs});
			})`;
			const res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
				expression,
				returnByValue: true,
				awaitPromise: true,
			});
			return res?.result?.value ?? { ok: false, reason: "no-result" };
		}

		// AX query mode: poll the AX tree on the SW side every 250ms.
		if (typeof args.query === "string") {
			const q = args.query.toLowerCase();
			const roleFilter = args.role;
			const start = Date.now();
			while (Date.now() - start < timeoutMs) {
				const ax = await chrome.debugger.sendCommand(target, "Accessibility.getFullAXTree", {});
				const found = (ax?.nodes || []).find((n) => {
					const nameValue = (n.name?.value || "").toLowerCase();
					if (roleFilter && n.role?.value !== roleFilter) return false;
					return q ? nameValue.includes(q) : Boolean(nameValue);
				});
				const present = !!found;
				if (wantHidden ? !present : present) {
					return found
						? { ok: true, axNodeId: found.nodeId, role: found.role?.value, name: found.name?.value }
						: { ok: true, vanished: true };
				}
				await new Promise((r) => setTimeout(r, 250));
			}
			return { ok: false, reason: "timeout" };
		}

		return { ok: false, reason: "selector-text-or-query-required" };
	},

	screenshot: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		// CDP captureScreenshot runs in SW; OffscreenCanvas isn't available here, so
		// forward raw base64 to offscreen doc for downscaling.
		const { data } = await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
			format: "png",
			captureBeyondViewport: false,
		});
		const downscaled = await new Promise((resolve, reject) => {
			chrome.runtime.sendMessage(
				{ kind: "downscale", base64: data, maxWidth: args.maxWidth || 1920 },
				(resp) => {
					if (chrome.runtime.lastError) {
						return reject(new Error(chrome.runtime.lastError.message));
					}
					if (!resp) return reject(new Error("no-downscale-response"));
					if (resp.error) return reject(new Error(resp.error));
					resolve(resp);
				},
			);
		});
		return {
			base64: downscaled.base64,
			width: downscaled.width,
			height: downscaled.height,
		};
	},

	javascript_tool: async (args = {}) => {
		const tabId = await resolveTabId(args);
		await ensureAttached(tabId);
		const target = { tabId };
		if (typeof args.expression !== "string") {
			return { error: { name: "ArgError", message: "expression required", stack: "" } };
		}
		const contextId = mainWorldContexts.get(tabId);
		const params = {
			expression: args.expression,
			returnByValue: true,
			awaitPromise: true,
		};
		if (typeof contextId === "number") params.contextId = contextId;
		let res;
		try {
			res = await chrome.debugger.sendCommand(target, "Runtime.evaluate", params);
		} catch (e) {
			return {
				error: {
					name: "CDPError",
					message: String(e?.message ?? e),
					stack: "",
				},
			};
		}
		if (res?.exceptionDetails) {
			const ex = res.exceptionDetails.exception || {};
			return {
				error: {
					name: ex.className || "Error",
					message: ex.description || res.exceptionDetails.text || "evaluation failed",
					stack: res.exceptionDetails.stackTrace
						? JSON.stringify(res.exceptionDetails.stackTrace)
						: "",
				},
			};
		}
		const v = res?.result?.value;
		let serialized;
		try {
			serialized = JSON.stringify(v);
		} catch {
			serialized = String(v);
		}
		return {
			value: serialized,
			type: res?.result?.type,
			subtype: res?.result?.subtype,
		};
	},
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;

	// Storage bridge — offscreen docs (reason: WORKERS) can't use chrome.storage,
	// so the SW owns auth persistence. Also serves popup set-token/reset/get-auth.
	if (msg.kind === "get-auth") {
		chrome.storage.local.get(["auth", "wsPort"]).then((data) => {
			const token =
				typeof data.auth === "string"
					? data.auth
					: data.auth && typeof data.auth === "object"
					? data.auth.token ?? null
					: null;
			const port =
				typeof data.wsPort === "number" && data.wsPort > 0 ? data.wsPort : null;
			sendResponse({ token, port });
		});
		return true;
	}
	if (msg.kind === "set-token" && typeof msg.token === "string") {
		chrome.storage.local
			.set({ auth: { token: msg.token } })
			.then(() => {
				// Broadcast to offscreen so it can reconnect immediately.
				try {
					chrome.runtime.sendMessage({ kind: "auth-updated" }).catch(() => {});
				} catch {}
				sendResponse({ ok: true });
			})
			.catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
		return true;
	}
	if (msg.kind === "set-port" && typeof msg.port === "number") {
		chrome.storage.local
			.set({ wsPort: msg.port })
			.then(() => {
				try {
					chrome.runtime.sendMessage({ kind: "auth-updated" }).catch(() => {});
				} catch {}
				sendResponse({ ok: true });
			})
			.catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
		return true;
	}
	if (msg.kind === "reset-auth") {
		chrome.storage.local
			.remove(["auth", "wsPort"])
			.then(() => {
				try {
					chrome.runtime.sendMessage({ kind: "auth-updated" }).catch(() => {});
				} catch {}
				sendResponse({ ok: true });
			})
			.catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
		return true;
	}

	if (msg.kind !== "call") return;
	const handler = TOOL_HANDLERS[msg.tool];
	if (!handler) {
		sendResponse({
			id: msg.id,
			kind: "result",
			error: `tool not implemented: ${msg.tool}`,
		});
		return false;
	}
	Promise.resolve(handler(msg.args || {}))
		.then((result) => sendResponse({ id: msg.id, kind: "result", result }))
		.catch((err) =>
			sendResponse({
				id: msg.id,
				kind: "result",
				error: String(err?.message ?? err),
			}),
		);
	return true; // async response
});
