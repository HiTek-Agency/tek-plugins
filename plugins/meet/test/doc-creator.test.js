/**
 * Unit tests for src/doc-creator.js (plan 104-05 Task 2).
 *
 * These tests inject a fake docsClient so we never actually hit googleapis
 * — the contract with google.docs({version:"v1"}) is exercised via the
 * mock-friendly `docsClient` parameter. Integration with the real client
 * lands in plan 104-09 when ctx.getGoogleAuth becomes available.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createMeetingDoc } from "../src/doc-creator.js";

function fakeDocsClient() {
	const calls = { create: [], batchUpdate: [] };
	return {
		calls,
		documents: {
			create: async (args) => {
				calls.create.push(args);
				return { data: { documentId: "DOC123" } };
			},
			batchUpdate: async (args) => {
				calls.batchUpdate.push(args);
				return { data: { replies: [] } };
			},
		},
	};
}

test("createMeetingDoc returns documentId and Drive URL", async () => {
	const client = fakeDocsClient();
	const r = await createMeetingDoc({
		auth: {},
		title: "Test",
		summaryMd: "## S",
		transcriptMd: "## T",
		docsClient: client,
	});
	assert.equal(r.documentId, "DOC123");
	assert.equal(r.url, "https://docs.google.com/document/d/DOC123/edit");
});

test("createMeetingDoc calls documents.create with the title", async () => {
	const client = fakeDocsClient();
	await createMeetingDoc({
		auth: {},
		title: "My Meeting 2026-04-20",
		summaryMd: "",
		transcriptMd: "",
		docsClient: client,
	});
	assert.equal(client.calls.create.length, 1);
	assert.equal(client.calls.create[0].requestBody.title, "My Meeting 2026-04-20");
});

test("createMeetingDoc body includes both summary and transcript separated by hr", async () => {
	const client = fakeDocsClient();
	await createMeetingDoc({
		auth: {},
		title: "T",
		summaryMd: "# Summary content",
		transcriptMd: "# Transcript content",
		docsClient: client,
	});
	const text = client.calls.batchUpdate[0].requestBody.requests[0].insertText.text;
	assert.match(text, /Summary content/);
	assert.match(text, /Transcript content/);
	assert.match(text, /----/);
});

test("createMeetingDoc inserts at document index 1", async () => {
	const client = fakeDocsClient();
	await createMeetingDoc({
		auth: {},
		title: "t",
		summaryMd: "",
		transcriptMd: "",
		docsClient: client,
	});
	const req = client.calls.batchUpdate[0].requestBody.requests[0];
	assert.equal(req.insertText.location.index, 1);
});

test("createMeetingDoc throws when documentId is missing", async () => {
	const client = {
		documents: {
			create: async () => ({ data: {} }),
			batchUpdate: async () => {},
		},
	};
	await assert.rejects(
		() =>
			createMeetingDoc({
				auth: {},
				title: "t",
				summaryMd: "",
				transcriptMd: "",
				docsClient: client,
			}),
		/documentId/,
	);
});
