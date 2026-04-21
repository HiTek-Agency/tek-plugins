/**
 * Selector priority list for the Meet active-speaker tile.
 *
 * Meet's DOM changes often — Google ships UI updates silently — so we treat
 * this list as a living fallback chain. When a selector breaks, add new ones
 * to the TOP of the list and rely on the older ones as fallbacks. Returning
 * {name:null} on no match is CORRECT — corrupt attribution is worse than none
 * (per RESEARCH Pitfall 4).
 *
 * Exported from this module (instead of being inlined in content-isolated.js)
 * so node:test can import it directly without loading chrome.* APIs.
 *
 * NOTE: content-isolated.js carries a sibling copy of findActiveSpeaker for
 * bundling reasons (content scripts don't support ES module imports in the
 * default tek-meet manifest world). If you update this file, update the
 * content-script copy too. The duplication is deliberate — the testable
 * version is here; the shipped version is in content-isolated.js.
 */

export const SPEAKER_SELECTORS = [
	'[data-active-speaker="true"]',
	'[class*="active-speaker"]',
	".NWpY1d.active",
	'.xoMHSc[aria-hidden="false"]',
];

/**
 * Name extractors tried in order against the matched speaker tile. First
 * one that returns a plausible name wins.
 *
 *   - data-self-name chip (top-left self video)
 *   - data-name attribute (participant tile)
 *   - aria-label on the tile itself (Meet often labels the tile with the
 *     speaker's name, e.g. "Bob Smith is speaking")
 *   - aria-label on a child element
 *   - raw textContent as last resort
 */
export const NAME_EXTRACTORS = [
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

/**
 * Run the extractor chain against `el` and return the first plausible name.
 * Names are normalized (trim + single-space) and rejected if empty or
 * longer than 200 chars (heuristic against false matches on container
 * elements whose textContent is the whole participant list).
 */
export function extractName(el) {
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

/**
 * Run the priority list against `doc` and return { name, matchedSelector }
 * for the first selector that both matches AND yields a plausible name.
 * If nothing matches, returns { name: null, matchedSelector: null }.
 */
export function findActiveSpeaker(doc) {
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
