/**
 * Wake-word scanner (Plan 104-06 Task 1).
 *
 * Accepts whisper transcript chunks (from meet-transcriber.js), matches them
 * case-insensitively against a configurable phrase list, and returns
 * {matched, phrase, suppressed}. Default phrases are "hey tek" and
 * "tek join in" per CONTEXT D-08.
 *
 * Pure state — no timers, no IO, no network calls. Zero cloud calls ever
 * (D-20: wake-word runs 100% locally). Only wake-word *hits* cause any
 * outbound LLM call, and those are invoked by the caller, not this module.
 *
 * Suppression: the FSM-driving caller sets a suppressUntilMs window while the
 * bot's own TTS is playing back through the mic-inject path (self-echo) so we
 * don't self-trigger on our own voice. Frames with t_end_ms < suppressUntil
 * return {matched:false, suppressed:true}.
 *
 * Regex construction: phrase strings are regex-escaped before compilation
 * (defense against wildcard characters in user-configured phrases). The
 * compiled regex uses `\b` word-boundary anchors on each end so "hey tek"
 * doesn't false-match "theyreks" or similar.
 */

/**
 * Escape regex-special characters so user-configured phrases with dots,
 * parentheses, etc. match as literals rather than patterns.
 */
function escapeRegex(p) {
	return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildRegexes(list) {
	return list.map((p) => new RegExp("\\b" + escapeRegex(p) + "\\b", "i"));
}

export function createWakeWordScanner({
	phrases = ["hey tek", "tek join in"],
	suppressUntilMs = 0,
} = {}) {
	let _phrases = phrases.map((p) => p.toLowerCase());
	let _regexes = buildRegexes(_phrases);
	let _suppressUntil = suppressUntilMs;

	return {
		/**
		 * Scan a transcript chunk. `chunk` must be `{text, t_end_ms?}` — other
		 * fields are ignored but tolerated.
		 * Returns:
		 *   - {matched: true, phrase} on wake-word hit
		 *   - {matched: false, suppressed: true} during the suppression window
		 *   - {matched: false} otherwise
		 */
		processChunk(chunk) {
			if (!chunk || !chunk.text || typeof chunk.text !== "string") {
				return { matched: false };
			}
			if (chunk.t_end_ms && chunk.t_end_ms < _suppressUntil) {
				return { matched: false, suppressed: true };
			}
			for (let i = 0; i < _regexes.length; i++) {
				if (_regexes[i].test(chunk.text)) {
					return { matched: true, phrase: _phrases[i] };
				}
			}
			return { matched: false };
		},
		setSuppressUntil(ms) {
			_suppressUntil = ms;
		},
		setPhrases(list) {
			_phrases = list.map((p) => p.toLowerCase());
			_regexes = buildRegexes(_phrases);
		},
		getPhrases() {
			return _phrases.slice();
		},
	};
}

/**
 * Pure convenience function — builds a one-off scanner and processes a single
 * text string. Use createWakeWordScanner for long-lived usage (preserves
 * regex compilation across chunks).
 */
export function matchesWakeWord(text, phrases = ["hey tek", "tek join in"]) {
	const scanner = createWakeWordScanner({ phrases });
	return scanner.processChunk({ text, t_end_ms: Date.now() });
}
