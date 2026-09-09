import { test } from "node:test";
import assert from "node:assert/strict";
import { openBotSignin } from "../extension/open-signin.js";

test("opens fixed sign-in URL in a new tab without inspecting or replacing existing tabs", async () => {
	const existing = [{ id: 11, url: "https://meet.google.com/abc-defg-hij" }, { id: 12, url: "about:blank" }];
	const calls = [];
	const chromeApi = { tabs: {
		create: async options => { calls.push(options); return { id: 13 }; },
		query: async () => { throw new Error("must not inspect existing tabs"); },
		update: async () => { throw new Error("must not navigate existing tabs"); },
		remove: async () => { throw new Error("must not close existing tabs"); },
	} };
	assert.deepEqual(await openBotSignin({}, chromeApi), { ok: true, tabId: 13 });
	assert.deepEqual(calls, [{ url: "https://accounts.google.com/signin", active: true }]);
	assert.deepEqual(existing, [{ id: 11, url: "https://meet.google.com/abc-defg-hij" }, { id: 12, url: "about:blank" }]);
	await openBotSignin(undefined, chromeApi);
	assert.equal(calls.length, 2);
});

test("rejects every supplied argument before any Chrome effect", async () => {
	let calls = 0;
	const chromeApi = { tabs: { create: async () => { ++calls; return { id: 1 }; } } };
	for (const args of [null, [], "", 0, false, { url: "https://example.com" }, { tabId: 11 }, { account: "fixture" }, { active: false }]) {
		await assert.rejects(openBotSignin(args, chromeApi), /no arguments accepted/);
	}
	assert.equal(calls, 0);
});

test("failed or unconfirmed Chrome creation never reports success or retries", async () => {
	let attempts = 0;
	await assert.rejects(openBotSignin({}, { tabs: { create: async () => { ++attempts; throw new Error("private browser details"); } } }), error => {
		assert.match(error.message, /could not open/);
		assert.doesNotMatch(error.message, /private browser/);
		return true;
	});
	assert.equal(attempts, 1);
	for (const result of [undefined, {}, { id: -1 }, { id: "3" }]) {
		await assert.rejects(openBotSignin({}, { tabs: { create: async () => result } }), /could not be confirmed/);
	}
});

test("real background RPC dispatch correlates the new route and preserves meet.navigate restrictions", async t => {
	const priorChrome = globalThis.chrome, priorWs = globalThis.WebSocket;
	t.after(() => { globalThis.chrome = priorChrome; globalThis.WebSocket = priorWs; });
	let socket;
	const sends = [], created = [], effects = [];
	class StubSocket {
		listeners = new Map();
		constructor() { socket = this; }
		addEventListener(type, callback) { this.listeners.set(type, callback); }
		send(json) { sends.push(JSON.parse(json)); }
		close() {}
	}
	const listener = { addListener() {} };
	globalThis.WebSocket = StubSocket;
	globalThis.chrome = {
		storage: { local: { get: async () => ({ tek_meet_connection: { port: 52881, token: "synthetic-only" } }), set: async () => {} } },
		runtime: { onMessage: listener, onInstalled: listener, onStartup: listener },
		alarms: { onAlarm: listener },
		tabs: {
			create: async options => { created.push(options); return { id: 42 }; },
			query: async () => { effects.push("query"); return []; },
			update: async () => { effects.push("update"); },
			remove: async () => { effects.push("remove"); },
		},
	};
	await import("../extension/background.js?signin-test");
	await Promise.resolve();
	const receive = message => socket.listeners.get("message")({ data: JSON.stringify(message) });
	await receive({ kind: "call", id: "signin-1", tool: "meet.open-signin", args: {} });
	assert.deepEqual(sends.pop(), { kind: "result", id: "signin-1", value: { ok: true, tabId: 42 } });
	assert.deepEqual(created, [{ url: "https://accounts.google.com/signin", active: true }]);
	await receive({ kind: "call", id: "signin-2", tool: "meet.open-signin", args: { url: "https://example.com" } });
	assert.match(sends.at(-1).error, /no arguments accepted/);
	assert.equal(sends.at(-1).id, "signin-2");
	await receive({ kind: "call", id: "navigate-1", tool: "meet.navigate", args: { url: "https://accounts.google.com/signin" } });
	assert.match(sends.at(-1).error, /meet.navigate: invalid url/);
	assert.equal(created.length, 1);
	assert.deepEqual(effects, []);
});
