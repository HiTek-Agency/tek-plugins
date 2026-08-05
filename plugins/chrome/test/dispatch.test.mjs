import { test } from "node:test";
import assert from "node:assert/strict";
import { pruneAxTree } from "../extension/ax-prune.js";
import { resolvePageMode, shapePageState } from "../extension/page-shape.js";

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

test("can normalize a complete tree for downstream paging without pre-truncation", () => {
	const nodes = Array.from({ length: 2_000 }, (_, i) => ({
		nodeId: i,
		role: { value: "button" },
		name: { value: `control-${i}-${"x".repeat(100)}` },
	}));
	const out = pruneAxTree(nodes, { maxBytes: Number.POSITIVE_INFINITY });
	assert.equal(out.axTree.length, nodes.length);
	assert.equal(out.truncated, false);
});

test("interactive page state keeps controls and drops noisy static text", () => {
	const nodes = [
		{ axNodeId: "1", role: "StaticText", name: "very noisy copy" },
		{ axNodeId: "2", role: "button", name: "Save" },
		{ axNodeId: "3", role: "textbox", name: "Campaign name" },
	];
	const out = shapePageState(nodes, "page body", { mode: "interactive" });
	assert.deepEqual(
		out.axTree.map((node) => node.axNodeId),
		["2", "3"],
	);
	assert.equal(out.mode, "interactive");
	assert.equal(out.totalNodes, 3);
});

test("full page state exposes every node through bounded pages", () => {
	const nodes = Array.from({ length: 620 }, (_, i) => ({
		axNodeId: String(i),
		role: "StaticText",
		name: `node-${i}`,
	}));
	const first = shapePageState(nodes, "x".repeat(20_000), {
		mode: "full",
		page: 1,
		pageSize: 100,
	});
	const second = shapePageState(nodes, "x".repeat(20_000), {
		mode: "full",
		page: 2,
		pageSize: 100,
	});
	assert.equal(first.axTree[0].axNodeId, "0");
	assert.equal(second.axTree[0].axNodeId, "100");
	assert.equal(first.hasMore, true);
	assert.equal(first.nextPage, 2);
	assert.ok(JSON.stringify(first).length < 48 * 1024);
});

test("byte-bounded full pages never skip oversized nodes", () => {
	const nodes = Array.from({ length: 18 }, (_, i) => ({
		axNodeId: String(i),
		role: "StaticText",
		name: `node-${i}-${"x".repeat(12_000)}`,
	}));
	const seen = [];
	const first = shapePageState(nodes, "", { mode: "full", pageSize: 10 });
	for (let page = 1; page <= first.totalPages; page++) {
		const out = shapePageState(nodes, "", { mode: "full", page, pageSize: 10 });
		assert.ok(JSON.stringify(out.axTree).length <= 32 * 1024);
		seen.push(...out.axTree.map((node) => node.axNodeId));
	}
	assert.deepEqual(
		seen,
		Array.from({ length: 18 }, (_, i) => String(i)),
	);
});

test("full paging can continue through text after the node pages end", () => {
	const text = "a".repeat(8_000) + "b".repeat(8_000) + "c".repeat(2_000);
	const out = shapePageState([{ axNodeId: "1", role: "main", name: "Page" }], text, {
		mode: "full",
		page: 2,
	});
	assert.equal(out.axTree.length, 0);
	assert.equal(out.text.startsWith("b"), true);
	assert.equal(out.page, 2);
	assert.equal(out.hasMore, true);
});

test("legacy returnPage flags resolve to compact modes", () => {
	assert.equal(resolvePageMode({ returnPage: false }), "none");
	assert.equal(resolvePageMode({ returnPage: true }), "interactive");
	assert.equal(resolvePageMode({ pageMode: "full" }), "full");
});
