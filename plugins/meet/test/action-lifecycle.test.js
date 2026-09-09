import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";

// Exercise register() and its actual tool/WS closures. All host I/O, browser,
// transcription, archive and Google effects are replaced before importing it.
let server;
class FakeServer extends EventEmitter {
	constructor() {
		super();
		server = this;
	}
	closed = false;
	close() {
		this.closed = true;
	}
}
class FakeSocket extends EventEmitter {
	calls = [];
	closed = false;
	reply = (message) =>
		message.tool === "meet.start-capture"
			? { ok: true, meetingId: message.args.meetingId }
			: message.tool === "meet.stop-capture"
				? { ok: true }
				: {};
	send(raw) {
		const message = JSON.parse(raw);
		if (message.kind !== "call") return;
		this.calls.push(message);
		const value = this.reply(message);
		if (value !== undefined)
			this.message({ kind: "result", id: message.id, value });
	}
	message(value) {
		this.emit("message", Buffer.from(JSON.stringify(value)));
	}
	close() {
		this.closed = true;
		this.emit("close");
	}
}
const deferred = () => {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
const logger = { info() {}, warn() {}, error() {}, debug() {} };
let state;
mock.module("ws", { namedExports: { WebSocketServer: FakeServer } });
mock.module("node:fs", {
	namedExports: {
		...fs,
		existsSync: () => true,
		readFileSync: () => "a".repeat(64),
		mkdirSync() {},
		writeFileSync() {},
		chmodSync() {},
	},
});
mock.module("../src/chrome-profile.js", {
	namedExports: {
		spawnBotChrome: (...args) => {
			state.spawns.push(args);
			return state.spawn(...args);
		},
		stopBotChrome: () => {
			state.stops++;
			return state.stop();
		},
	},
});
mock.module("../src/meet-transcriber.js", {
	namedExports: {
		createTranscriber: (options) => {
			state.transcriberOptions.push(options);
			return state.create();
		},
	},
});
mock.module("../src/raw-jsonl-writer.js", {
	namedExports: {
		resolveArchiveDir: ({ meetCode }) => `/mock-only/${meetCode}`,
		appendChunk: (...args) => state.chunks.push(args),
	},
});
mock.module("../src/archive-writer.js", {
	namedExports: {
		finalize: (...args) => {
			state.finalizes.push(args);
			return state.finalize();
		},
	},
});
mock.module("../src/summarize.js", {
	namedExports: { writeSummaryMd: (...args) => state.summaries.push(args) },
});
mock.module("../src/doc-creator.js", {
	namedExports: {
		createMeetingDoc: async () => {
			state.docs++;
			return {};
		},
	},
});
mock.module("../src/meet-reconciler.js", {
	namedExports: {
		startReconciliation: async () => {
			state.reconciliations++;
			return { promise: Promise.resolve({ status: "mock" }) };
		},
	},
});
const plugin = await import("../src/index.js");
let handlers;
let tools;
let registered;
let ctx;
function transcriber() {
	const instance = {
		shutdowns: 0,
		frames: [],
		async shutdown() {
			instance.shutdowns++;
		},
		async ingestFrame(...args) {
			instance.frames.push(args);
		},
	};
	state.transcribers.push(instance);
	return instance;
}
function connect(role = "control") {
	const socket = new FakeSocket();
	server.emit("connection", socket);
	socket.message(
		role === "control"
			? { kind: "hello" }
			: { kind: "hello-offscreen", role: "audio-source" },
	);
	return socket;
}
const join = (code = "abc-defg-hij", participant = false) =>
	tools
		.get(participant ? "join_participant" : "join_observer")
		.execute({ url: `https://meet.google.com/${code}` });
const status = () => handlers.get("status")({ id: "status-id" });
const kick = (args = {}) => handlers.get("kick")({ id: "stop-id", ...args });
const signin = (args = {}) =>
	handlers.get("open-signin")({ id: "signin-id", ...args });
beforeEach(async () => {
	state = {
		spawns: [],
		stops: 0,
		spawn: async () => ({}),
		stop: async () => ({}),
		transcriberOptions: [],
		transcribers: [],
		create: async () => transcriber(),
		chunks: [],
		finalizes: [],
		finalize: async () => ({}),
		summaries: [],
		docs: 0,
		reconciliations: 0,
	};
	handlers = new Map();
	tools = new Map();
	ctx = {
		logger,
		getConfig: () => ({}),
		addWsHandler: (name, handler) => handlers.set(name, handler),
		addTool: (name, tool) => tools.set(name, tool),
	};
	registered = await plugin.register(ctx);
});
afterEach(async () => {
	await registered.cleanup();
});

test("status advertises conditional controls; mismatched kick/sign-in has no effects", async () => {
	const control = connect();
	assert.equal((await join()).ok, true);
	assert.equal((await status()).conditionalControlsVersion, 1);
	const before = state.spawns.length;
	for (const expectedMeetingId of ["other-room", null, 42]) {
		const refusal = await kick({ expectedMeetingId });
		assert.equal(refusal.code, "MEET_CONFLICT");
		assert.equal(refusal.id, "stop-id");
		assert.equal(refusal.requestId, "stop-id");
	}
	assert.equal(
		(await signin({ expectedMeetingId: null })).code,
		"MEET_CONFLICT",
	);
	assert.equal((await signin()).code, "MEET_BUSY");
	assert.equal(state.spawns.length, before);
	assert.equal(state.stops, 0);
	assert.equal(state.transcribers[0].shutdowns, 0);
	assert.equal(control.closed, false);
	assert.equal((await kick({ expectedMeetingId: "abc-defg-hij" })).ok, true);
	assert.equal(state.transcribers[0].shutdowns, 1);
});

test("legacy emergency kick starts Chrome stop before slow flush and blocks replacements until settled", async () => {
	connect();
	await join();
	const flush = deferred();
	state.transcribers[0].shutdown = () => flush.promise;
	const stopping = kick();
	assert.equal(
		state.stops,
		1,
		"browser stop begins synchronously before transcriber shutdown",
	);
	assert.equal((await status()).operation, "stop");
	assert.equal((await join("new-room")).code, "MEET_BUSY");
	assert.equal((await signin()).code, "MEET_BUSY");
	assert.equal((await kick()).code, "MEET_BUSY");
	const duringStop = connect();
	assert.equal(duringStop.closed, true);
	flush.resolve();
	assert.equal((await stopping).ok, true);
	connect();
	assert.equal((await join("new-room")).ok, true);
});

test("kick cancels pending transcriber setup without dispatching Chrome, and disposes a late transcriber", async () => {
	const init = deferred();
	state.create = () => init.promise;
	const joining = join();
	assert.equal((await status()).meetingId, "abc-defg-hij");
	const stopping = kick({ expectedMeetingId: "abc-defg-hij" });
	assert.equal(state.stops, 1);
	assert.equal((await signin()).code, "MEET_BUSY");
	const late = transcriber();
	init.resolve(late);
	assert.equal((await joining).code, "MEET_CANCELLED");
	assert.equal((await stopping).ok, true);
	assert.equal(late.shutdowns, 1);
	assert.equal(state.spawns.length, 0);
	state.transcriberOptions[0].emitChunk({ text: "late old chunk" });
	assert.equal(state.chunks.length, 0);
});

test("pending Chrome spawn is stopped immediately and again after late settlement, before replacement join", async () => {
	const spawn = deferred();
	state.spawn = () => spawn.promise;
	const joining = join();
	await turn();
	assert.equal(state.spawns.length, 1);
	const stopping = kick();
	assert.equal(state.stops, 1);
	assert.equal((await join("new-room")).code, "MEET_BUSY");
	spawn.resolve({});
	assert.equal((await joining).code, "MEET_CANCELLED");
	await stopping;
	assert.equal(state.stops, 2);
	state.spawn = async () => ({});
	const control = connect();
	await join("new-room");
	assert.equal(
		control.calls.length,
		2,
		"only replacement navigate/capture dispatched",
	);
});

test("emergency kick interrupts handshake polling rather than waiting thirty seconds", async () => {
	const joining = join();
	await turn();
	assert.equal(state.spawns.length, 1);
	await kick({ expectedMeetingId: "abc-defg-hij" });
	assert.equal((await joining).code, "MEET_CANCELLED");
});

test("kick interrupts pending navigation and ignores late results before a new meeting", async () => {
	const old = connect();
	old.reply = () => undefined;
	const joining = join();
	await turn();
	assert.equal(old.calls.length, 1);
	const navId = old.calls[0].id;
	await kick();
	assert.equal((await joining).code, "MEET_CANCELLED");
	const current = connect();
	await join("new-room");
	old.message({ kind: "result", id: navId, value: { tabId: 99 } });
	old.message({ kind: "meet.in-call-ended", meetingId: "abc-defg-hij" });
	await turn();
	assert.equal((await status()).meetingId, "new-room");
	assert.equal(
		old.calls.length,
		1,
		"cancelled join never starts capture or announces",
	);
	assert.equal(current.calls.length, 2);
	assert.equal(state.finalizes.length, 0);
});

test("kick interrupts transparency delay; no announce is sent after stop", async () => {
	const control = connect();
	control.reply = (message) =>
		message.tool === "meet.navigate"
			? { tabId: 7 }
			: { ok: true, meetingId: "abc-defg-hij" };
	const joining = join();
	await turn();
	assert.deepEqual(
		control.calls.map((call) => call.tool),
		["meet.navigate", "meet.start-capture"],
	);
	await kick();
	assert.equal((await joining).code, "MEET_CANCELLED");
	assert.equal(control.calls.length, 2);
});

test("sign-in owns its asynchronous spawn, refuses join/second sign-in, and kick cancels late navigation", async () => {
	const control = connect();
	const spawn = deferred();
	state.spawn = () => spawn.promise;
	const signingIn = signin({ expectedMeetingId: null });
	assert.equal((await status()).operation, "signin");
	assert.equal((await join()).code, "MEET_BUSY");
	assert.equal((await signin()).code, "MEET_BUSY");
	const stopping = kick({ expectedMeetingId: null });
	spawn.resolve({});
	assert.equal((await signingIn).code, "MEET_CANCELLED");
	await stopping;
	assert.equal(control.calls.length, 0);
	assert.equal(state.stops, 2);
});

test("sign-in refuses a pending join and reports actual navigation failure", async () => {
	const init = deferred();
	state.create = () => init.promise;
	const joining = join();
	assert.equal((await signin()).code, "MEET_BUSY");
	assert.equal(state.spawns.length, 0);
	const stopping = kick();
	init.resolve(transcriber());
	await joining;
	await stopping;
	const control = connect();
	control.send = () => {
		throw new Error("socket send failed");
	};
	const result = await signin({ expectedMeetingId: null });
	assert.equal(result.ok, false);
	assert.match(result.error, /socket send failed/);
	assert.equal(result.requestId, "signin-id");
});

test("control and audio connections coexist; only current meeting audio is ingested", async () => {
	const control = connect();
	await join();
	const audio = connect("audio");
	assert.equal(plugin._getActiveSocket(), control);
	assert.equal((await status()).connected, true);
	audio.message({
		kind: "meet.audio.frame",
		meetingId: "wrong",
		frame: "ignored",
	});
	audio.message({
		kind: "meet.audio.frame",
		meetingId: "abc-defg-hij",
		frame: "owned",
		t: 10,
	});
	audio.message({ kind: "meet.in-call-ended", meetingId: "abc-defg-hij" });
	await turn();
	assert.deepEqual(state.transcribers[0].frames, [["owned", 10, false]]);
	assert.equal(state.finalizes.length, 0);
	assert.deepEqual(await plugin._rpc("test.control", {}), {});
	assert.equal(control.calls.at(-1).tool, "test.control");
	assert.equal(audio.calls.length, 0);
	await kick();
	assert.equal(audio.closed, true);
	assert.equal(control.closed, true);
	connect();
	await join("new-room");
	audio.message({
		kind: "meet.audio.frame",
		meetingId: "new-room",
		frame: "stale",
	});
	assert.equal(state.transcribers[1].frames.length, 0);
});

test("control reconnect rejects old calls and cannot spoof results or end events", async () => {
	const old = connect();
	await join();
	old.reply = () => undefined;
	const pending = plugin._rpc("test.wait", {}).catch((error) => error);
	const current = connect();
	assert.equal(old.closed, true);
	assert.match((await pending).message, /stopped/);
	current.reply = () => undefined;
	const replacement = plugin._rpc("test.new", {});
	const id = current.calls[0].id;
	old.message({ kind: "result", id, value: "stale" });
	current.message({ kind: "result", id, value: "current" });
	assert.equal(await replacement, "current");
	old.message({ kind: "meet.in-call-ended", meetingId: "abc-defg-hij" });
	await turn();
	assert.equal(state.finalizes.length, 0);
});

test("late wake-word model or TTS completions cannot speak in a replacement meeting", async () => {
	for (const stage of ["model", "tts"]) {
		const old = connect();
		await join(`old-${stage}`, true);
		const reply = deferred();
		let ttsCalls = 0;
		ctx.generateReply = () =>
			stage === "model" ? reply.promise : Promise.resolve({ text: "answer" });
		ctx.generateTts = () => {
			ttsCalls++;
			return reply.promise;
		};
		const speaking = plugin.__test__.handleWakeWord({
			text: "hey tek question",
			matchedPhrase: "hey tek",
		});
		await turn();
		await kick();
		const current = connect();
		await join(`new-${stage}`, true);
		reply.resolve(
			stage === "model" ? { text: "late reply" } : { pcmBase64: "AA==" },
		);
		await speaking;
		assert.equal(ttsCalls, stage === "model" ? 0 : 1);
		assert.equal(
			old.calls.some((call) => call.tool === "meet.play-tts"),
			false,
		);
		assert.equal(
			current.calls.some((call) => call.tool === "meet.play-tts"),
			false,
		);
		assert.equal(plugin.__test__._getFsm().currentState(), "observing");
		await kick();
	}
});

test("kick fences pending finalization and keeps replacement blocked until that work settles", async () => {
	const control = connect();
	await join();
	const finalizing = deferred();
	state.finalize = () => finalizing.promise;
	control.message({ kind: "meet.in-call-ended", meetingId: "abc-defg-hij" });
	await turn();
	assert.equal(state.finalizes.length, 1);
	const stopping = kick();
	assert.equal(state.stops, 1);
	assert.equal((await join("new-room")).code, "MEET_BUSY");
	finalizing.resolve({});
	await stopping;
	assert.equal(state.summaries.length, 0);
	assert.equal(state.docs, 0);
	assert.equal(state.reconciliations, 0);
	connect();
	await join("new-room");
	control.message({ kind: "meet.in-call-ended", meetingId: "new-room" });
	await turn();
	assert.equal((await status()).meetingId, "new-room");
});

test("natural end runs once, releases resources, and late flush callbacks cannot write to a new archive", async () => {
	const control = connect();
	await join();
	control.message({ kind: "meet.in-call-ended", meetingId: "abc-defg-hij" });
	control.message({ kind: "meet.in-call-ended", meetingId: "abc-defg-hij" });
	await turn();
	assert.equal(state.finalizes.length, 1);
	assert.equal(state.transcribers[0].shutdowns, 1);
	assert.equal((await status()).meetingId, null);
	connect();
	await join("new-room");
	state.transcriberOptions[0].emitChunk({ text: "old flush" });
	state.transcriberOptions[1].emitChunk({ text: "new flush" });
	assert.equal(state.chunks.length, 1);
	assert.equal(state.chunks[0][0], "/mock-only/new-room");
});

test("registered cleanup cancels pending join and stays unloaded until register", async () => {
	const joining = join();
	await turn();
	await registered.cleanup();
	assert.equal((await joining).code, "MEET_CANCELLED");
	assert.equal((await join()).code, "MEET_BUSY");
	assert.equal((await signin()).code, "MEET_BUSY");
	assert.equal(
		state.finalizes.length,
		0,
		"registered cleanup remains stop-only",
	);
});

test("stop retains the displayed meeting until cleanup succeeds, and failure evidence until explicit retry", async () => {
	connect();
	await join();
	const stop = deferred();
	state.stop = () => stop.promise;
	const stopping = kick({ expectedMeetingId: "abc-defg-hij" });
	assert.equal((await status()).meetingId, "abc-defg-hij");
	assert.equal((await status()).operation, "stop");
	stop.resolve({ stopped: false, reason: "termination-unconfirmed" });
	assert.equal((await stopping).ok, false);
	assert.equal((await status()).meetingId, "abc-defg-hij");
	assert.equal((await status()).operation, "stop-failed");
	assert.equal((await join("new-room")).code, "MEET_BUSY");
	assert.equal((await signin()).code, "MEET_BUSY");
	state.stop = async () => ({ stopped: true });
	assert.equal((await kick({ expectedMeetingId: "abc-defg-hij" })).ok, true);
	assert.equal((await status()).meetingId, null);
	assert.equal((await status()).operation, null);
});

test("kick flushes only into the captured archive, suppresses wake, then closes the old sink", async () => {
	connect();
	await join("abc-defg-hij", true);
	const emit = state.transcriberOptions[0].emitChunk;
	const flush = deferred();
	let replies = 0;
	ctx.generateReply = async () => {
		replies++;
		return { text: "must not run" };
	};
	state.transcribers[0].shutdown = async () => {
		emit({ text: "hey tek tail", t_end_ms: Date.now() });
		await flush.promise;
	};
	const stopping = kick();
	await turn();
	assert.equal(state.stops, 1);
	assert.equal(state.chunks.length, 1);
	assert.equal(state.chunks[0][0], "/mock-only/abc-defg-hij");
	assert.equal(state.chunks[0][1].meetingId, "abc-defg-hij");
	assert.equal(replies, 0);
	flush.resolve();
	await stopping;
	connect();
	await join("new-room");
	emit({ text: "too late" });
	assert.equal(state.chunks.length, 1);
});

test("invalid or foreign Meet URLs cannot initialize a meeting without an identity", async () => {
	for (const url of [
		"https://meet.google.com/",
		"https://meet.google.com/landing",
		"https://evil.test/meet.google.com/abc-defg-hij",
		"http://meet.google.com/abc-defg-hij",
	]) {
		const result = await tools.get("join_observer").execute({ url });
		assert.equal(result.reason, "invalid-url");
		assert.equal((await status()).meetingId, null);
	}
	assert.equal(state.spawns.length, 0);
	assert.equal(state.transcriberOptions.length, 0);
});

test("registration cleanup is coalesced and cannot close or stop a newer registration", async () => {
	const oldRegistration = registered;
	const oldHandlers = handlers;
	const oldServer = server;
	const stop = deferred();
	state.stop = () => stop.promise;
	const unloading = registered.cleanup();
	const repeated = registered.cleanup();
	assert.equal(state.stops, 1);
	await assert.rejects(
		plugin.register(ctx),
		/already registered or still unloading/,
	);
	stop.resolve({ stopped: true });
	await unloading;
	await repeated;
	assert.equal(oldServer.closed, true);
	state.stop = async () => ({ stopped: true });
	handlers = new Map();
	tools = new Map();
	registered = await plugin.register(ctx);
	const currentServer = server;
	connect();
	await join("new-room");
	const stopsBeforeStaleCleanup = state.stops;
	await oldRegistration.cleanup();
	assert.equal((await oldHandlers.get("kick")({})).code, "MEET_BUSY");
	assert.equal((await oldHandlers.get("open-signin")({})).code, "MEET_BUSY");
	assert.equal(currentServer.closed, false);
	assert.equal(state.stops, stopsBeforeStaleCleanup);
	assert.equal((await status()).meetingId, "new-room");
});

test("connected sign-in uses only the fixed extension route, never broadens Meet navigation", async () => {
	const control = connect();
	assert.equal(
		(await signin({ expectedMeetingId: null, url: "https://untrusted.test" }))
			.ok,
		true,
	);
	assert.deepEqual(
		control.calls.map(({ tool, args }) => ({ tool, args })),
		[{ tool: "meet.open-signin", args: {} }],
	);
});

test("failed or missing capture acknowledgement never reports ready and never retries the join", async () => {
	for (const response of [
		{},
		{ ok: true, meetingId: "another-meeting" },
		{
			ok: false,
			code: "MEET_CAPTURE_USER_GESTURE_REQUIRED",
			error: "Chrome needs extension invocation",
		},
	]) {
		const control = connect();
		const originalReply = control.reply;
		control.reply = (message) =>
			message.tool === "meet.start-capture" ? response : originalReply(message);
		const result = await join();
		assert.equal(result.ok, false);
		assert.equal(
			result.meetingId,
			"abc-defg-hij",
			"opened bot remains identifiable for Stop",
		);
		assert.equal(result.transcriptionReady, true);
		assert.equal(result.capture.state, response.code ? "needs-user" : "failed");
		assert.equal((await status()).capture.state, result.capture.state);
		if (response.code)
			assert.match(
				result.guidance,
				/open the Tek Meet extension, and click Start audio/,
			);
		assert.equal(
			control.calls.filter((call) => call.tool === "meet.start-capture").length,
			1,
		);
		assert.equal(
			state.stops,
			state.spawns.length - 1,
			"capture failure does not silently stop/rejoin",
		);
		assert.equal((await join()).code, "MEET_BUSY");
		await kick();
	}
});

test("manual capture state requires the current control socket and exact meeting identity", async () => {
	const control = connect();
	control.reply = (message) =>
		message.tool === "meet.start-capture"
			? {
					ok: false,
					code: "MEET_CAPTURE_USER_GESTURE_REQUIRED",
					error: "Permission required",
				}
			: {};
	assert.equal((await join()).ok, false);
	const audio = connect("audio");
	audio.message({
		kind: "meet.capture.state",
		meetingId: "abc-defg-hij",
		state: "active",
	});
	control.message({
		kind: "meet.capture.state",
		meetingId: "other-meeting",
		state: "active",
	});
	control.message({ kind: "meet.capture.state", state: "active" });
	assert.equal((await status()).capture.state, "needs-user");
	control.message({
		kind: "meet.capture.state",
		meetingId: "abc-defg-hij",
		state: "active",
	});
	assert.deepEqual((await status()).capture, { state: "active" });
	assert.equal(
		control.calls.filter((call) => call.tool === "meet.start-capture").length,
		1,
	);
	control.close();
	assert.equal(
		(await status()).capture.state,
		"unknown",
		"disconnect does not leave an active claim",
	);
	await kick();
	connect();
	await join("new-room");
	control.message({
		kind: "meet.capture.state",
		meetingId: "new-room",
		state: "failed",
	});
	assert.equal((await status()).capture.state, "active");
});

test("newer manual capture evidence is not overwritten by a late RPC response", async () => {
	const control = connect();
	control.reply = (message) =>
		message.tool === "meet.start-capture" ? undefined : {};
	const joining = join();
	await turn();
	const request = control.calls.find(
		(call) => call.tool === "meet.start-capture",
	);
	assert.equal((await status()).capture.state, "starting");
	control.message({
		kind: "meet.capture.state",
		meetingId: "abc-defg-hij",
		state: "active",
	});
	control.message({
		kind: "result",
		id: request.id,
		value: {
			ok: false,
			code: "MEET_CAPTURE_USER_GESTURE_REQUIRED",
			error: "older refusal",
		},
	});
	assert.equal((await joining).ok, true);
	assert.equal((await status()).capture.state, "active");
});

test("RPC error codes preserve actionable capture permission guidance", async () => {
	const control = connect();
	const originalSend = control.send.bind(control);
	control.send = (raw) => {
		const message = JSON.parse(raw);
		if (message.tool !== "meet.start-capture") return originalSend(raw);
		control.calls.push(message);
		control.message({
			kind: "result",
			id: message.id,
			error: "Chrome denied capture",
			code: "MEET_CAPTURE_USER_GESTURE_REQUIRED",
		});
	};
	const result = await join();
	assert.equal(result.code, "MEET_CAPTURE_USER_GESTURE_REQUIRED");
	assert.equal(result.capture.state, "needs-user");
	assert.match(result.guidance, /Start audio/);
});

test("capture acknowledgement alone cannot claim local transcription is ready", async () => {
	connect();
	state.create = async () => {
		throw new Error("Whisper model unavailable");
	};
	const result = await join();
	assert.equal(result.ok, false);
	assert.equal(result.capture.state, "active");
	assert.equal(result.transcriptionReady, false);
	assert.equal(result.code, "MEET_TRANSCRIBER_UNAVAILABLE");
	assert.equal((await status()).transcriptionReady, false);
	assert.match(
		(await status()).transcriptionError,
		/Whisper model unavailable/,
	);
});

test("natural end requires conditional capture stop confirmation before releasing the meeting", async () => {
	const control = connect();
	await join();
	const originalReply = control.reply;
	control.reply = (message) =>
		message.tool === "meet.stop-capture"
			? { ok: false, error: "offscreen still active" }
			: originalReply(message);
	control.message({ kind: "meet.in-call-ended", meetingId: "abc-defg-hij" });
	await turn();
	assert.deepEqual(control.calls.at(-1).args, {
		expectedMeetingId: "abc-defg-hij",
	});
	assert.equal((await status()).meetingId, "abc-defg-hij");
	assert.equal((await status()).capture.state, "unknown");
	assert.equal((await status()).capture.code, "MEET_CAPTURE_STOP_UNCONFIRMED");
	assert.equal((await join("new-room")).code, "MEET_BUSY");
	assert.equal(state.finalizes.length, 0);
	await kick();
	assert.equal((await status()).meetingId, null);
});

test("loss of the owned audio connection makes delivery unknown without replacing control ownership", async () => {
	const control = connect();
	await join();
	const audio = connect("audio");
	audio.close();
	assert.equal((await status()).capture.state, "unknown");
	assert.equal((await status()).connected, true);
	assert.equal(plugin._getActiveSocket(), control);
});

test("owned capture recovery reports starting until a fresh active acknowledgement arrives", async () => {
	const control = connect();
	await join();
	control.message({
		kind: "meet.capture.state",
		meetingId: "abc-defg-hij",
		state: "starting",
	});
	assert.deepEqual((await status()).capture, { state: "starting" });
	control.message({
		kind: "meet.capture.state",
		meetingId: "wrong-room",
		state: "active",
	});
	assert.equal((await status()).capture.state, "starting");
	control.message({
		kind: "meet.capture.state",
		meetingId: "abc-defg-hij",
		state: "active",
	});
	assert.deepEqual((await status()).capture, { state: "active" });
});
