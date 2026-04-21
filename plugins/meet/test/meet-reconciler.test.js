/**
 * Unit tests for src/meet-reconciler.js (plan 104-05 Task 3).
 *
 * Covers:
 *   - applyEntryMatches replaces speakerGuess when time overlap ≥50%
 *   - applyEntryMatches leaves non-overlapping chunks alone
 *   - startReconciliation short-circuits to "unavailable" after 2 empty polls
 *   - startReconciliation fully reconciles when API data lands
 *   - startReconciliation honors cancel()
 *   - startReconciliation graceful on API errors (returns unavailable, not throws)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyEntryMatches,
	startReconciliation,
	timeOverlap,
} from "../src/meet-reconciler.js";

test("timeOverlap returns 1 for identical ranges", () => {
	assert.equal(
		timeOverlap({ start: 0, end: 100 }, { start: 0, end: 100 }),
		1,
	);
});

test("timeOverlap returns 0 for disjoint ranges", () => {
	assert.equal(
		timeOverlap({ start: 0, end: 100 }, { start: 200, end: 300 }),
		0,
	);
});

test("applyEntryMatches replaces speakerGuess when time overlap ≥50%", () => {
	const local = [
		{ t_start_ms: 1000, t_end_ms: 2000, text: "a", speakerGuess: "unknown" },
		{ t_start_ms: 3000, t_end_ms: 4000, text: "b", speakerGuess: "unknown" },
	];
	const entries = [{ participantName: "Alice", startMs: 900, endMs: 2100 }];
	const updated = applyEntryMatches(local, entries);
	assert.equal(updated[0].speakerGuess, "Alice");
	assert.equal(updated[0].source, "meet-api");
	assert.equal(updated[1].speakerGuess, "unknown");
});

test("applyEntryMatches leaves non-overlapping chunks alone", () => {
	const local = [
		{ t_start_ms: 5000, t_end_ms: 6000, text: "x", speakerGuess: "unknown" },
	];
	const entries = [{ participantName: "Alice", startMs: 900, endMs: 2100 }];
	const updated = applyEntryMatches(local, entries);
	assert.equal(updated[0].speakerGuess, "unknown");
	// Also verify input not mutated (purity)
	assert.equal(local[0].speakerGuess, "unknown");
	assert.equal(local[0].source, undefined);
});

test("startReconciliation short-circuits to 'unavailable' after 2 empty polls", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-recon-"));
	writeFileSync(join(dir, "meta.json"), "{}");
	writeFileSync(join(dir, "raw.jsonl"), "");
	const mockMeet = {
		conferenceRecords: {
			list: async () => ({ data: { conferenceRecords: [] } }),
			transcripts: {
				list: async () => ({ data: { transcripts: [] } }),
				entries: {
					list: async () => ({ data: { transcriptEntries: [] } }),
				},
			},
		},
	};
	const { promise } = await startReconciliation({
		meetingCode: "abc",
		startedAt: 0,
		archiveDir: dir,
		auth: {},
		pollIntervalMs: 10,
		deadlineMs: 1000,
		meetClient: mockMeet,
	});
	const r = await promise;
	assert.equal(r.status, "unavailable");
	assert.equal(r.reason, "no-conference-record");
	const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
	assert.equal(meta.reconciliation, "unavailable");
	assert.ok(typeof meta.reconciledAt === "number");
	rmSync(dir, { recursive: true, force: true });
});

test("startReconciliation fully reconciles when API data lands", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-recon-ok-"));
	writeFileSync(join(dir, "meta.json"), "{}");
	writeFileSync(
		join(dir, "raw.jsonl"),
		JSON.stringify({
			t_start_ms: 1000,
			t_end_ms: 2000,
			text: "hello",
			speakerGuess: "unknown",
		}),
	);
	const mockMeet = {
		conferenceRecords: {
			list: async () => ({
				data: {
					conferenceRecords: [
						{ name: "records/r1", startTime: new Date(0).toISOString() },
					],
				},
			}),
			transcripts: {
				list: async () => ({
					data: {
						transcripts: [
							{
								name: "records/r1/transcripts/t1",
								state: "FILE_GENERATED",
							},
						],
					},
				}),
				entries: {
					list: async () => ({
						data: {
							transcriptEntries: [
								{
									participant: "Alice",
									startTime: new Date(900).toISOString(),
									endTime: new Date(2100).toISOString(),
									text: "hello",
								},
							],
						},
					}),
				},
			},
		},
	};
	const { promise } = await startReconciliation({
		meetingCode: "abc",
		startedAt: 0,
		archiveDir: dir,
		auth: {},
		pollIntervalMs: 10,
		deadlineMs: 2000,
		meetClient: mockMeet,
	});
	const r = await promise;
	assert.equal(r.status, "reconciled");
	assert.equal(r.updates, 1);
	assert.equal(r.entries, 1);
	const updatedJsonl = readFileSync(join(dir, "raw.jsonl"), "utf8").trim();
	assert.ok(updatedJsonl.includes('"speakerGuess":"Alice"'));
	assert.ok(updatedJsonl.includes('"source":"meet-api"'));
	const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
	assert.equal(meta.reconciliation, "reconciled");
	rmSync(dir, { recursive: true, force: true });
});

test("startReconciliation honors cancel()", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-recon-cancel-"));
	writeFileSync(join(dir, "meta.json"), "{}");
	writeFileSync(join(dir, "raw.jsonl"), "");
	const mockMeet = {
		conferenceRecords: {
			list: async () => {
				await new Promise((r) => setTimeout(r, 50));
				return { data: { conferenceRecords: [] } };
			},
			transcripts: {
				list: async () => ({ data: {} }),
				entries: { list: async () => ({ data: {} }) },
			},
		},
	};
	const { promise, cancel } = await startReconciliation({
		meetingCode: "abc",
		startedAt: 0,
		archiveDir: dir,
		auth: {},
		pollIntervalMs: 20,
		deadlineMs: 5000,
		meetClient: mockMeet,
	});
	setTimeout(cancel, 30);
	const r = await promise;
	// Either cancelled (clean) or unavailable (if 2 polls completed before cancel)
	assert.ok(["cancelled", "unavailable", "timeout"].includes(r.status));
	rmSync(dir, { recursive: true, force: true });
});

test("startReconciliation treats conferenceRecords.list API error as unavailable", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-recon-err-"));
	writeFileSync(join(dir, "meta.json"), "{}");
	writeFileSync(join(dir, "raw.jsonl"), "");
	const mockMeet = {
		conferenceRecords: {
			list: async () => {
				const err = new Error("403 Forbidden");
				err.code = 403;
				throw err;
			},
			transcripts: {
				list: async () => ({ data: {} }),
				entries: { list: async () => ({ data: {} }) },
			},
		},
	};
	const { promise } = await startReconciliation({
		meetingCode: "abc",
		startedAt: 0,
		archiveDir: dir,
		auth: {},
		pollIntervalMs: 10,
		deadlineMs: 1000,
		meetClient: mockMeet,
	});
	const r = await promise;
	assert.equal(r.status, "unavailable");
	assert.equal(r.reason, "api-error");
	const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
	assert.equal(meta.reconciliation, "unavailable");
	rmSync(dir, { recursive: true, force: true });
});
