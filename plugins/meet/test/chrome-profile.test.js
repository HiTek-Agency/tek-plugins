import { test } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import {
	buildChromeArgs,
	spawnBotChrome,
	stopBotChrome,
	_resetForTests,
} from "../src/chrome-profile.js";

test("buildChromeArgs includes --user-data-dir + --load-extension + about:blank", () => {
	const argv = buildChromeArgs({
		profileDir: "/tmp/test-profile",
		extensionDir: "/tmp/test-ext",
	});
	assert.ok(argv.some((a) => a === "--user-data-dir=/tmp/test-profile"));
	assert.ok(argv.some((a) => a === "--load-extension=/tmp/test-ext"));
	assert.ok(argv.includes("about:blank"), "must open about:blank first");
	assert.ok(argv.includes("--new-window"));
});

test("buildChromeArgs does NOT include the meet URL (CDP-navigates after handshake)", () => {
	const argv = buildChromeArgs({});
	assert.ok(!argv.some((a) => a.includes("meet.google.com")));
});

test("spawnBotChrome uses injected spawnFn with correct args", async () => {
	_resetForTests();
	let captured = null;
	const fakeSpawn = (cmd, args) => {
		captured = { cmd, args };
		return {
			pid: 99999,
			killed: false,
			on: () => {},
			once: () => {},
			kill: () => {},
		};
	};
	const r = await spawnBotChrome({
		meetUrl: "https://meet.google.com/abc-defg-hij",
		logger: { info() {}, warn() {} },
		spawnFn: fakeSpawn,
		profileDir: "/tmp/meet-test-profile",
		extensionDir: "/tmp/meet-test-ext",
	});
	assert.equal(r.pid, 99999);
	assert.ok(captured.cmd.includes("Chrome"));
	assert.ok(captured.args.some((a) => a.startsWith("--user-data-dir=")));
	assert.ok(captured.args.includes("about:blank"));
});

test("spawnBotChrome reuses existing process on second call", async () => {
	_resetForTests();
	let spawnCount = 0;
	const fakeSpawn = () => {
		spawnCount++;
		return {
			pid: 42,
			killed: false,
			on: () => {},
			once: () => {},
			kill: () => {},
		};
	};
	await spawnBotChrome({
		meetUrl: "x",
		logger: { info() {}, warn() {} },
		spawnFn: fakeSpawn,
		profileDir: "/tmp/meet-reuse-profile",
		extensionDir: "/tmp/meet-reuse-ext",
	});
	const r2 = await spawnBotChrome({
		meetUrl: "x",
		logger: { info() {}, warn() {} },
		spawnFn: fakeSpawn,
		profileDir: "/tmp/meet-reuse-profile",
		extensionDir: "/tmp/meet-reuse-ext",
	});
	assert.equal(spawnCount, 1, "spawnFn should only be called once");
	assert.equal(r2.reused, true);
});

function fakeProcess(pid) {
	const proc = new EventEmitter();
	proc.pid = pid;
	proc.killed = false;
	proc.signals = [];
	proc.kill = (signal) => {
		proc.killed = true;
		proc.signals.push(signal);
		return true;
	};
	return proc;
}
const fakeOptions = (proc) => ({
	spawnFn: () => proc,
	logger: { info() {} },
	profileDir: "/tmp/meet-owned-process-test",
	extensionDir: "/tmp/meet-mock-extension",
});

test("a synchronous process exit during SIGTERM is observed and confirmed", async () => {
	_resetForTests();
	const proc = fakeProcess(1);
	proc.kill = () => {
		proc.emit("exit", 0);
		return true;
	};
	await spawnBotChrome(fakeOptions(proc));
	assert.deepEqual(await stopBotChrome(), { stopped: true, forced: false });
	assert.equal((await stopBotChrome()).reason, "not-running");
});

test("unconfirmed forced termination retains handle; late old exit cannot clear a replacement", async (t) => {
	_resetForTests();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const old = fakeProcess(1);
	await spawnBotChrome(fakeOptions(old));
	const stopping = stopBotChrome();
	assert.deepEqual(old.signals, ["SIGTERM"]);
	t.mock.timers.tick(5000);
	assert.deepEqual(await stopping, {
		stopped: false,
		forced: true,
		reason: "termination-unconfirmed",
	});
	const retry = stopBotChrome();
	assert.deepEqual(
		old.signals,
		["SIGTERM", "SIGKILL", "SIGTERM"],
		"unconfirmed process remains reachable for explicit retry",
	);
	const replacement = fakeProcess(2);
	await spawnBotChrome(fakeOptions(replacement));
	old.emit("exit", 0);
	assert.equal((await retry).stopped, true);
	const reused = await spawnBotChrome(fakeOptions(fakeProcess(3)));
	assert.equal(
		reused.pid,
		2,
		"old exit and stop completion cannot clear replacement handle",
	);
	assert.equal(reused.reused, true);
	_resetForTests();
});
