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
	attached.set(tabId, { domains: ["Page", "DOM", "Runtime", "Accessibility"] });
}

chrome.tabs.onRemoved.addListener((tabId) => {
	if (attached.has(tabId)) {
		chrome.debugger.detach({ tabId }).catch(() => {});
		attached.delete(tabId);
	}
});

if (chrome.debugger?.onDetach) {
	chrome.debugger.onDetach.addListener((source, reason) => {
		console.log("[tek] debugger detached:", source, reason);
		if (source.tabId) attached.delete(source.tabId);
	});
}

/* ---------------- tool helpers ---------------- */

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
	// find / click / form_input / screenshot / javascript_tool — plan 05
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind !== "call") return;
	const handler = TOOL_HANDLERS[msg.tool];
	if (!handler) {
		sendResponse({
			id: msg.id,
			kind: "result",
			error: `tool not implemented: ${msg.tool} (plan 05)`,
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
