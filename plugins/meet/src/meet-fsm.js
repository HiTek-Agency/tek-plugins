/**
 * Meet participant-mode FSM (Plan 104-06 Task 1).
 *
 * Pure state machine — no timers, no clocks, no IO. Caller drives transitions
 * via `transition(event)`. Invalid transitions throw a descriptive error so
 * callers that over-dispatch (e.g., race between wake-word and utterance-end)
 * get a loud failure instead of silent state corruption.
 *
 * State diagram (per CONTEXT D-08 + D-09):
 *
 *   idle
 *    └── join ──> observing
 *                   └── wake ──> wake-detected
 *                                  ├── utterance-start ──> recording-utterance
 *                                  │                         └── utterance-end ──> thinking
 *                                  └── utterance-end ──────────────────────────> thinking
 *                                                                                  ├── tts-ready ──> speaking
 *                                                                                  │                   └── tts-end ──> observing
 *                                                                                  └── llm-error ──> observing (graceful fail)
 *
 *   any state on "meeting-end" → idle
 *
 * The caller wires `setTimeout(silenceTimeoutMs)` externally to dispatch a
 * silence-timeout event when needed — keeping the FSM deterministic for unit
 * testing without fake timers.
 */

export const STATES = Object.freeze({
	IDLE: "idle",
	OBSERVING: "observing",
	WAKE_DETECTED: "wake-detected",
	RECORDING: "recording-utterance",
	THINKING: "thinking",
	SPEAKING: "speaking",
});

const TRANSITIONS = {
	[STATES.IDLE]: {
		join: STATES.OBSERVING,
	},
	[STATES.OBSERVING]: {
		wake: STATES.WAKE_DETECTED,
		"meeting-end": STATES.IDLE,
	},
	[STATES.WAKE_DETECTED]: {
		"utterance-start": STATES.RECORDING,
		"utterance-end": STATES.THINKING,
		"meeting-end": STATES.IDLE,
	},
	[STATES.RECORDING]: {
		"utterance-end": STATES.THINKING,
		"meeting-end": STATES.IDLE,
	},
	[STATES.THINKING]: {
		"tts-ready": STATES.SPEAKING,
		"llm-error": STATES.OBSERVING,
		"meeting-end": STATES.IDLE,
	},
	[STATES.SPEAKING]: {
		"tts-end": STATES.OBSERVING,
		"meeting-end": STATES.IDLE,
	},
};

export function createMeetFsm() {
	let _state = STATES.IDLE;
	const listeners = [];

	return {
		currentState() {
			return _state;
		},
		transition(event) {
			const next = TRANSITIONS[_state]?.[event];
			if (!next) {
				throw new Error(
					`Invalid transition from ${_state} on event '${event}'`,
				);
			}
			const prev = _state;
			_state = next;
			for (const l of listeners) {
				try {
					l({ prev, next, event });
				} catch {
					// listener errors must not break the transition path
				}
			}
			return next;
		},
		/**
		 * Register a listener. Returns an unsubscribe function.
		 */
		on(handler) {
			listeners.push(handler);
			return () => {
				const i = listeners.indexOf(handler);
				if (i >= 0) listeners.splice(i, 1);
			};
		},
		/**
		 * Force-reset to idle. Primarily for meeting-end paths where the caller
		 * wants to release the FSM without firing the full transition chain.
		 */
		reset() {
			_state = STATES.IDLE;
		},
	};
}
