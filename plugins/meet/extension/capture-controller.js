/** Chrome enforces target-tab capture permission. A WS call cannot grant activeTab. */
const invalid = () => ({ ok: false, code: "MEET_CAPTURE_INVALID", error: "Capture requires the requested Meet tab and meeting ID." });
const busy = () => ({ ok: false, code: "MEET_BUSY", error: "Another capture operation is still in progress." });
function validTarget(args) {
	return args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).every(key => key === "tabId" || key === "meetingId") &&
		Number.isInteger(args.tabId) && args.tabId >= 0 && typeof args.meetingId === "string" && /^[a-z0-9-]{1,128}$/i.test(args.meetingId);
}
export function isMeetCaptureUrl(value, meetingId) {
	try { const url = new URL(value); return url.origin === "https://meet.google.com" && url.pathname.split("/")[1] === meetingId; } catch { return false; }
}
export function createCaptureController({ chromeApi, loadMeta, ensureOffscreen, hasOffscreen, onState, alarmName, periodInMinutes }) {
	let target = null, state = "stopped", stateError, stateCode, generation = 0;
	let startWork = null, stopWork = null, cleanupNeeded = false, cleaning = false;
	const snapshot = () => ({ state, meetingId: target?.meetingId ?? null, tabId: target?.tabId ?? null, ...(stateError ? { error: stateError, code: stateCode } : {}) });
	const emit = (next, error, code) => { state = next; stateError = error; stateCode = code; onState(snapshot()); };
	const cleanup = async () => {
		cleaning = true;
		try {
		try { await chromeApi.alarms.clear(alarmName); } catch { /* No active target will be restarted by its alarm. */ }
		if (await hasOffscreen()) {
			try { await chromeApi.runtime.sendMessage({ kind: "stop-capture" }); } catch { /* Closing the document below also stops its media. */ }
			await chromeApi.offscreen.closeDocument();
		}
		if (await hasOffscreen()) throw new Error("Offscreen capture did not close");
		} finally { cleaning = false; }
	};
	const start = (args, recovering = false) => {
		if (!validTarget(args)) return Promise.resolve(invalid());
		if (startWork || stopWork || cleanupNeeded) return Promise.resolve(busy());
		if (target && (target.meetingId !== args.meetingId || target.tabId !== args.tabId)) return Promise.resolve({ ok:false, code:"MEET_CONFLICT", error:"Stop the previous audio capture before starting another meeting." });
		const alreadyActive = state === "active" && !recovering;
		target = { tabId: args.tabId, meetingId: args.meetingId };
		emit("starting");
		const own = ++generation;
		const current = () => { if (generation !== own) throw Object.assign(new Error("Capture start was cancelled."), { code:"MEET_CANCELLED" }); };
		const work = (async () => {
			try {
				if (!alreadyActive && await hasOffscreen()) { await cleanup(); current(); }
				const checkTarget = async () => {
					const tab = await chromeApi.tabs.get(args.tabId); current();
					if (!isMeetCaptureUrl(tab?.url, args.meetingId) || (tab.pendingUrl && !isMeetCaptureUrl(tab.pendingUrl, args.meetingId))) {
						throw Object.assign(new Error("Select the requested Meet tab after it finishes loading."), { code:"MEET_CAPTURE_TARGET" });
					}
				};
				await checkTarget();
				if (alreadyActive) {
					const captured = await chromeApi.tabCapture.getCapturedTabs(); current();
					if (!captured.some(tab => tab.tabId === args.tabId && tab.status === "active") || !(await hasOffscreen())) throw new Error("Chrome no longer reports active capture.");
					current(); emit("active"); return {ok:true,meetingId:args.meetingId};
				}
				await ensureOffscreen(); current();
				await checkTarget();
				let streamId;
				try { streamId = await chromeApi.tabCapture.getMediaStreamId({ targetTabId: args.tabId }); }
				catch (error) {
					const denied = /invoked|activeTab|permission|not allowed|user gesture/i.test(String(error?.message ?? error));
					throw Object.assign(new Error(denied
						? "In the bot Chrome window, select this Meet tab, open Tek Meet, and click Start audio. Chrome must allow capture of that tab."
						: "Chrome could not start tab capture. Check the Meet tab and try Start audio again."), { code:denied ? "MEET_CAPTURE_USER_GESTURE_REQUIRED" : "MEET_CAPTURE_FAILED" });
				}
				current();
				await checkTarget();
				if (typeof streamId !== "string" || !streamId) throw new Error("Chrome did not return a capture stream.");
				const meta = await loadMeta(); current();
				const ack = await chromeApi.runtime.sendMessage({ kind:"start-capture", streamId, meetingId:args.meetingId, meta }); current();
				if (ack?.ok !== true) throw new Error("The audio document could not start capture. Check Chrome capture permission, then try Start audio again.");
				await chromeApi.alarms.create(alarmName, { periodInMinutes }); current();
				emit("active");
				return { ok:true, meetingId:args.meetingId };
			} catch (error) {
				if (generation !== own) return { ok:false, code:"MEET_CANCELLED", error:"Capture start was cancelled." };
				try { await cleanup(); }
				catch { cleanupNeeded = true; emit("failed", "Audio cleanup could not be confirmed. Use Stop audio before retrying.", "MEET_CAPTURE_CLEANUP_FAILED"); return {ok:false, ...snapshot()}; }
				if (generation !== own) return { ok:false, code:"MEET_CANCELLED", error:"Capture start was cancelled." };
				const code = error.code ?? "MEET_CAPTURE_FAILED";
				const message = error.code ? error.message : "Audio capture could not start. Check Chrome capture permission, then try Start audio again.";
				emit(code === "MEET_CAPTURE_USER_GESTURE_REQUIRED" ? "needs-user" : "failed", message, code);
				return {ok:false, ...snapshot()};
			} finally { if (startWork === work) startWork = null; }
		})();
		startWork = work;
		return work;
	};
	const stop = (args = {}) => {
		if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some(key => key !== "expectedMeetingId") ||
			("expectedMeetingId" in args && !(args.expectedMeetingId === null || typeof args.expectedMeetingId === "string"))) return Promise.resolve(invalid());
		if (target && "expectedMeetingId" in args && args.expectedMeetingId !== target.meetingId) return Promise.resolve({ok:false,code:"MEET_CONFLICT",error:"The captured meeting changed; refresh before stopping audio."});
		if (stopWork) return stopWork;
		++generation;
		const pending = startWork;
		const work = (async () => {
			try {
				await pending;
				await cleanup();
				cleanupNeeded = false;
				emit("stopped");
				target = null;
				return {ok:true};
			} catch {
				cleanupNeeded = true;
				emit("failed", "Audio cleanup could not be confirmed. Try Stop audio again.", "MEET_CAPTURE_CLEANUP_FAILED");
				return {ok:false, ...snapshot()};
			} finally { if (stopWork === work) stopWork = null; }
		})();
		stopWork = work;
		return work;
	};
	const owner = () => ({revision:generation,tabId:target?.tabId,meetingId:target?.meetingId});
	const invalidate = (expected, message = "The capture target changed. Audio is stopping.") => {
		if (!target || expected.revision !== generation || expected.tabId !== target.tabId || expected.meetingId !== target.meetingId) return Promise.resolve({ok:true});
		emit("failed",message,"MEET_CAPTURE_TARGET");
		return stop({expectedMeetingId:target.meetingId});
	};
	return { start, stop, snapshot, owner, invalidate, isCleaning:()=>cleaning || !!stopWork, recover: () => state === "active" && target ? start(target, true) : Promise.resolve({ok:false}) };
}
