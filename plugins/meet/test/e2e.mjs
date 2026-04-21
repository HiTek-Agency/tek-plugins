#!/usr/bin/env node
/**
 * Tek Meet plugin — scripted E2E smoke test (Phase 104 plan 08 / MEET-17).
 *
 * Drives the tek gateway over its chat + plugin WebSocket protocol through a
 * full join → transcribe → archive → Doc cycle against a REAL Google Meet URL.
 *
 * Prereqs (see ./README.md for the full walkthrough):
 *   - Tek gateway running (scripts/update-local.sh --no-desktop && tek gateway start)
 *   - Meet plugin installed at ~/.config/tek/plugins/meet/ AND enabled
 *   - Bot Chrome profile signed into Google at ~/.config/tek/meet/chrome-profile/
 *     (click "Sign bot into Google" in the desktop Plugins → Google Meet panel once)
 *   - A test Meet URL you control (visit https://meet.google.com/new in your own browser
 *     to create one; keep that tab open so the meeting stays alive)
 *
 * Environment:
 *   TEK_MEET_URL       required — the Meet URL the bot should join
 *   TEK_GATEWAY_PORT   optional — defaults to ~/.config/tek/runtime.json port, else 3271
 *   TEK_AGENT_ID       optional — defaults to first agent in ~/.config/tek/config.json
 *   TEK_WAIT_MS        optional — ms to wait after join before kicking (default 120000)
 *
 * Run:
 *   export TEK_MEET_URL="https://meet.google.com/abc-defg-hij"
 *   node ../tek-plugins/plugins/meet/test/e2e.mjs
 *
 * Exits 0 on full pass. Exits 1 on assertion failure. Exits 2 on missing env.
 * Exits 3 on uncaught error.
 *
 * Assertions performed:
 *   1. plugin.meet.status reports connected + meetingId non-null within 60s of join
 *   2. archive dir at ~/.config/tek/meet-transcripts/DATE_CODE_SLUG/ exists
 *   3. raw.jsonl exists in that dir with one or more chunks after the wait window
 *   4. plugin.meet.kick completes with ok:true
 *   5. transcript.md, summary.md, meta.json all exist post-kick
 *   6. meta.json has a "reconciliation" field (pending | unavailable | reconciled | timeout)
 */

import WebSocket from "ws";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── env + config ──────────────────────────────────────────────────────
const MEET_URL = process.env.TEK_MEET_URL;
const WAIT_MS = Number(process.env.TEK_WAIT_MS || 120_000);
const ARCHIVE_ROOT = join(homedir(), ".config", "tek", "meet-transcripts");
const RUNTIME_PATH = join(homedir(), ".config", "tek", "runtime.json");
const CONFIG_PATH = join(homedir(), ".config", "tek", "config.json");

if (!MEET_URL) {
	console.error(`
Tek Meet E2E — missing TEK_MEET_URL.

Usage:
  export TEK_MEET_URL="https://meet.google.com/<test-code>"
  export TEK_GATEWAY_PORT=3271          # optional; auto-detected
  export TEK_AGENT_ID=my-agent          # optional; defaults to first agent
  node test/e2e.mjs

See test/README.md for full walkthrough.
`);
	process.exit(2);
}

function readPort() {
	if (process.env.TEK_GATEWAY_PORT) return Number(process.env.TEK_GATEWAY_PORT);
	try {
		const rt = JSON.parse(readFileSync(RUNTIME_PATH, "utf8"));
		if (rt.port) return Number(rt.port);
	} catch {}
	try {
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		if (cfg.apiEndpoint?.port) return Number(cfg.apiEndpoint.port);
		if (cfg.gateway?.port) return Number(cfg.gateway.port);
	} catch {}
	return 3271;
}

function readAgentId() {
	if (process.env.TEK_AGENT_ID) return process.env.TEK_AGENT_ID;
	try {
		const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		const first = Array.isArray(cfg.agents) ? cfg.agents[0] : null;
		return first?.id || null;
	} catch {}
	return null;
}

const PORT = readPort();
const AGENT_ID = readAgentId();

const log = (...a) => console.log("[E2E]", ...a);
const fail = (m) => {
	console.error("[E2E] FAIL:", m);
	process.exit(1);
};

// ── ws helpers ────────────────────────────────────────────────────────
function openWs() {
	return new Promise((resolve, reject) => {
		const sock = new WebSocket(`ws://127.0.0.1:${PORT}/gateway`);
		const t = setTimeout(() => {
			try { sock.close(); } catch {}
			reject(new Error(`connect timeout ws://127.0.0.1:${PORT}/gateway`));
		}, 5000);
		sock.once("open", () => { clearTimeout(t); resolve(sock); });
		sock.once("error", (e) => { clearTimeout(t); reject(e); });
	});
}

function makeId(prefix = "e2e") {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Register a persistent listener that invokes `predicate` on each message;
// resolves when predicate returns truthy, rejects on timeout. Does NOT
// detach on success by default — returns a cleanup fn so caller can manage.
function waitForMessage(sock, predicate, timeoutMs, label = "message") {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			sock.off("message", handler);
			reject(new Error(`timeout ${timeoutMs}ms waiting for ${label}`));
		}, timeoutMs);
		function handler(raw) {
			let m;
			try { m = JSON.parse(raw.toString()); } catch { return; }
			try {
				if (predicate(m)) {
					clearTimeout(t);
					sock.off("message", handler);
					resolve(m);
				}
			} catch {}
		}
		sock.on("message", handler);
	});
}

async function sendRpc(sock, msg, expectedType, timeoutMs = 10_000) {
	const id = msg.requestId || msg.id || makeId("rpc");
	const out = { ...msg, requestId: id, id };
	const p = waitForMessage(
		sock,
		(m) => m.type === expectedType && (m.requestId === id || m.id === id),
		timeoutMs,
		expectedType,
	);
	sock.send(JSON.stringify(out));
	return p;
}

// Poll plugin.meet.status until meetingId appears (join confirmed) or timeout.
async function waitForJoin(sock, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let lastStatus = null;
	while (Date.now() < deadline) {
		try {
			const r = await sendRpc(
				sock,
				{ type: "plugin.meet.status" },
				"plugin.meet.status.result",
				3000,
			);
			lastStatus = r;
			if (r.connected && r.meetingId) return r;
		} catch {}
		await new Promise((res) => setTimeout(res, 2000));
	}
	return lastStatus;
}

// Install a persistent auto-approver for meet__* tool approval prompts AND a
// chat.stream.end watcher that resolves when the current chat request ends.
function installApproverAndChatWatcher(sock, requestId) {
	const toolApprovalHandler = (raw) => {
		let m;
		try { m = JSON.parse(raw.toString()); } catch { return; }
		if (m.type !== "tool.approval.request") return;
		const tool = m.toolName || "";
		if (!tool.startsWith("meet__") && !tool.startsWith("meet.")) return;
		log(`auto-approving ${tool}`);
		sock.send(JSON.stringify({
			type: "tool.approval.response",
			id: `approve-${m.toolCallId || makeId("app")}`,
			toolCallId: m.toolCallId,
			approved: true,
			sessionApprove: true,
		}));
	};
	sock.on("message", toolApprovalHandler);

	const chatEndP = waitForMessage(
		sock,
		(m) => m.type === "chat.stream.end" && (m.requestId === requestId || m.id === requestId),
		60_000,
		"chat.stream.end",
	);
	return { cleanup: () => sock.off("message", toolApprovalHandler), chatEndP };
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
	log(`connecting to gateway :${PORT}`);
	const sock = await openWs();
	log("gateway connected");

	// 1. Probe plugin.meet.status before join — expect connected=true (extension
	//    handshaken) and meetingId=null (no meeting yet). We don't hard-fail
	//    here because the user may not have opened the bot Chrome yet; the
	//    join request will auto-spawn it.
	try {
		const pre = await sendRpc(
			sock,
			{ type: "plugin.meet.status" },
			"plugin.meet.status.result",
			5000,
		);
		log(`pre-join status: connected=${pre.connected} meetingId=${pre.meetingId ?? "null"}`);
	} catch (e) {
		log(`pre-join status probe timed out: ${e.message} (continuing — join may spawn)`);
	}

	// 2. Drive the join via a chat request (the agent picks the tool).
	//    The tier asymmetry: join_observer is session, so first invocation in
	//    this session WILL prompt for approval — auto-approver handles it.
	if (!AGENT_ID) {
		fail("no agent id available (set TEK_AGENT_ID or create one in ~/.config/tek/config.json)");
	}
	const chatId = makeId("chat-join");
	const { cleanup: stopApprover, chatEndP } = installApproverAndChatWatcher(sock, chatId);

	log(`invoking meet__join_observer for ${MEET_URL}`);
	sock.send(JSON.stringify({
		type: "chat.send",
		id: chatId,
		agentId: AGENT_ID,
		content: `Use the meet__join_observer tool with url: "${MEET_URL}" and then tell me the meeting id. Do not use any other tools.`,
	}));

	// Wait for the chat stream to complete so the tool call has fully resolved
	// on the gateway side before we start polling status.
	try {
		await chatEndP;
		log("chat stream ended — tool call resolved");
	} catch (e) {
		log(`chat stream didn't end cleanly: ${e.message} (continuing — status probe is authoritative)`);
	}

	// 3. Poll plugin.meet.status until meetingId is populated.
	log("waiting for plugin.meet.status to report join (up to 90s)...");
	const joined = await waitForJoin(sock, 90_000);
	if (!joined || !joined.connected || !joined.meetingId) {
		fail(`meet never reached connected+meetingId; last status=${JSON.stringify(joined)}`);
	}
	const meetingId = joined.meetingId;
	log(`plugin.meet.status → connected=true meetingId=${meetingId} mode=${joined.mode ?? "?"}`);

	// 4. Wait for audio pipeline to accumulate chunks.
	log(`waiting ${Math.round(WAIT_MS / 1000)}s for audio/transcript chunks to accumulate...`);
	await new Promise((r) => setTimeout(r, WAIT_MS));

	// 5. Find the archive dir.
	if (!existsSync(ARCHIVE_ROOT)) fail(`archive root missing: ${ARCHIVE_ROOT}`);
	const dirs = readdirSync(ARCHIVE_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && d.name.includes(meetingId));
	if (dirs.length === 0) fail(`no archive dir found under ${ARCHIVE_ROOT} containing meetingId=${meetingId}`);
	const archiveDir = join(ARCHIVE_ROOT, dirs[dirs.length - 1].name);
	log(`archive dir: ${archiveDir}`);

	// 6. Verify raw.jsonl has chunks.
	const rawJsonlPath = join(archiveDir, "raw.jsonl");
	if (!existsSync(rawJsonlPath)) fail(`raw.jsonl missing at ${rawJsonlPath}`);
	const rawContent = readFileSync(rawJsonlPath, "utf8");
	const chunks = rawContent.split("\n").filter((line) => line.trim().length > 0).length;
	log(`raw.jsonl has ${chunks} chunks (${rawContent.length} bytes)`);
	if (chunks < 1) fail("raw.jsonl has 0 chunks — audio pipeline not producing");

	// 7. Kick the bot (triggers onMeetingEnd → archive finalize).
	log("kicking bot to trigger onMeetingEnd...");
	try {
		const kickResult = await sendRpc(
			sock,
			{ type: "plugin.meet.kick" },
			"plugin.meet.kick.result",
			15_000,
		);
		if (!kickResult.ok) fail(`plugin.meet.kick returned ok=false: ${kickResult.error || "unknown"}`);
		log("kick ok");
	} catch (e) {
		fail(`plugin.meet.kick failed: ${e.message}`);
	}

	// 8. Wait a moment for archive finalize to flush.
	await new Promise((r) => setTimeout(r, 3_000));

	// 9. Verify post-meeting artifacts.
	for (const f of ["transcript.md", "summary.md", "meta.json"]) {
		const p = join(archiveDir, f);
		if (!existsSync(p)) fail(`${f} missing from ${archiveDir}`);
		const size = readFileSync(p).length;
		log(`${f} exists (${size} bytes)`);
	}
	let meta;
	try {
		meta = JSON.parse(readFileSync(join(archiveDir, "meta.json"), "utf8"));
	} catch (e) {
		fail(`meta.json not valid JSON: ${e.message}`);
	}
	if (typeof meta.reconciliation !== "string") {
		fail(`meta.json missing reconciliation field (got keys: ${Object.keys(meta).join(", ")})`);
	}
	log(`meta.json reconciliation: ${meta.reconciliation}`);

	stopApprover();
	sock.close();

	log("E2E PASSED");
	log(`  meetingId: ${meetingId}`);
	log(`  chunks:    ${chunks}`);
	log(`  archive:   ${archiveDir}`);
	process.exit(0);
}

main().catch((e) => {
	console.error("[E2E] UNCAUGHT:", e);
	process.exit(3);
});
