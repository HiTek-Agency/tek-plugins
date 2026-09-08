import { test } from "node:test";
import assert from "node:assert/strict";
import { navigateTab } from "../extension/navigation.js";

function event() {
	const listeners = new Set();
	return {
		addListener: (fn) => listeners.add(fn),
		removeListener: (fn) => listeners.delete(fn),
		emit: (...args) => { for (const fn of listeners) fn(...args); },
		get size() { return listeners.size; },
	};
}
function fixture() {
	return {
		onUpdated: event(), onRemoved: event(),
		update: async () => {},
		get: async () => ({ id: 7, status: "complete", url: "https://example.test" }),
	};
}
function clean(tabs) {
	assert.equal(tabs.onUpdated.size, 0);
	assert.equal(tabs.onRemoved.size, 0);
}
test("fast navigation completed before update resolves does not time out", async () => {
	const tabs = fixture();
	tabs.update = async () => { tabs.onUpdated.emit(7, { status: "complete" }); };
	assert.equal((await navigateTab(tabs, 7, "https://example.test")).id, 7);
	clean(tabs);
});
test("waits for matching tab load while ignoring unrelated tabs", async () => {
	const tabs = fixture();
	tabs.get = async () => {
		queueMicrotask(() => {
			tabs.onUpdated.emit(8, { status: "complete" }, { id: 8 });
			tabs.onUpdated.emit(7, { status: "complete" }, { id: 7 });
		});
		return { status: "loading" };
	};
	assert.equal((await navigateTab(tabs, 7, "https://example.test")).id, 7);
	clean(tabs);
});
test("closed tabs fail promptly and release listeners", async () => {
	const tabs = fixture();
	tabs.update = async () => { tabs.onRemoved.emit(7); };
	await assert.rejects(navigateTab(tabs, 7, "https://example.test"), /closed during navigation/);
	clean(tabs);
});
test("failed navigation cleans up", async () => {
	const tabs = fixture();
	tabs.update = async () => { throw new Error("invalid URL"); };
	await assert.rejects(navigateTab(tabs, 7, "bad"), /invalid URL/);
	clean(tabs);
});
test("stalled dispatch is bounded and releases listeners", async () => {
	const tabs = fixture();
	tabs.update = () => new Promise(() => {});
	await assert.rejects(navigateTab(tabs, 7, "https://example.test", 10), /timed out/);
	clean(tabs);
});
