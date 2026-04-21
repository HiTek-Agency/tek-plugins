#!/usr/bin/env node
/**
 * Tek Meet — selector-drift probe (maintenance tool, not a CI gate).
 *
 * When Google silently ships a Meet UI update and the DOM scrapers in
 * plan 104-04 (speaker-selectors.js) stop working, run this probe against
 * a LIVE Meet tab to figure out which selector class / attribute drifted.
 *
 * Usage:
 *   1. Launch the bot Chrome profile manually with CDP enabled:
 *      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *        --user-data-dir="$HOME/.config/tek/meet/chrome-profile" \
 *        --remote-debugging-port=9222 \
 *        https://meet.google.com/new
 *
 *   2. Join a meeting in that Chrome (need at least one visible speaker tile
 *      for the active-speaker selectors to match anything).
 *
 *   3. Run the probe:
 *      node test/selector-probe.mjs
 *
 * Env:
 *   CDP_HOST   default "localhost"
 *   CDP_PORT   default 9222
 *
 * Output: one line per probed selector with the top-3 matched elements'
 * text + class + first 6 attribute names. Selectors returning `[]` are
 * either absent or drifted — compare against the priority list in
 * extension/speaker-selectors.js. Add newly-working ones to the TOP of
 * that list; the old ones stay as fallbacks.
 *
 * Exit codes:
 *   0  probe completed successfully
 *   1  something broke (no Chrome at CDP port, no Meet tab, CDP error)
 */

const CDP_HOST = process.env.CDP_HOST || "localhost";
const CDP_PORT = Number(process.env.CDP_PORT || 9222);

// Priority list mirrors extension/speaker-selectors.js — keep this in sync
// when the shipped list is updated. Plus chat-post selectors from
// content-isolated.js (MEET-10).
const PROBE_SELECTORS = [
	// Active-speaker tile selectors (plan 104-04)
	'[data-active-speaker="true"]',
	'[class*="active-speaker"]',
	".NWpY1d.active",
	'.xoMHSc[aria-hidden="false"]',
	// Name-extraction selectors (nested lookups against the matched tile)
	"[data-self-name]",
	"[data-name]",
	"[aria-label]",
	// Chat-post selectors (plan 104-04)
	'button[aria-label*="Chat with everyone" i]',
	'button[aria-label*="Chat" i]',
	'textarea[aria-label*="Send a message" i]',
	'button[aria-label*="Send message" i]',
	// Participant-roster selectors (for MEET-13 speaker reconciliation fallback)
	'[data-participant-id]',
	'[aria-label*="participant" i]',
	// Meeting meta (for archive naming + status chip labels)
	'[data-meeting-code]',
	'[data-meeting-title]',
];

async function fetchTabs() {
	const url = `http://${CDP_HOST}:${CDP_PORT}/json/list`;
	try {
		const res = await fetch(url);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		return await res.json();
	} catch (e) {
		console.error(`[probe] cannot reach CDP at ${url} — is bot Chrome launched with --remote-debugging-port=${CDP_PORT}?`);
		console.error(`        underlying error: ${e.message}`);
		process.exit(1);
	}
}

async function main() {
	const tabs = await fetchTabs();
	const meetTab = tabs.find((t) => (t.url || "").includes("meet.google.com/") && !(t.url || "").endsWith("/new"));
	if (!meetTab) {
		console.error("[probe] no meet.google.com tab found (open one in the bot Chrome first, and make sure you've joined a meeting so the DOM is populated)");
		console.error("        tabs seen:");
		for (const t of tabs) console.error(`          ${t.type}  ${t.url}`);
		process.exit(1);
	}
	console.log(`[probe] target tab: ${meetTab.url}`);
	console.log(`[probe] title:      ${meetTab.title}`);
	console.log(`[probe] probing ${PROBE_SELECTORS.length} selectors...\n`);

	// Lazy-load ws (dev dep in meet plugin — should already be available).
	let WS;
	try {
		WS = (await import("ws")).default || (await import("ws")).WebSocket;
	} catch {
		console.error("[probe] cannot load 'ws' — run `npm install` in plugins/meet/ first");
		process.exit(1);
	}

	const sock = new WS(meetTab.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error("CDP ws connect timeout")), 5000);
		sock.once("open", () => { clearTimeout(t); resolve(); });
		sock.once("error", (e) => { clearTimeout(t); reject(e); });
	});

	let idSeq = 0;
	function cdp(method, params = {}) {
		const id = ++idSeq;
		return new Promise((resolve, reject) => {
			const handler = (raw) => {
				let m;
				try { m = JSON.parse(raw.toString()); } catch { return; }
				if (m.id !== id) return;
				sock.off("message", handler);
				if (m.error) reject(new Error(`CDP error for ${method}: ${m.error.message}`));
				else resolve(m.result);
			};
			sock.on("message", handler);
			sock.send(JSON.stringify({ id, method, params }));
		});
	}

	// For each selector: eval in the page, get top-3 matches with a small
	// structural snapshot. Used to be `Array.from(qsa).map(...)` but we wrap
	// in try/catch so an invalid selector (e.g., :has() in older Chrome)
	// doesn't abort the whole probe.
	const driftWarnings = [];
	for (const sel of PROBE_SELECTORS) {
		const expr = `(() => {
			try {
				return Array.from(document.querySelectorAll(${JSON.stringify(sel)}))
					.slice(0, 3)
					.map((e) => ({
						tag: e.tagName.toLowerCase(),
						text: (e.textContent || "").trim().slice(0, 60),
						cls: (e.className || "").toString().slice(0, 80),
						attrs: Array.from(e.attributes || []).map((a) => a.name).slice(0, 6),
					}));
			} catch (err) {
				return { __error: String(err && err.message || err) };
			}
		})()`;
		try {
			const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
			const val = r.result?.value;
			if (val && val.__error) {
				console.log(`  [${sel}]`);
				console.log(`    ERROR: ${val.__error}`);
			} else if (Array.isArray(val) && val.length === 0) {
				console.log(`  [${sel}]  →  [] (no match)`);
				// If this is one of the top-priority active-speaker selectors, log a
				// drift warning
				if (sel === '[data-active-speaker="true"]' || sel === '[class*="active-speaker"]') {
					driftWarnings.push(sel);
				}
			} else {
				console.log(`  [${sel}]`);
				for (const m of val) {
					console.log(`    ${m.tag}  text=${JSON.stringify(m.text)}  cls=${JSON.stringify(m.cls)}  attrs=${JSON.stringify(m.attrs)}`);
				}
			}
		} catch (e) {
			console.log(`  [${sel}]  CDP error: ${e.message}`);
		}
	}

	sock.close();

	console.log("");
	if (driftWarnings.length > 0) {
		console.log("=".repeat(60));
		console.log("DOM DRIFT WARNING");
		console.log("=".repeat(60));
		console.log("The following top-priority selectors matched ZERO elements:");
		for (const s of driftWarnings) console.log(`  - ${s}`);
		console.log("");
		console.log("Likely cause: Google updated Meet's DOM. Action: inspect the");
		console.log("  active speaker tile in DevTools, find a stable attribute,");
		console.log("  and add it to the TOP of SPEAKER_SELECTORS in");
		console.log("  plugins/meet/extension/speaker-selectors.js AND");
		console.log("  plugins/meet/extension/content-isolated.js (sibling copy).");
		process.exit(0);
	}
	console.log("[probe] done — no drift warnings on top-priority selectors.");
	process.exit(0);
}

main().catch((e) => {
	console.error("[probe] uncaught:", e);
	process.exit(1);
});
