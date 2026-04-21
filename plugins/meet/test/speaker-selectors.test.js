/**
 * Unit tests for extension/speaker-selectors.js.
 *
 * We use a tiny in-file DOM shim — speaker-selectors.js only calls
 * doc.querySelector and el.querySelector / el.getAttribute / el.textContent,
 * so a ~30-line mock is enough. Keeps the plugin's zero-devDeps invariant
 * (no jsdom / linkedom dependency).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	findActiveSpeaker,
	extractName,
	SPEAKER_SELECTORS,
} from "../extension/speaker-selectors.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Very small DOM shim for meet-grid.html. Supports only the selectors
 * speaker-selectors.js actually uses: [data-active-speaker="true"],
 * [class*="active-speaker"], .NWpY1d.active, and .xoMHSc[aria-hidden="false"].
 * Child queries via [data-name], [data-self-name], [aria-label].
 */
function parseFixture(html) {
	// Extract top-level <div ...>...</div> blocks (non-nested for fixture simplicity).
	const nodes = [];
	const re = /<div\s+([^>]+)>\s*([\s\S]*?)\s*<\/div>/g;
	let m;
	while ((m = re.exec(html)) !== null) {
		const attrs = {};
		const attrRe = /([a-zA-Z0-9_-]+)=("([^"]*)"|'([^']*)')/g;
		let am;
		while ((am = attrRe.exec(m[1])) !== null) {
			attrs[am[1]] = am[3] ?? am[4] ?? "";
		}
		const innerHtml = m[2];
		const spanMatch = innerHtml.match(/<span>([^<]*)<\/span>/);
		const textContent = (spanMatch ? spanMatch[1] : innerHtml)
			.replace(/<[^>]+>/g, "")
			.trim();
		const node = {
			attrs,
			textContent,
			getAttribute(name) {
				return this.attrs[name] ?? null;
			},
			querySelector(sel) {
				// Support bracket-attribute selectors like [data-name], [aria-label], [data-self-name].
				const bm = sel.match(/^\[([a-zA-Z0-9_-]+)\]$/);
				if (bm) {
					const k = bm[1];
					if (this.attrs[k] != null) {
						return {
							getAttribute: (n) => (n === k ? this.attrs[k] : null),
							textContent: this.attrs[k] || this.textContent,
						};
					}
				}
				return null;
			},
		};
		nodes.push(node);
	}
	return {
		nodes,
		querySelector(sel) {
			for (const n of nodes) {
				if (sel === '[data-active-speaker="true"]' && n.attrs["data-active-speaker"] === "true") {
					return n;
				}
				if (sel === '[class*="active-speaker"]' && (n.attrs["class"] || "").includes("active-speaker")) {
					return n;
				}
				if (sel === ".NWpY1d.active") {
					const cls = (n.attrs["class"] || "").split(/\s+/);
					if (cls.includes("NWpY1d") && cls.includes("active")) return n;
				}
				if (sel === '.xoMHSc[aria-hidden="false"]') {
					const cls = (n.attrs["class"] || "").split(/\s+/);
					if (cls.includes("xoMHSc") && n.attrs["aria-hidden"] === "false") return n;
				}
			}
			return null;
		},
	};
}

test("findActiveSpeaker returns the active tile's name when data-active-speaker=true", () => {
	const html = readFileSync(join(__dirname, "fixtures", "meet-grid.html"), "utf8");
	const doc = parseFixture(html);
	const r = findActiveSpeaker(doc);
	assert.equal(r.name, "Bob Smith");
	assert.equal(r.matchedSelector, '[data-active-speaker="true"]');
});

test("findActiveSpeaker returns {name:null} when no selector matches", () => {
	const doc = { querySelector: () => null };
	const r = findActiveSpeaker(doc);
	assert.equal(r.name, null);
	assert.equal(r.matchedSelector, null);
});

test("extractName handles data-name attribute via child query", () => {
	const el = {
		getAttribute: () => null,
		querySelector: (s) =>
			s === "[data-name]"
				? { getAttribute: (n) => (n === "data-name" ? "Alice" : null), textContent: "Alice" }
				: null,
		textContent: "Alice",
	};
	assert.equal(extractName(el), "Alice");
});

test("extractName strips whitespace and collapses spaces", () => {
	const el = {
		getAttribute: () => null,
		querySelector: () => null,
		textContent: "  Bob   Smith  ",
	};
	assert.equal(extractName(el), "Bob Smith");
});

test("extractName rejects overly long text (>200 chars)", () => {
	const el = {
		getAttribute: () => null,
		querySelector: () => null,
		textContent: "x".repeat(500),
	};
	assert.equal(extractName(el), null);
});

test("SPEAKER_SELECTORS has at least 3 entries (RESEARCH Pitfall 4 mitigation)", () => {
	assert.ok(
		SPEAKER_SELECTORS.length >= 3,
		`expected ≥3, got ${SPEAKER_SELECTORS.length}`,
	);
});

test("findActiveSpeaker falls back to [class*=active-speaker] when data-active-speaker absent", () => {
	// Fixture-free node: only matches the second selector.
	const activeEl = {
		getAttribute: () => null,
		querySelector: (s) =>
			s === "[data-name]"
				? { getAttribute: (n) => (n === "data-name" ? "Dana" : null), textContent: "Dana" }
				: null,
		textContent: "Dana",
	};
	const doc = {
		querySelector(sel) {
			// Returns null for the first selector (data-active-speaker=true),
			// returns the activeEl for the second ([class*=active-speaker]).
			if (sel === '[class*="active-speaker"]') return activeEl;
			return null;
		},
	};
	const r = findActiveSpeaker(doc);
	assert.equal(r.name, "Dana");
	assert.equal(r.matchedSelector, '[class*="active-speaker"]');
});
