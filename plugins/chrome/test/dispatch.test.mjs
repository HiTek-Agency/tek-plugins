import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneAxTree } from "../extension/ax-prune.js";

test("strips generic+nameless nodes", () => {
	const r = pruneAxTree([
		{ nodeId: 1, role: { value: "generic" }, name: { value: "" } },
		{ nodeId: 2, role: { value: "button" }, name: { value: "OK" } },
	]);
	assert.equal(r.axTree.length, 1);
	assert.equal(r.axTree[0].axNodeId, 2);
});

test("keeps named generic", () => {
	const r = pruneAxTree([
		{ nodeId: 1, role: { value: "generic" }, name: { value: "Hello" } },
	]);
	assert.equal(r.axTree.length, 1);
});

test("keeps roled nameless", () => {
	const r = pruneAxTree([
		{ nodeId: 1, role: { value: "button" }, name: { value: "" } },
	]);
	assert.equal(r.axTree.length, 1);
});

test("truncates over 100 KB", () => {
	const big = [];
	for (let i = 0; i < 5000; i++) {
		big.push({
			nodeId: i,
			role: { value: "button" },
			name: { value: "x".repeat(50) },
		});
	}
	const r = pruneAxTree(big);
	assert.equal(r.truncated, true);
	assert.ok(JSON.stringify(r.axTree).length <= 100 * 1024);
	assert.ok(r.totalNodes > r.axTree.length);
});
