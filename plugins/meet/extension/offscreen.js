/**
 * Tek Meet — Offscreen Document (Plan 104-03).
 *
 * Owns the AudioContext graph for tab audio capture:
 *   1. Receives {kind:"start-capture", streamId, meetingId, meta} from the SW
 *      after chrome.tabCapture.getMediaStreamId({targetTabId}) resolves.
 *   2. Opens a MediaStream via getUserMedia with chromeMediaSource:"tab" +
 *      chromeMediaSourceId:<streamId>. This is the only place where tab
 *      audio is legally exposed in MV3 — offscreen documents with reason
 *      USER_MEDIA are the supported surface.
 *   3. Routes the stream through two branches: (a) src → audioCtx.destination
 *      so the user/bot keeps hearing the call (tabCapture auto-mutes the
 *      default tab audio path; mirror-back restores it); (b) src → AudioWorkletNode
 *      ("pcm16-downsampler") which emits 100 ms 16 kHz PCM16 frames back on its
 *      MessagePort.
 *   4. Forwards each frame to the gateway over a dedicated WebSocket as
 *      {kind:"meet.audio.frame", meetingId, frame:<base64>, sampleRate:16000,
 *      t:<epoch-ms>, suppressed:<bool>}. The `suppressed` flag is toggled by
 *      plan 104-06 via {kind:"set-suppress-until"} to let the gateway mark
 *      self-echo frames (transcribe:false, source:"self-echo").
 *
 * Plan 104-06 will extend this doc with a MediaStreamAudioDestinationNode for
 * TTS injection. The capture + downsample graph in this plan stays stable.
 */

let ws = null;
let audioCtx = null;
let captureStream = null;
let workletNode = null;
let currentMeetingId = null;
// plan 104-06 sets this to suppress self-echo transcription for a short
// window after TTS end (default 500 ms). Frames in the window are still
// forwarded — the gateway tags them with source:"self-echo" so they land
// in raw.jsonl but skip LLM-facing transcripts.
let suppressUntilMs = 0;

function bytesToBase64(buf) {
	// Convert ArrayBuffer → base64 without the Buffer API (we're in a DOM
	// context, not Node). Chunked fromCharCode avoids hitting argument-count
	// limits for larger buffers.
	const u8 = new Uint8Array(buf);
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < u8.length; i += CHUNK) {
		s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
	}
	return btoa(s);
}

async function connectWs(meta) {
	if (!meta?.port || !meta?.token) {
		throw new Error("missing-ws-meta");
	}
	ws = new WebSocket(`ws://127.0.0.1:${meta.port}/?token=${encodeURIComponent(meta.token)}`);
	await new Promise((resolve, reject) => {
		ws.addEventListener("open", resolve, { once: true });
		ws.addEventListener("error", (e) => reject(new Error("ws-connect-failed")), { once: true });
	});
	// Advertise our role so the gateway knows this socket carries audio frames
	// (the SW's main socket still carries tool RPC).
	ws.send(JSON.stringify({ kind: "hello-offscreen", role: "audio-source" }));
}

async function startCapture({ streamId, meetingId, meta }) {
	currentMeetingId = meetingId;
	if (!ws || ws.readyState !== 1) {
		await connectWs(meta);
	}
	captureStream = await navigator.mediaDevices.getUserMedia({
		audio: {
			mandatory: {
				chromeMediaSource: "tab",
				chromeMediaSourceId: streamId,
			},
		},
		// DELIBERATELY no video key — tab audio only.
	});
	// AudioContext sampleRate locked to 48000 so the worklet's phase math
	// assumes a stable input rate. The worklet still reads `sampleRate`
	// dynamically, so non-48k contexts work, but pinning it here keeps
	// behavior predictable across Chrome builds.
	audioCtx = new AudioContext({ sampleRate: 48000 });
	const src = audioCtx.createMediaStreamSource(captureStream);
	// Mirror-back path: tabCapture silences the default tab playback, so
	// without this the user/bot would not hear the meeting. This is the
	// RESEARCH MEET-05 "audible passthrough" requirement.
	src.connect(audioCtx.destination);
	// Downsampler path
	await audioCtx.audioWorklet.addModule("pcm16-worklet.js");
	workletNode = new AudioWorkletNode(audioCtx, "pcm16-downsampler", {
		processorOptions: { targetRate: 16000 },
	});
	workletNode.port.onmessage = (ev) => {
		const { buffer, sampleRate } = ev.data;
		if (!ws || ws.readyState !== 1) return;
		const now = Date.now();
		const suppressed = now < suppressUntilMs;
		ws.send(
			JSON.stringify({
				kind: "meet.audio.frame",
				meetingId: currentMeetingId,
				frame: bytesToBase64(buffer),
				sampleRate,
				t: now,
				suppressed,
			}),
		);
	};
	src.connect(workletNode);
	console.log("[tek-meet-offscreen] capture started for meetingId=", meetingId);
}

async function stopCapture() {
	try {
		workletNode?.port.close();
		workletNode?.disconnect();
	} catch {
		// ignore
	}
	try {
		captureStream?.getTracks().forEach((t) => t.stop());
	} catch {
		// ignore
	}
	try {
		await audioCtx?.close();
	} catch {
		// ignore
	}
	captureStream = null;
	audioCtx = null;
	workletNode = null;
	currentMeetingId = null;
	console.log("[tek-meet-offscreen] capture stopped");
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind === "start-capture") {
		startCapture(msg)
			.then(() => respond({ ok: true }))
			.catch((e) => respond({ ok: false, error: String(e?.message || e) }));
		return true;
	}
	if (msg.kind === "stop-capture") {
		stopCapture()
			.then(() => respond({ ok: true }))
			.catch((e) => respond({ ok: false, error: String(e?.message || e) }));
		return true;
	}
	if (msg.kind === "keepalive-ping") {
		// Synchronous response proves the offscreen doc is alive.
		respond({ kind: "keepalive-pong", t: Date.now() });
		return false;
	}
	if (msg.kind === "set-suppress-until" && typeof msg.untilMs === "number") {
		suppressUntilMs = msg.untilMs;
		respond({ ok: true });
		return false;
	}
	// Plan 104-06: play-tts entry point. The offscreen doc is the SW's normal
	// message target, but the actual synthetic-mic Web Audio graph lives in
	// the page's MAIN world (content-main-world.js) because MediaStreamTrack
	// handoff across worlds is fragile. We delegate here: set the
	// self-echo suppression window immediately so whisper tags incoming
	// frames as self-echo, and signal "done" synchronously so the gateway's
	// RPC resolves. The actual PCM chunk delivery to MAIN world happens via
	// the background SW → content-isolated → window.postMessage bridge that
	// forwards {kind:"tts-chunk", pcmBase64, sampleRate} to the page.
	if (msg.kind === "play-tts") {
		try {
			const sampleRate = typeof msg.sampleRate === "number" ? msg.sampleRate : 24000;
			const pcmBase64 = typeof msg.pcmBase64 === "string" ? msg.pcmBase64 : "";
			// Estimate duration so whisper can suppress the self-echo window.
			const approxBytes = Math.ceil(pcmBase64.length * 0.75);
			const approxSamples = Math.floor(approxBytes / 2);
			const durMs = Math.round((approxSamples / sampleRate) * 1000) + 500;
			suppressUntilMs = Date.now() + durMs;
			respond({ ok: true, suppressUntilMs, durMs });
		} catch (e) {
			respond({ ok: false, error: String(e?.message || e) });
		}
		return false;
	}
	return undefined;
});

console.log("[tek-meet-offscreen] ready");
