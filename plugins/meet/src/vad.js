/**
 * Simple energy-based Voice Activity Detector for 16-bit PCM @ 16 kHz mono.
 *
 * Computes RMS of the Int16 samples and returns true if the RMS is above a
 * configurable threshold. Threshold 500 is a conservative default tuned
 * against typical meeting-room background noise — loud enough to reject
 * HVAC hum and keyboard clicks, quiet enough to accept soft speech.
 *
 * This is intentionally simple. It can be swapped for Silero-VAD or a
 * spectral detector later without changing the API surface — meet-transcriber
 * only calls isSpeech(int16Buffer, threshold).
 *
 * Plan 104-03 MVP. Plan 104-05 (wake-word) uses the same VAD to gate its
 * 1-second scanning window.
 */

export function rms(int16) {
	let sum = 0;
	for (let i = 0; i < int16.length; i++) {
		const v = int16[i];
		sum += v * v;
	}
	return Math.sqrt(sum / (int16.length || 1));
}

export function isSpeech(int16, threshold = 500) {
	return rms(int16) > threshold;
}
