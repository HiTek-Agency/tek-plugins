/**
 * Speaker tracker — thin in-memory holder for the currently-speaking
 * participant's name, used by the whisper transcriber to tag chunks with a
 * live best-guess speakerGuess value.
 *
 * The tracker is pure state — no timers, no clocks, no IO. Callers pass in
 * the timestamp at which each speaker transition was observed (typically
 * forwarded from the DOM MutationObserver's Date.now()). That makes the
 * state machine fully deterministic and unit-testable without a fake clock.
 *
 * Maintains a bounded history ring buffer (last 200 transitions) for the
 * post-meeting Meet v2 API reconciliation path (plan 104-05). When no
 * selector matches on the extension side, the tracker is fed `null` and
 * subsequent chunks get speakerGuess:null — corrupt attribution is worse
 * than none (RESEARCH Pitfall 4).
 *
 * Contract:
 *   setCurrent(name: string|null, at?: number): void
 *       Record a speaker transition. Same-name consecutive calls are deduped
 *       (so a MutationObserver firing 10x on the same active tile doesn't
 *       spam history).
 *
 *   getCurrent(): { name: string|null, since: number }
 *       Current speaker and the timestamp it started speaking. Returns a
 *       COPY so callers can't tamper with internal state.
 *
 *   history(): Array<{ name: string|null, startedAt: number }>
 *       Bounded ring buffer of transitions in chronological order.
 *
 *   reset(): void
 *       Clear current + history. Called on meeting end / plugin cleanup.
 */

const HISTORY_MAX = 200;

export function createSpeakerTracker() {
	let current = { name: null, since: 0 };
	const hist = [];

	return {
		setCurrent(name, at) {
			const ts = typeof at === "number" ? at : Date.now();
			// Dedup consecutive same-name transitions. `null` vs `null` is also
			// deduped — a silent stretch with no active tile shouldn't spam
			// history every MutationObserver tick.
			if (name === current.name) return;
			current = { name, since: ts };
			hist.push({ name, startedAt: ts });
			if (hist.length > HISTORY_MAX) hist.shift();
		},
		getCurrent() {
			return { ...current };
		},
		history() {
			return hist.slice();
		},
		reset() {
			current = { name: null, since: 0 };
			hist.length = 0;
		},
	};
}
