import { test } from "node:test";
import assert from "node:assert/strict";
import {
	buildChromeArgs,
	spawnBotChrome,
	_resetForTests,
} from "../src/chrome-profile.js";

test("buildChromeArgs includes --user-data-dir + --load-extension + about:blank", () => {
	const argv = buildChromeArgs({ profileDir: "/tmp/test-profile", extensionDir: "/tmp/test-ext" });
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
		return { pid: 42, killed: false, on: () => {}, once: () => {}, kill: () => {} };
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
