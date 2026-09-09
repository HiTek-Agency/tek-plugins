/**
 * Tek Chrome Control — popup UI.
 * Talks to the offscreen document (via runtime messages) to read connection
 * status, save a pairing token, and reset state.
 */

const dotEl = document.getElementById("status-dot");
const statusTextEl = document.getElementById("status-text");
document.getElementById("extension-version").textContent = chrome.runtime.getManifest().version;
const gatewayVersionEl = document.getElementById("gateway-version");
const tokenSection = document.getElementById("token-section");
const tokenInput = document.getElementById("token-input");
const saveBtn = document.getElementById("save-token");
const resetBtn = document.getElementById("reset-connection");
const controlSummaryEl = document.getElementById("control-summary");
const controlBadgeEl = document.getElementById("control-badge");
const activeTabTitleEl = document.getElementById("active-tab-title");
const activeTabUrlEl = document.getElementById("active-tab-url");
const grantTabBtn = document.getElementById("grant-tab");
const revokeTabBtn = document.getElementById("revoke-tab");
const toggleControlBtn = document.getElementById("toggle-control");

let pollTimer = null;
let controlStatus = { paused: true, grantedTabCount: 0, activeTab: null };

function renderStatus(status) {
	const connected = status?.connected === true;
	const state = status?.state ?? (connected ? "connected" : "disconnected");
	const reason = status?.reason ?? "unknown";

	dotEl.classList.remove(
		"dot-connected",
		"dot-connecting",
		"dot-disconnected",
		"connected",
		"connecting",
		"disconnected",
	);

	if (connected || state === "connected") {
		dotEl.classList.add("dot-connected", "connected");
		statusTextEl.textContent = "Connected";
		statusTextEl.className = "connected";
		tokenSection.hidden = true;
	} else if (state === "connecting" || reason === "connecting" || reason === "starting") {
		dotEl.classList.add("dot-connecting", "connecting");
		statusTextEl.textContent = "Connecting…";
		statusTextEl.className = "connecting";
		// Keep token row hidden mid-attempt if we already have a token (reason !== "no-token")
		tokenSection.hidden = reason !== "no-token";
	} else if (reason === "no-token") {
		dotEl.classList.add("dot-disconnected", "disconnected");
		statusTextEl.textContent = "Not connected — paste token";
		statusTextEl.className = "disconnected";
		tokenSection.hidden = false;
	} else if (reason === "unauthorized") {
		dotEl.classList.add("dot-disconnected", "disconnected");
		statusTextEl.textContent = "Not connected — bad token";
		statusTextEl.className = "disconnected";
		tokenSection.hidden = false;
	} else {
		dotEl.classList.add("dot-disconnected", "disconnected");
		statusTextEl.textContent = `Not connected (${reason})`;
		statusTextEl.className = "disconnected";
		tokenSection.hidden = false;
	}

	if (status?.gatewayVersion) {
		gatewayVersionEl.textContent = status.gatewayVersion;
	}
}

function safeHostname(rawUrl) {
	try {
		return new URL(rawUrl).hostname || rawUrl;
	} catch {
		return rawUrl || "No URL";
	}
}

function renderControl(status) {
	if (!status?.ok) {
		controlSummaryEl.textContent = status?.error ?? "Control status unavailable";
		activeTabTitleEl.textContent = "No active tab";
		activeTabUrlEl.textContent = "";
		grantTabBtn.disabled = true;
		revokeTabBtn.disabled = true;
		toggleControlBtn.disabled = true;
		return;
	}

	controlStatus = status;
	const paused = status.paused === true;
	const grantedCount = Number(status.grantedTabCount) || 0;
	const activeTab = status.activeTab;

	controlBadgeEl.textContent = paused ? "Paused" : "Agents active";
	controlBadgeEl.className = `control-badge ${paused ? "paused" : "active"}`;
	controlSummaryEl.textContent = `${paused ? "Paused" : "Active"} · ${grantedCount} ${grantedCount === 1 ? "tab" : "tabs"} granted`;

	activeTabTitleEl.textContent = activeTab?.title || "No active tab";
	activeTabUrlEl.textContent = safeHostname(activeTab?.url);
	const isInternal = /^(chrome|chrome-extension|devtools):/i.test(activeTab?.url ?? "");
	grantTabBtn.disabled = !activeTab?.id || activeTab.allowed === true || isInternal;
	revokeTabBtn.disabled = !activeTab?.id || activeTab.allowed !== true;
	toggleControlBtn.disabled = false;
	toggleControlBtn.textContent = paused ? "Resume agents" : "Take over";
	toggleControlBtn.className = paused ? "resume" : "takeover";
}

async function queryStatus() {
	const [connection, control] = await Promise.allSettled([
		chrome.runtime.sendMessage({ kind: "status" }),
		chrome.runtime.sendMessage({ kind: "get-control-status" }),
	]);
	if (connection.status === "fulfilled" && connection.value) {
		renderStatus(connection.value);
	} else {
		renderStatus({ connected: false, state: "disconnected", reason: "no-offscreen" });
	}
	if (control.status === "fulfilled" && control.value) {
		renderControl(control.value);
	} else {
		renderControl({ ok: false, error: "Control status unavailable" });
	}
}

async function updateControl(message, button) {
	button.disabled = true;
	try {
		const response = await chrome.runtime.sendMessage(message);
		renderControl(response);
	} catch (err) {
		renderControl({ ok: false, error: String(err?.message ?? err) });
	} finally {
		setTimeout(queryStatus, 150);
	}
}

grantTabBtn.addEventListener("click", () => {
	updateControl({ kind: "grant-active-tab" }, grantTabBtn);
});

revokeTabBtn.addEventListener("click", () => {
	updateControl({ kind: "revoke-active-tab" }, revokeTabBtn);
});

toggleControlBtn.addEventListener("click", () => {
	updateControl(
		{ kind: "set-control-paused", paused: controlStatus.paused !== true },
		toggleControlBtn,
	);
});

saveBtn.addEventListener("click", async () => {
	const token = tokenInput.value.trim();
	if (!token) return;
	saveBtn.disabled = true;
	try {
		const result = await chrome.runtime.sendMessage({ kind: "set-token", token });
		if (!result?.ok) throw new Error(result?.error ?? "Pairing failed");
	} catch (err) {
		statusTextEl.textContent = err.message ?? "Pairing failed";
	} finally {
		setTimeout(() => {
			saveBtn.disabled = false;
			queryStatus();
		}, 800);
	}
});

resetBtn.addEventListener("click", async () => {
	try {
		await chrome.runtime.sendMessage({ kind: "reset-auth" });
	} catch (err) {
		console.warn("[tek] reset failed", err);
	}
	tokenInput.value = "";
	setTimeout(queryStatus, 200);
});

// Initial + periodic status poll while popup is open.
queryStatus();
pollTimer = setInterval(queryStatus, 2000);

window.addEventListener("beforeunload", () => {
	if (pollTimer) clearInterval(pollTimer);
});
