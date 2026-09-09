/** Popup calls can only retry a meeting explicitly requested by the Gateway. */
export async function startRequestedAudio(chromeApi) {
	const state = await chromeApi.runtime.sendMessage({kind:"meet.capture.status"});
	if (!state?.meetingId || !Number.isInteger(state.tabId)) return {ok:false,error:"No meeting is waiting for audio. Ask your agent to join a meeting first."};
	const tabs = await chromeApi.tabs.query({active:true,currentWindow:true});
	if (tabs?.[0]?.id !== state.tabId) return {ok:false,error:"Select the bot’s requested Meet tab, then reopen Tek Meet and click Start audio."};
	return chromeApi.runtime.sendMessage({kind:"meet.start-capture",tabId:state.tabId,meetingId:state.meetingId});
}
export function mountCapturePopup(document, chromeApi) {
	const status = document.getElementById("capture-status");
	const message = document.getElementById("capture-message");
	const start = document.getElementById("capture-start");
	const stop = document.getElementById("capture-stop");
	let busy = null;
	const render = async () => {
		try {
			const snapshot = await chromeApi.runtime.sendMessage({kind:"meet.capture.status"});
			const labels = {starting:"Starting audio…",active:"Audio capture active",stopped:"Audio stopped","needs-user":"Chrome needs your permission",failed:"Audio needs attention"};
			status.textContent = `${busy === "stop" ? "Stopping audio…" : busy === "start" ? "Starting audio…" : (snapshot?.state === "stopped" && !snapshot?.meetingId ? "No meeting requested. Ask your agent to join a meeting first." : labels[snapshot?.state] ?? "Audio status unavailable")}${snapshot?.meetingId ? ` · ${snapshot.meetingId}` : ""}`;
			start.disabled = busy || !snapshot?.meetingId || ["active","starting"].includes(snapshot?.state);
			stop.disabled = busy || !snapshot?.meetingId;
		} catch {
			status.textContent = "Audio status unavailable. Reopen Tek Meet to retry.";
			start.disabled = stop.disabled = true;
		}
	};
	const act = async (kind, operation) => {
		if (busy) return;
		busy = kind; status.textContent = kind === "stop" ? "Stopping audio…" : "Starting audio…"; start.disabled = stop.disabled = true; message.textContent = "";
		try { const result = await operation(); message.textContent = result?.ok ? "Audio status updated." : result?.error ?? "Audio action could not be confirmed."; }
		catch { message.textContent = "Audio action could not be confirmed. Refresh the popup before retrying."; }
		finally { busy = null; await render(); }
	};
	start.addEventListener("click", () => void act("start", () => startRequestedAudio(chromeApi)));
	stop.addEventListener("click", () => void act("stop", async () => {
		const state = await chromeApi.runtime.sendMessage({kind:"meet.capture.status"});
		return chromeApi.runtime.sendMessage({kind:"meet.stop-capture",expectedMeetingId:state?.meetingId ?? null});
	}));
	void render();
	return setInterval(() => void render(), 2000);
}
