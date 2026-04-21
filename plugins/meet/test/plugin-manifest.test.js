import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(__dirname, "..");

test("plugin.json is valid JSON with id='meet'", () => {
	const raw = readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8");
	const m = JSON.parse(raw);
	assert.equal(m.id, "meet");
	assert.equal(m.name, "Google Meet");
	assert.equal(m.entryPoint, "src/index.js");
});

test("plugin.json providesTools has both meet tools", () => {
	const m = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8"));
	assert.ok(m.providesTools.includes("meet__join_observer"));
	assert.ok(m.providesTools.includes("meet__join_participant"));
});

test("plugin.json configSchema has required keys", () => {
	const m = JSON.parse(readFileSync(join(PLUGIN_DIR, "plugin.json"), "utf8"));
	const keys = m.configSchema.map((k) => k.key);
	for (const k of [
		"wsPort",
		"wakeWordPhrases",
		"silenceTimeoutMs",
		"botDisplayName",
		"whisperModelPath",
	]) {
		assert.ok(keys.includes(k), `configSchema missing ${k}`);
	}
});

test("extension/manifest.json declares tabCapture + offscreen + scripting", () => {
	const m = JSON.parse(
		readFileSync(join(PLUGIN_DIR, "extension/manifest.json"), "utf8"),
	);
	for (const p of ["tabCapture", "debugger", "tabs", "scripting", "offscreen"]) {
		assert.ok(
			m.permissions.includes(p),
			`extension manifest missing permission ${p}`,
		);
	}
	assert.ok(
		m.host_permissions.some((h) => h.includes("meet.google.com")),
		"host_permissions missing meet.google.com",
	);
});

test("src/index.js exists and exports register", async () => {
	const mod = await import(join(PLUGIN_DIR, "src/index.js"));
	assert.equal(typeof mod.register, "function");
});

// CRITICAL per checker blocker-3: enforce approval tier asymmetry
test("src/index.js declares approvalTier:'session' exactly once (observer)", () => {
	const src = readFileSync(join(PLUGIN_DIR, "src/index.js"), "utf8");
	const matches = src.match(/approvalTier\s*:\s*["']session["']/g) || [];
	assert.equal(
		matches.length,
		1,
		`expected exactly one approvalTier:'session', got ${matches.length}`,
	);
});

test("src/index.js declares approvalTier:'always' exactly once (participant)", () => {
	const src = readFileSync(join(PLUGIN_DIR, "src/index.js"), "utf8");
	const matches = src.match(/approvalTier\s*:\s*["']always["']/g) || [];
	assert.equal(
		matches.length,
		1,
		`expected exactly one approvalTier:'always', got ${matches.length}`,
	);
});
