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
 * The gateway requires TEK_GATEWAY_TOKEN even on loopback. Supply it via a
 * local credential provider, never a command-line argument. Open and grant ONLY
 * the fixture tab before running. The test never grants browser access itself.
 */
import WebSocket from "ws";
import { readFileSync, writeFileSync } from "node:fs";
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
		prompt: `Call chrome__screenshot for the fixture tab and finish.`,
	},
	{
		name: "navigate+read",
		prompt: `Call chrome__navigate with the fixture tab ID and url ${FIXTURE} and then read the page and tell me the value of the h1.`,
	},
	{
		name: "find+click",
		prompt: `Use chrome__find to find the link named "Click me". Then use chrome__click with selector "#target-link" on the fixture tab. Read the page and confirm CLICKED_OK.`,
	},
	{
		name: "form_input",
		prompt: `Call chrome__form_input with selector "#target-input", text "hello-tek-e2e", clear true, and the fixture tab ID. Read the page and confirm TYPED:hello-tek-e2e.`,
	},
	{
		name: "javascript_tool",
		prompt: `Use the chrome javascript tool to evaluate the expression: window.__tekE2E.ready`,
	},
];

// ── helpers ──────────────────────────────────────────────────────────
const gatewayToken = process.env.TEK_GATEWAY_TOKEN;
if (!gatewayToken) {
    console.error("Set TEK_GATEWAY_TOKEN through a local credential provider; the gateway requires authentication.");
    process.exit(2);
}
function openWs() {
    return new WebSocket(`ws://127.0.0.1:${PORT}/gateway`, ["tek-auth", `tek-token.${gatewayToken}`]);
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
			resolveP({ name, ok: false, reason: "timeout 180s", events });
		}, 180_000);

		sock.on("open", () => {
			sock.send(
				JSON.stringify({
					type: "chat.send",
					id: reqId,
					agentId: AGENT_ID,
					content: `Use only the already-open, user-granted test tab at ${FIXTURE}. Identify it by that exact URL. Do not navigate, read, screenshot, or change any other tab. If it is missing or not granted, stop and report that. Use only chrome__ tools for this test. ${prompt}`,
                    ...(args.model ? { model: args.model } : {}),
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

			// Approve only Chrome tools within the explicitly granted fixture test (the JS tool is
			// marked dangerous and will request one on first use per session).
			if (m.type === "tool.approval.request") {
				sock.send(
					JSON.stringify({
						type: "tool.approval.response",
						id: `approve-${m.toolCallId}`,
						toolCallId: m.toolCallId,
						approved: typeof m.toolName === "string" && m.toolName.startsWith("chrome__"),
						sessionApprove: false,
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

        sock.on("close", (code, reason) => {
            clearTimeout(timer);
            resolveP({ name, ok: false, reason: `socket closed ${code}: ${String(reason)}`, events });
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
				assertion = assertContainsTool(r, "chrome__find") || assertContainsTool(r, "chrome__click");
			}
			if (p.name === "form_input") {
				assertion = assertContainsTool(r, "chrome__form_input");
			}
			if (p.name === "javascript_tool") {
				assertion = assertContainsTool(r, "chrome__javascript_tool");
			}
		}
        if (r.ok && !assertion) {
            const failedTool = r.events.find((event) => {
                let result = event.result;
                if (typeof result === "string") { try { result = JSON.parse(result); } catch {} }
                return event.type === "tool.error" || event.type === "tool.result" && (event.isError || event.error || result?.success === false || result?.ok === false || result?.error);
            });
            if (failedTool) assertion = `tool reported failure: ${failedTool.toolName ?? failedTool.toolCallId}`;
        }
		const text = r.events.filter((event) => event.type === "tool.result" || event.type === "chat.stream.delta").map((event) => JSON.stringify(event)).join("\n");
        if (r.ok && !assertion && p.name === "find+click" && !text.includes("CLICKED_OK")) assertion = "click receipt missing";
        if (r.ok && !assertion && p.name === "form_input" && !text.includes("TYPED:hello-tek-e2e")) assertion = "input receipt missing";
        results.push({ ...r, assertion });
        if (!r.ok || assertion) {
            console.log("  calls:", r.events.filter((event) => event.type === "tool.call").map((event) => event.toolName).join(", "));
            console.log("  errors:", r.events.filter((event) => event.type === "error" || event.type === "tool.error").map((event) => event.error || event.message).join("; "));
        }
		process.stdout.write(
			`  → ${r.ok ? (assertion ? `FAIL: ${assertion}` : "PASS") : `ERROR: ${r.reason}`}\n`,
		);
	}

	if (typeof args.report === "string") {
        // Strip image bytes and tab-list contents; keep fixture actions for diagnosis.
        writeFileSync(args.report, JSON.stringify(results.map(({ events, images, ...result }) => ({
            ...result, toolResults: undefined, events: events.filter((event) => ["tool.call", "tool.error", "error", "chat.stream.delta", "chat.stream.end"].includes(event.type)),
        })), null, 2), { mode: 0o600 });
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
