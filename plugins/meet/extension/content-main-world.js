/**
 * Tek Meet — MAIN-world content script (Plan 104-06 Task 2).
 *
 * Runs in `world: "MAIN"` + `run_at: "document_start"` on https://meet.google.com/*.
 * Monkey-patches `navigator.mediaDevices.getUserMedia` + `enumerateDevices`
 * so participant-mode TTS can be injected as a synthetic microphone track.
 *
 * Implements all three RESEARCH Pitfall 1 mitigations (jointly — each mitigates
 * a different failure mode):
 *
 *   1. about:blank bounce — lives in chrome-profile.js (plan 104-02). The
 *      bot opens at about:blank BEFORE navigating to Meet, so this script
 *      has a chance to install before Meet's inline scripts run.
 *   2. Dual patch — this script patches BOTH the instance
 *      `navigator.mediaDevices.getUserMedia` AND the prototype
 *      `MediaDevices.prototype.getUserMedia` so cached bound references
 *      (common pattern: `const gUM = navigator.mediaDevices.getUserMedia.bind(...)`)
 *      still get intercepted.
 *   3. enumerateDevices fallback — exposes a synthetic `Tek Agent Voice`
 *      audioinput device so the user can manually select it in Meet's mic
 *      dropdown as a last-resort fallback if the auto-injection race loses.
 *
 * Track delivery: the actual synthetic MediaStream is assembled in this world
 * by a later hand-off from the offscreen doc. Because cross-world MediaStream
 * transfer is fragile, plan 104-06 Task 3 uses a PCM-chunk relay path instead:
 * the offscreen doc streams base64 PCM via the SW + isolated-world content
 * script, which window.postMessage()s into MAIN world where an AudioContext
 * + MediaStreamAudioDestinationNode produces the synthetic track locally.
 * That construction lives in task 3; here we just stub the attach API.
 */
(() => {
	if (typeof window === "undefined") return;
	if (window.__TEK_MEET_PATCHED__) return;
	window.__TEK_MEET_PATCHED__ = true;

	const md = navigator.mediaDevices;
	if (!md) return;

	const origGetUserMedia = md.getUserMedia ? md.getUserMedia.bind(md) : null;
	const origEnumerate = md.enumerateDevices ? md.enumerateDevices.bind(md) : null;

	/**
	 * The synthetic mic stream. Initially null — assigned once the TTS
	 * pipeline (task 3) constructs its MediaStreamAudioDestinationNode and
	 * hands us the track via either __TEK_MEET_ATTACH_SYNTH__ (direct
	 * same-world call) or a window.postMessage bridge from the isolated-world
	 * content script.
	 */
	let syntheticMicStream = null;

	async function patchedGetUserMedia(constraints) {
		const hasAudio = !!constraints?.audio;
		const hasVideo = !!constraints?.video;
		// Only intercept audio-only requests — video requests must go through
		// to the real camera (Meet always asks for both when available, but
		// also asks for audio-only during mic-only flows). If we have a
		// synthetic mic attached AND the request is audio-only, swap it.
		if (hasAudio && !hasVideo && syntheticMicStream) {
			try {
				console.log("[tek-meet-main] getUserMedia: returning synthetic mic");
			} catch {
				// ignore — console may be restricted in some worlds
			}
			return syntheticMicStream;
		}
		if (!origGetUserMedia) {
			throw new Error("original getUserMedia unavailable");
		}
		return origGetUserMedia(constraints);
	}

	// Mitigation 2: patch BOTH instance and prototype. Pages that cache a
	// bound reference of `navigator.mediaDevices.getUserMedia.bind(...)` at
	// startup still see the patched version via the prototype hop.
	try {
		md.getUserMedia = patchedGetUserMedia;
	} catch {
		// Some browsers make mediaDevices frozen — continue to the prototype
		// patch as a fallback.
	}
	try {
		if (typeof MediaDevices !== "undefined" && MediaDevices.prototype) {
			MediaDevices.prototype.getUserMedia = patchedGetUserMedia;
		}
	} catch {
		// ignore — prototype may be non-writable in some sandboxed contexts
	}

	// Mitigation 3: surface a synthetic `Tek Agent Voice` audioinput device
	// via enumerateDevices so the Meet UI dropdown can pick it manually even
	// if the auto-injection race is lost. Real devices are still returned.
	if (origEnumerate) {
		md.enumerateDevices = async function patchedEnumerate() {
			const devices = await origEnumerate();
			return [
				...devices,
				{
					deviceId: "tek-synth-mic",
					kind: "audioinput",
					label: "Tek Agent Voice",
					groupId: "tek",
				},
			];
		};
	}

	/**
	 * Main-world handoff hook — called either directly (same-world) or via
	 * the window.postMessage bridge below (from the isolated-world content
	 * script).
	 */
	function attachSynth(track) {
		try {
			if (track && typeof MediaStream !== "undefined") {
				syntheticMicStream = new MediaStream([track]);
				try {
					console.log("[tek-meet-main] synthetic mic stream attached");
				} catch {
					// ignore
				}
			}
		} catch (e) {
			try {
				console.warn("[tek-meet-main] synthetic mic attach failed", e);
			} catch {
				// ignore
			}
		}
	}

	window.__TEK_MEET_ATTACH_SYNTH__ = attachSynth;

	// Bridge: isolated-world content script forwards the synthetic track via
	// window.postMessage({type:"__TEK_MEET_SET_SYNTHETIC_MIC__", track}). The
	// track itself may be a real MediaStreamTrack (transferred same-origin
	// same-tab) or — for the PCM chunk-relay path used by plan 104-06 task 3 —
	// omitted, with the actual audio fed via __TEK_MEET_TTS_CHUNK__ messages.
	// The chunk-relay path is the MVP: we build an AudioContext +
	// MediaStreamAudioDestinationNode lazily on first chunk, use its
	// .stream.getAudioTracks()[0] as the synthetic mic, and play each
	// incoming PCM chunk through a BufferSource → destinationNode.

	let ttsAudioCtx = null;
	let ttsDestNode = null;

	function ensureTtsGraph() {
		if (ttsAudioCtx && ttsDestNode) return;
		try {
			ttsAudioCtx = new AudioContext({ sampleRate: 48000 });
			ttsDestNode = ttsAudioCtx.createMediaStreamDestination();
			// The destination node's .stream exposes a single audio track
			// that behaves like a real mic input. Hand this stream to the
			// getUserMedia override so Meet gets the bot's voice as if it
			// were coming from a microphone.
			const track = ttsDestNode.stream.getAudioTracks()[0];
			attachSynth(track);
		} catch (e) {
			try {
				console.warn("[tek-meet-main] TTS AudioContext build failed", e);
			} catch {
				// ignore
			}
		}
	}

	function playPcmChunk(pcmBase64, sampleRate) {
		if (!pcmBase64 || typeof pcmBase64 !== "string") return;
		ensureTtsGraph();
		if (!ttsAudioCtx || !ttsDestNode) return;
		try {
			const rate = typeof sampleRate === "number" ? sampleRate : 24000;
			// base64 → Uint8Array → Int16Array → Float32Array
			const bin = atob(pcmBase64);
			const u8 = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
			const pcm = new Int16Array(u8.buffer);
			const f32 = new Float32Array(pcm.length);
			for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
			const buf = ttsAudioCtx.createBuffer(1, f32.length || 1, rate);
			if (f32.length > 0) buf.copyToChannel(f32, 0);
			const src = ttsAudioCtx.createBufferSource();
			src.buffer = buf;
			src.connect(ttsDestNode);
			src.start();
		} catch (e) {
			try {
				console.warn("[tek-meet-main] playPcmChunk failed", e);
			} catch {
				// ignore
			}
		}
	}

	if (typeof window.addEventListener === "function") {
		window.addEventListener("message", (ev) => {
			const data = ev?.data;
			if (!data || typeof data !== "object") return;
			if (data.type === "__TEK_MEET_SET_SYNTHETIC_MIC__") {
				// Direct-track path (unused by MVP chunk-relay; forward-declared
				// hook for future plan-104-09 track-handoff upgrade).
				attachSynth(data.track);
				return;
			}
			if (data.type === "__TEK_MEET_TTS_CHUNK__") {
				playPcmChunk(data.pcmBase64, data.sampleRate);
				return;
			}
		});
	}

	// Expose a test/debug hook so UATs and future plans can probe the
	// synthetic-mic pipeline without orchestrating the full SW → isolated
	// → main-world relay.
	window.__TEK_MEET_PLAY_PCM__ = playPcmChunk;
})();
