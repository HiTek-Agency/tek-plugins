/**
 * Mic-inject content-main-world tests (Plan 104-06 Task 2).
 *
 * Loads `extension/content-main-world.js` into a vm sandbox that simulates
 * a minimal navigator.mediaDevices + MediaDevices class + window, runs the
 * IIFE, and asserts all three RESEARCH Pitfall 1 mitigations are applied
 * correctly:
 *
 *   1. Mitigation 1 — about:blank bounce — lives in chrome-profile.js; not
 *      tested here (its own regression test in chrome-profile.test.js holds).
 *   2. Mitigation 2 — dual-site patching: BOTH
 *      `MediaDevices.prototype.getUserMedia` AND
 *      `navigator.mediaDevices.getUserMedia` are replaced.
 *   3. Mitigation 3 — fallback enumerateDevices: returns original devices
 *      PLUS a synthetic {deviceId:"tek-synth-mic", kind:"audioinput",
 *      label:"Tek Agent Voice"} so Meet's UI dropdown can still pick it
 *      manually if the auto-injection path is bypassed.
 *
 * Also tests the audio-only-when-synth-attached routing, video-request
 * fall-through, no-synth fall-through, and idempotency.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
	join(__dirname, "..", "extension", "content-main-world.js"),
	"utf8",
);

function makeSandbox() {
	const origDevices = [
		{ deviceId: "real-mic", kind: "audioinput", label: "Real Microphone", groupId: "g1" },
		{ deviceId: "real-cam", kind: "videoinput", label: "Real Camera", groupId: "g1" },
	];
	const origGetUserMedia = async (c) => ({ __real: true, constraints: c });
	// Create a mutable navigator.mediaDevices object. The prototype chain
	// matters — content-main-world.js patches BOTH the instance and the
	// prototype, so the sandbox must surface a prototype the script can reach
	// via MediaDevices.prototype.
	class MediaDevices {}
	MediaDevices.prototype.getUserMedia = origGetUserMedia;
	MediaDevices.prototype.enumerateDevices = async () => origDevices.slice();

	const mediaDevicesInstance = Object.create(MediaDevices.prototype);
	mediaDevicesInstance.getUserMedia = origGetUserMedia;
	mediaDevicesInstance.enumerateDevices = async () => origDevices.slice();

	const navigator = { mediaDevices: mediaDevicesInstance };
	const MediaStream = class {
		constructor(tracks) {
			this.tracks = Array.isArray(tracks) ? tracks : [];
		}
		getAudioTracks() {
			return this.tracks;
		}
	};
	// Minimal window shim — the IIFE uses window.addEventListener, assigns
	// __TEK_MEET_PATCHED__ + __TEK_MEET_ATTACH_SYNTH__ on window, etc.
	const listeners = {};
	const win = {
		addEventListener(type, handler) {
			(listeners[type] ||= []).push(handler);
		},
		// Test helper — emit a fake postMessage event
		__postMessage(data) {
			(listeners.message || []).forEach((h) => h({ data }));
		},
	};
	return {
		navigator,
		MediaDevices,
		MediaStream,
		window: win,
		console: { log: () => {}, warn: () => {}, error: () => {} },
		// make `window` also the global object for code like `window.__TEK_MEET_PATCHED__`
	};
}

test("IIFE patches both instance and prototype getUserMedia", () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	// Capture originals
	const origInstance = sandbox.navigator.mediaDevices.getUserMedia;
	const origProto = sandbox.MediaDevices.prototype.getUserMedia;
	vm.runInContext(SRC, sandbox);
	assert.notStrictEqual(
		sandbox.navigator.mediaDevices.getUserMedia,
		origInstance,
		"instance getUserMedia should be replaced",
	);
	assert.notStrictEqual(
		sandbox.MediaDevices.prototype.getUserMedia,
		origProto,
		"prototype getUserMedia should be replaced",
	);
});

test("enumerateDevices returns synthetic device alongside real devices", async () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const list = await sandbox.navigator.mediaDevices.enumerateDevices();
	assert.ok(
		list.some(
			(d) =>
				d.deviceId === "tek-synth-mic" &&
				d.kind === "audioinput" &&
				d.label === "Tek Agent Voice",
		),
		"synthetic mic device present",
	);
	assert.ok(list.some((d) => d.deviceId === "real-mic"), "real mic still present");
	assert.ok(list.some((d) => d.deviceId === "real-cam"), "real cam still present");
});

test("patched getUserMedia returns synthetic when audio-only AND syntheticMicStream is set", async () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const fakeTrack = { kind: "audio" };
	sandbox.window.__TEK_MEET_ATTACH_SYNTH__(fakeTrack);
	const r = await sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
	assert.ok(r instanceof sandbox.MediaStream, "should return a MediaStream");
	assert.equal(r.__real, undefined, "should NOT be the original real stream");
});

test("patched getUserMedia falls through for video requests", async () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const fakeTrack = { kind: "audio" };
	sandbox.window.__TEK_MEET_ATTACH_SYNTH__(fakeTrack);
	const r = await sandbox.navigator.mediaDevices.getUserMedia({ audio: true, video: true });
	assert.equal(r.__real, true, "video request should fall through to original");
});

test("patched getUserMedia falls through when no synthetic is attached", async () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const r = await sandbox.navigator.mediaDevices.getUserMedia({ audio: true });
	assert.equal(r.__real, true, "audio request with no synthetic should fall through");
});

test("content script refuses to double-patch (idempotent)", () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	const patched1 = sandbox.navigator.mediaDevices.getUserMedia;
	// Run again — should no-op
	vm.runInContext(SRC, sandbox);
	const patched2 = sandbox.navigator.mediaDevices.getUserMedia;
	assert.strictEqual(patched1, patched2, "second run must be a no-op");
});

test("__TEK_MEET_PATCHED__ sentinel is set on window", () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	assert.equal(sandbox.window.__TEK_MEET_PATCHED__, true);
});

test("postMessage handler attaches synthetic mic from main-world bridge", () => {
	const sandbox = makeSandbox();
	vm.createContext(sandbox);
	vm.runInContext(SRC, sandbox);
	// Fire a synth-mic set message from the isolated-world bridge
	const fakeTrack = { kind: "audio", __fromBridge: true };
	sandbox.window.__postMessage({
		type: "__TEK_MEET_SET_SYNTHETIC_MIC__",
		track: fakeTrack,
	});
	// After the bridge fires, getUserMedia should return the synthetic.
	return sandbox.navigator.mediaDevices.getUserMedia({ audio: true }).then((r) => {
		assert.ok(r instanceof sandbox.MediaStream);
	});
});
