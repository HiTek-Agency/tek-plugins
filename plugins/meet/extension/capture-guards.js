import { isMeetCaptureUrl } from "./capture-controller.js";
/** Capture can survive tab navigation in Chrome. End it when its permitted room
 * departs; use generation checks so late browser events cannot stop replacements. */
export function observeCaptureTarget(chromeApi, capture) {
	chromeApi.tabs.onUpdated?.addListener(async tabId => {
		const owner = capture.owner();
		if (owner.tabId !== tabId || !owner.meetingId) return;
		try {
			// Queued changeInfo URLs can belong to the preceding document/capture.
			const tab = await chromeApi.tabs.get(tabId);
			if (isMeetCaptureUrl(tab.url, owner.meetingId) && (!tab.pendingUrl || isMeetCaptureUrl(tab.pendingUrl, owner.meetingId))) return;
		} catch { /* A missing or unverifiable owned tab cannot keep recording. */ }
		await capture.invalidate(owner);
	});
	chromeApi.tabs.onRemoved?.addListener(tabId => {
		const owner = capture.owner();
		if (owner.tabId === tabId) void capture.invalidate(owner, "The Meet tab closed. Audio is stopping.");
	});
	chromeApi.tabCapture?.onStatusChanged?.addListener(async info => {
		if (!["stopped","error"].includes(info.status) || capture.isCleaning()) return;
		const owner = capture.owner();
		if (owner.tabId !== info.tabId || !owner.meetingId) return;
		try {
			// A delayed stopped event may belong to the stream preceding recovery.
			const tabs = await chromeApi.tabCapture.getCapturedTabs();
			if (tabs.some(tab => tab.tabId === info.tabId && ["pending","active"].includes(tab.status))) return;
		} catch { /* Unverifiable capture is not advertised as active. */ }
		await capture.invalidate(owner, "Chrome ended audio capture. Request audio again before restarting.");
	});
}
