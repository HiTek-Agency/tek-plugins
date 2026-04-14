/**
 * Tek Chrome Control — popup UI.
 * Talks to the offscreen document (via runtime messages) to read connection
 * status, save a pairing token, and reset state.
 */

const dotEl = document.getElementById("status-dot");
const statusTextEl = document.getElementById("status-text");
const gatewayVersionEl = document.getElementById("gateway-version");
const tokenSection = document.getElementById("token-section");
const tokenInput = document.getElementById("token-input");
const saveBtn = document.getElementById("save-token");
const resetBtn = document.getElementById("reset-connection");

let pollTimer = null;

function renderStatus(status) {
	const connected = status?.connected === true;
	const reason = status?.reason ?? "unknown";

	dotEl.classList.remove("dot-connected", "dot-connecting", "dot-disconnected");
	if (connected) {
		dotEl.classList.add("dot-connected");
		statusTextEl.textContent = "Connected";
		tokenSection.hidden = true;
	} else if (reason === "connecting" || reason === "starting") {
		dotEl.classList.add("dot-connecting");
		statusTextEl.textContent = "Connecting…";
		tokenSection.hidden = reason === "connecting";
	} else if (reason === "no-token") {
		dotEl.classList.add("dot-disconnected");
		statusTextEl.textContent = "Not connected — paste token";
		tokenSection.hidden = false;
	} else {
		dotEl.classList.add("dot-disconnected");
		statusTextEl.textContent = `Not connected (${reason})`;
		tokenSection.hidden = false;
	}

	if (status?.gatewayVersion) {
		gatewayVersionEl.textContent = status.gatewayVersion;
	}
}

async function queryStatus() {
	try {
		const res = await chrome.runtime.sendMessage({ kind: "status" });
		if (res) renderStatus(res);
	} catch {
		renderStatus({ connected: false, reason: "no-offscreen" });
	}
}

saveBtn.addEventListener("click", async () => {
	const token = tokenInput.value.trim();
	if (!token) return;
	saveBtn.disabled = true;
	try {
		await chrome.runtime.sendMessage({ kind: "set-token", token });
	} catch (err) {
		console.warn("[tek] set-token failed", err);
	} finally {
		setTimeout(() => {
			saveBtn.disabled = false;
			queryStatus();
		}, 500);
	}
});

resetBtn.addEventListener("click", async () => {
	try {
		await chrome.runtime.sendMessage({ kind: "reset" });
	} catch (err) {
		console.warn("[tek] reset failed", err);
	}
	tokenInput.value = "";
	setTimeout(queryStatus, 200);
});

// Initial + periodic status poll while popup is open.
queryStatus();
pollTimer = setInterval(queryStatus, 2000);

window.addEventListener("unload", () => {
	if (pollTimer) clearInterval(pollTimer);
});
