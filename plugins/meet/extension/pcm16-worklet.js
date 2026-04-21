// AudioWorkletProcessor — downsamples incoming float32 mono audio to 16-bit
// signed little-endian PCM at 16 kHz and posts 100 ms frames (1600 samples
// at 16 kHz) back to the main thread as transferable ArrayBuffers. This runs
// inside the offscreen document's AudioContext so the main thread stays free
// to forward frames over the WebSocket.
//
// Plan 104-03: first concrete implementation. Plans 104-04/05 consume the
// frames unchanged; plan 104-06 (TTS) uses a separate graph.

class PCM16Downsampler extends AudioWorkletProcessor {
	constructor(options) {
		super();
		this.targetRate = options?.processorOptions?.targetRate || 16000;
		// sampleRate is a global injected into AudioWorkletGlobalScope and reflects
		// the AudioContext's native sample rate (typically 48000 on macOS Chrome).
		this.inRate = sampleRate;
		this.ratio = this.inRate / this.targetRate;
		// 100 ms @ targetRate = 1600 samples when targetRate = 16000.
		this.frameSize = Math.round(this.targetRate * 0.1);
		this.outBuf = new Int16Array(this.frameSize);
		this.outIdx = 0;
		// Floating-point read cursor into the incoming Float32 block; carries
		// fractional remainder across process() calls so the downsample phase
		// doesn't drift at block boundaries.
		this.phase = 0;
	}

	process(inputs) {
		const input = inputs[0];
		if (!input || !input[0]) return true;
		const src = input[0]; // Float32Array, mono channel 0
		while (this.phase < src.length) {
			const idx = Math.floor(this.phase);
			const frac = this.phase - idx;
			const s0 = src[idx] ?? 0;
			const s1 = src[idx + 1] ?? s0;
			const v = s0 + (s1 - s0) * frac;
			// Clip to [-1, 1] before scaling to Int16 range to avoid wrap-around
			// when the upstream signal slightly overshoots the nominal range.
			const clipped = Math.max(-1, Math.min(1, v));
			this.outBuf[this.outIdx++] = Math.round(clipped * 32767);
			if (this.outIdx >= this.frameSize) {
				// Copy to a fresh Int16Array so the underlying ArrayBuffer can be
				// transferred without the next iteration's writes racing the post.
				const out = new Int16Array(this.outBuf);
				this.port.postMessage(
					{ buffer: out.buffer, sampleRate: this.targetRate },
					[out.buffer],
				);
				this.outIdx = 0;
			}
			this.phase += this.ratio;
		}
		// Wrap phase for the next block — subtract the source length so the
		// next process() call starts from the residual fractional offset.
		this.phase -= src.length;
		return true;
	}
}

registerProcessor("pcm16-downsampler", PCM16Downsampler);
