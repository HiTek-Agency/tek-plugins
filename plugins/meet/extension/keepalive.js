/**
 * Tek Meet — offscreen-document keepalive helper (Plan 104-03).
 *
 * MV3 offscreen documents with reason USER_MEDIA get hibernated after ~30 s
 * of idle messaging in Chrome 120+. A 2-hour meeting must not drop audio to
 * a silent SW reaping the doc, so the SW pings every 25 s and recreates the
 * offscreen doc if a pong doesn't come back within 2 s.
 *
 * This module is pure: it has zero chrome.* dependencies so it is unit-
 * testable via node:test. background.js wires it to chrome.alarms and
 * chrome.runtime.sendMessage.
 */

export const KEEPALIVE_INTERVAL_MS = 25_000;
export const KEEPALIVE_TIMEOUT_MS = 2_000;

/**
 * Run one keepalive cycle.
 *
 * @param {object} opts
 * @param {() => Promise<any>} opts.sendPing  - sends the ping and resolves with the pong (or rejects on channel error)
 * @param {() => Promise<void>} opts.recreate - tears down + recreates the offscreen doc + reissues capture
 * @param {number} [opts.timeoutMs]           - pong budget; defaults to KEEPALIVE_TIMEOUT_MS
 * @returns {Promise<{alive:true,pong:any} | {alive:false,recreated:true,reason:string}>}
 */
export async function runKeepaliveCycle({ sendPing, recreate, timeoutMs = KEEPALIVE_TIMEOUT_MS }) {
	try {
		const pong = await Promise.race([
			sendPing(),
			new Promise((_, rej) =>
				setTimeout(() => rej(new Error("keepalive-timeout")), timeoutMs),
			),
		]);
		return { alive: true, pong };
	} catch (e) {
		try {
			await recreate();
		} catch (recreateErr) {
			// surface the recreate failure but still mark the cycle as a fallback
			return {
				alive: false,
				recreated: false,
				reason: `recreate-failed: ${recreateErr?.message || recreateErr}`,
			};
		}
		return {
			alive: false,
			recreated: true,
			reason: e?.message || String(e),
		};
	}
}
