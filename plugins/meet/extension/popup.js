import { mountCapturePopup } from "./capture-popup.js";
/**
 * Tek Meet — popup UI (Plan 104-02).
 *
 * Reads {port, token} pairing info from chrome.storage.local and lets the user
 * paste the meta JSON (copy from ~/.config/tek/meet.json). On save, forwards
 * the meta to the SW via chrome.runtime.sendMessage({kind:"update-meta"}).
 */

const STORAGE_KEY = "tek_meet_connection";
const statusEl = document.getElementById("status");
const resetBtn = document.getElementById("reset");

async function render() {
	const r = await chrome.storage.local.get(STORAGE_KEY);
	const meta = r[STORAGE_KEY];

	// Clear any previously injected input/button between renders.
	document.querySelectorAll(".tek-meet-dyn").forEach((n) => n.remove());

	if (!meta?.port || !meta?.token) {
		statusEl.textContent =
			"Not paired. Paste the contents of ~/.config/tek/meet.json below.";
		const input = document.createElement("textarea");
		input.className = "tek-meet-dyn";
		input.rows = 4;
		input.placeholder = '{"port":52881,"token":"..."}';
		const saveBtn = document.createElement("button");
		saveBtn.className = "tek-meet-dyn";
		saveBtn.textContent = "Save and Connect";
		saveBtn.onclick = async () => {
			try {
				const parsed = JSON.parse(input.value);
				if (typeof parsed.port !== "number" || typeof parsed.token !== "string") {
					throw new Error("meta must have numeric port + string token");
				}
				const result = await chrome.runtime.sendMessage({ kind: "update-meta", meta: parsed });
				if (!result?.ok) throw new Error(result?.error ?? "Pairing change was not confirmed");
				render();
			} catch (e) {
				statusEl.textContent = `Pairing was not changed: ${e.message}`;
			}
		};
		statusEl.after(input, saveBtn);
		return;
	}

	statusEl.textContent = meta.connected
		? `Connected (port ${meta.port}, last handshake ${
				meta.lastHandshakeAt
					? new Date(meta.lastHandshakeAt).toLocaleTimeString()
					: "n/a"
			})`
		: "Paired but not connected. Waiting for gateway...";
}

resetBtn.addEventListener("click", async () => {
	try {
		const result = await chrome.runtime.sendMessage({ kind: "reset" });
		if (!result?.ok) { statusEl.textContent = result?.error ?? "Reset could not be confirmed."; return; }
	} catch {
		statusEl.textContent = "Reset could not be confirmed. Check audio status before retrying.";
		return;
	}
	render();
});

render();

mountCapturePopup(document, chrome);
