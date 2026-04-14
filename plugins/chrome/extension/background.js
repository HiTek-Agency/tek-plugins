/**
 * Tek Chrome Control — background service worker (MV3).
 *
 * Responsibilities:
 *   - Keep an offscreen document alive that hosts the persistent WebSocket
 *     connection to the Tek gateway (service workers are killed aggressively,
 *     so we delegate the long-lived socket to an offscreen doc).
 *   - Use chrome.alarms as a keepalive ping so that if the SW is woken up, we
 *     re-ensure the offscreen doc exists.
 *   - Receive RPC dispatch requests from the offscreen doc (kind: "call") and,
 *     in future plans, execute them against chrome.debugger / chrome.tabs /
 *     chrome.scripting. For plan 02 this is a stub that returns "not implemented".
 *
 * Full dispatch table lands in plans 04/05.
 */

const OFFSCREEN_URL = "offscreen.html";

async function hasOffscreenDoc() {
	// chrome.offscreen.hasDocument is a newer API — fall back to matching contexts.
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

// RPC dispatch — offscreen asks background to run a Chrome API call. Plan 02 is stub.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind !== "call") return;
	// Dispatch table is empty in plan 02 — respond with not-implemented.
	sendResponse({
		id: msg.id,
		kind: "result",
		error: "not implemented (plan 04/05)",
	});
	return true;
});

// Cleanup on debugger detach (will matter in plan 04 when we attach for clicks/nav).
if (chrome.debugger?.onDetach) {
	chrome.debugger.onDetach.addListener((source, reason) => {
		console.log("[tek] debugger detached:", source, reason);
	});
}
