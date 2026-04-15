#!/usr/bin/env node
/**
 * Phase 101 SC-9 end-to-end test.
 *
 * Drives the tek gateway over its chat WebSocket (same protocol as the desktop
 * app) through five prompts that exercise the chrome-control tool surface:
 *   1. screenshot
 *   2. navigate + read_page
 *   3. find + click
 *   4. form_input
 *   5. javascript_tool (auto-approves the dangerous-tier approval gate)
 *
 * Prereqs:
 *   - Tek gateway running (scripts/update-local.sh && tek gateway start)
 *   - Chrome plugin installed and ENABLED
 *   - Chrome extension loaded unpacked, popup shows "Connected" (green)
 *   - At least one agent configured with the chrome tool group enabled
 *     (full or developer profile)
 *
 * Run:
 *   node test/e2e.mjs --agent <agentId> \
 *                     [--gateway-port 3271] \
 *                     [--fixture-url file:///abs/path/to/test-page.html]
 *
 * The gateway WS listens on 127.0.0.1:<apiEndpoint.port> and does not require
 * a bearer token for loopback connections — it treats loopback/Tailscale as
 * pre-authenticated at the network layer. See gateway/src/ws/server.ts.
 */
import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── argv parsing ──────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
	const v = process.argv[i];
	if (v.startsWith("--")) {
		const key = v.slice(2);
		const next = process.argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			args[key] = true;
		} else {
			args[key] = next;
			i++;
		}
	}
}

const AGENT_ID = args.agent || process.env.TEK_AGENT_ID;
if (!AGENT_ID) {
	console.error("usage: node test/e2e.mjs --agent <agentId> [--gateway-port N] [--fixture-url URL]");
	process.exit(2);
}

// ── gateway port from ~/.config/tek/config.json ──────────────────────
const CONFIG_PATH = join(homedir(), ".config", "tek", "config.json");
let config = {};
try {
	config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
} catch (err) {
	console.error(`could not read ${CONFIG_PATH}: ${err.message}`);
	process.exit(2);
}
const PORT =
	Number(args["gateway-port"]) ||
	config.apiEndpoint?.port ||
	config.gateway?.port ||
	3271;

// ── fixture URL ──────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE =
	args["fixture-url"] || `file://${resolve(__dirname, "fixtures", "test-page.html")}`;

// ── prompts ──────────────────────────────────────────────────────────
const PROMPTS = [
	{
		name: "screenshot",
		prompt: `Take a screenshot of my current Chrome tab.`,
	},
	{
		name: "navigate+read",
		prompt: `Navigate the active tab to ${FIXTURE} and then read the page and tell me the value of the h1.`,
	},
	{
		name: "find+click",
		prompt: `On the current tab, find the link with id "target-link" and click it. Then read the page and tell me what the click-receipt paragraph says.`,
	},
	{
		name: "form_input",
		prompt: `On the current tab, type the text "hello-tek-e2e" into the input with id "target-input". Then read the page and tell me what the input-mirror paragraph says.`,
	},
	{
		name: "javascript_tool",
		prompt: `Use the chrome javascript tool to evaluate the expression: window.__tekE2E.ready`,
	},
];

// ── helpers ──────────────────────────────────────────────────────────
function openWs() {
	return new WebSocket(`ws://127.0.0.1:${PORT}/gateway`);
}

async function runOne(prompt, name) {
	return new Promise((resolveP) => {
		const sock = openWs();
		const events = [];
		const reqId = `e2e-${name}-${Date.now()}`;

		const timer = setTimeout(() => {
			try {
				sock.close();
			} catch {}
			resolveP({ name, ok: false, reason: "timeout 120s", events });
		}, 120_000);

		sock.on("open", () => {
			sock.send(
				JSON.stringify({
					type: "chat.send",
					id: reqId,
					agentId: AGENT_ID,
					content: prompt,
				}),
			);
		});

		sock.on("message", (raw) => {
			let m;
			try {
				m = JSON.parse(raw.toString());
			} catch {
				return;
			}
			events.push(m);

			// Auto-approve any pending tool approval (chrome__javascript_tool is
			// marked dangerous and will request one on first use per session).
			if (m.type === "tool.approval.request") {
				sock.send(
					JSON.stringify({
						type: "tool.approval.response",
						id: `approve-${m.toolCallId}`,
						toolCallId: m.toolCallId,
						approved: true,
						sessionApprove: true,
					}),
				);
			}

			if (m.type === "chat.stream.end" && m.requestId === reqId) {
				clearTimeout(timer);
				try {
					sock.close();
				} catch {}
				const toolCalls = events.filter((e) => e.type === "tool.call");
				const toolResults = events.filter((e) => e.type === "tool.result");
				const images = events.filter((e) => e.type === "image.generated");
				resolveP({ name, ok: true, toolCalls, toolResults, images, events });
			}
		});

		sock.on("error", (e) => {
			clearTimeout(timer);
			resolveP({ name, ok: false, reason: e.message, events });
		});
	});
}

function assertContainsTool(result, toolNamePattern) {
	const re = new RegExp(toolNamePattern);
	const found = result.toolCalls?.some((c) => re.test(c.toolName || ""));
	return found ? null : `expected tool matching /${toolNamePattern}/ not called`;
}

// ── main ─────────────────────────────────────────────────────────────
(async () => {
	console.log(`Tek E2E — agent=${AGENT_ID} port=${PORT} fixture=${FIXTURE}`);
	const results = [];
	for (const p of PROMPTS) {
		process.stdout.write(`\n[${p.name}] ${p.prompt}\n`);
		const r = await runOne(p.prompt, p.name);
		let assertion = null;
		if (r.ok) {
			if (p.name === "screenshot") {
				assertion =
					assertContainsTool(r, "chrome__screenshot") ||
					(r.images.length ? null : "no image.generated emitted");
			}
			if (p.name === "navigate+read") {
				// Both tools must fire — assertContainsTool returns null on success.
				const navMiss = assertContainsTool(r, "chrome__navigate");
				const readMiss = assertContainsTool(r, "chrome__read_page");
				assertion = navMiss && readMiss
					? "expected chrome__navigate AND chrome__read_page to be called"
					: navMiss || readMiss;
			}
			if (p.name === "find+click") {
				assertion = assertContainsTool(r, "chrome__(find|click)");
			}
			if (p.name === "form_input") {
				assertion = assertContainsTool(r, "chrome__form_input");
			}
			if (p.name === "javascript_tool") {
				assertion = assertContainsTool(r, "chrome__javascript_tool");
			}
		}
		results.push({ ...r, assertion });
		process.stdout.write(
			`  → ${r.ok ? (assertion ? `FAIL: ${assertion}` : "PASS") : `ERROR: ${r.reason}`}\n`,
		);
	}

	const failed = results.filter((r) => !r.ok || r.assertion);
	console.log(`\n${"=".repeat(60)}`);
	console.log(`E2E SUMMARY: ${results.length - failed.length}/${results.length} passed`);
	for (const r of results) {
		const status = !r.ok ? "ERROR" : r.assertion ? "FAIL" : "PASS";
		console.log(
			`  ${status.padEnd(5)} ${r.name}${r.assertion ? ` — ${r.assertion}` : ""}${r.reason ? ` — ${r.reason}` : ""}`,
		);
	}
	process.exit(failed.length === 0 ? 0 : 1);
})();
