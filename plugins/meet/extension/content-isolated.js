/**
 * Tek Meet — isolated-world content script (Plan 104-04).
 *
 * Runs on https://meet.google.com/* at document_idle in the ISOLATED world.
 * Watches the Meet DOM for active-speaker changes + waiting-room state and
 * pushes events to the SW via chrome.runtime.sendMessage. Emitted kinds:
 *
 *   - {kind:"speaker.changed", name, matchedSelector, at}
 *       — name is the display name of the currently-highlighted tile, or null
 *         if no selector matched. null is valid — it means "we don't know who
 *         is speaking" and will tag subsequent chunks with speakerGuess:null
 *         (RESEARCH Pitfall 4: corrupt attribution is worse than none).
 *
 *   - {kind:"meet.waiting-room", at}
 *       — fired when the page's visible text contains "Asking to join" or
 *         "let you in". The bot does NOT click the Ask-to-join button itself
 *         (that's a user action) — the SW forwards to the gateway, plan 104-07
 *         will surface this via the desktop status chip.
 *
 * NOTE: content scripts bundled by the tek-meet manifest cannot use ES module
 * imports from sibling files directly, so the selector priority list and the
 * name extractors are duplicated below. The testable copy lives in
 * ./speaker-selectors.js — if you update one, update both. The duplication is
 * deliberate — adding a build step for one content script would add more
 * maintenance surface than it saves.
 */

// NOTE: duplicated from speaker-selectors.js for testability — if updated,
// update both.
const SPEAKER_SELECTORS = [
	'[data-active-speaker="true"]',
	'[class*="active-speaker"]',
	".NWpY1d.active",
	'.xoMHSc[aria-hidden="false"]',
];

const NAME_EXTRACTORS = [
	(el) => el.querySelector("[data-self-name]")?.getAttribute("data-self-name"),
	(el) => {
		const n = el.querySelector("[data-name]");
		if (!n) return null;
		return n.getAttribute("data-name") || n.textContent || null;
	},
	(el) => el.getAttribute?.("aria-label") ?? null,
	(el) => el.querySelector("[aria-label]")?.getAttribute("aria-label"),
	(el) => el.textContent?.trim() || null,
];

function extractName(el) {
	if (!el) return null;
	for (const fn of NAME_EXTRACTORS) {
		let n;
		try {
			n = fn(el);
		} catch {
			continue;
		}
		if (!n || typeof n !== "string") continue;
		const cleaned = n.trim().replace(/\s+/g, " ");
		if (cleaned.length === 0 || cleaned.length > 200) continue;
		return cleaned;
	}
	return null;
}

function findActiveSpeaker(doc) {
	for (const sel of SPEAKER_SELECTORS) {
		let el;
		try {
			el = doc.querySelector(sel);
		} catch {
			continue;
		}
		if (!el) continue;
		const name = extractName(el);
		if (name) return { name, matchedSelector: sel };
	}
	return { name: null, matchedSelector: null };
}

const DEBOUNCE_MS = 200;
let lastSpeaker = null;
let lastWaiting = false;
let debounceTimer = null;

function scan() {
	try {
		const { name, matchedSelector } = findActiveSpeaker(document);
		if (name !== lastSpeaker) {
			lastSpeaker = name;
			try {
				chrome.runtime.sendMessage({
					kind: "speaker.changed",
					name,
					matchedSelector,
					at: Date.now(),
				});
			} catch {
				// SW may be reloading — next observer tick will retry
			}
		}
		// Waiting-room detection via visible body text.
		const bodyText = document.body?.innerText || "";
		const waiting = /Asking to join|let you in/i.test(bodyText);
		if (waiting && !lastWaiting) {
			lastWaiting = true;
			try {
				chrome.runtime.sendMessage({ kind: "meet.waiting-room", at: Date.now() });
			} catch {
				// ignore
			}
		} else if (!waiting && lastWaiting) {
			lastWaiting = false;
		}
	} catch (e) {
		console.warn("[tek-meet content-isolated] scan error", e);
	}
}

function schedule() {
	if (debounceTimer) return;
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		scan();
	}, DEBOUNCE_MS);
}

try {
	const obs = new MutationObserver(schedule);
	obs.observe(document.body, {
		subtree: true,
		attributes: true,
		attributeFilter: ["class", "data-active-speaker", "aria-hidden"],
	});
	// Kick once in case we missed the initial state.
	scan();
} catch (e) {
	console.warn("[tek-meet content-isolated] MutationObserver setup failed", e);
}
