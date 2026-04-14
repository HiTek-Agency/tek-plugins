/**
 * Tek Chrome Control — background service worker (MV3).
 *
 * Responsibilities:
 *   - Keep an offscreen document alive that hosts the persistent WebSocket
 *     connection to the Tek gateway (SWs are killed aggressively, so the
 *     long-lived socket lives in the offscreen doc).
 *   - chrome.alarms keepalive ping — if SW wakes, re-ensure offscreen doc.
 *   - Dispatch RPC requests from the offscreen doc (kind: "call") — plans
 *     04/05 will fill the per-tool cases. Plan 03 keeps the routing scaffold
 *     so tool branches slot in cleanly.
 */

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

/**
 * Tool dispatch — offscreen asks background to run a Chrome API call.
 * Plan 03: routing scaffold + per-tool stubs. Plans 04/05 replace each case body.
 */
async function dispatchTool(tool, _args) {
	switch (tool) {
		case "tabs_list":
		case "tabs_create":
		case "navigate":
		case "read_page":
		case "find":
		case "click":
		case "form_input":
		case "screenshot":
		case "javascript_tool":
			return { error: `tool not implemented (plan 04/05): ${tool}` };
		default:
			return { error: `unknown tool: ${tool}` };
	}
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind !== "call") return;
	// Return a { id, kind: "result", error | result } envelope matching gateway protocol.
	dispatchTool(msg.tool, msg.args)
		.then((outcome) => {
			const envelope = { id: msg.id, kind: "result" };
			if ("error" in outcome) envelope.error = outcome.error;
			else envelope.result = outcome.result;
			sendResponse(envelope);
		})
		.catch((err) => {
			sendResponse({
				id: msg.id,
				kind: "result",
				error: String(err?.message || err),
			});
		});
	return true;
});

// Cleanup on debugger detach (will matter in plan 04 when we attach for clicks/nav).
if (chrome.debugger?.onDetach) {
	chrome.debugger.onDetach.addListener((source, reason) => {
		console.log("[tek] debugger detached:", source, reason);
	});
}
