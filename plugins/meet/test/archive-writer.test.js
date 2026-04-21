/**
 * Unit tests for src/archive-writer.js (plan 104-05 Task 1).
 *
 * Covers:
 *   - readChunks parses the fixture line-by-line
 *   - groupBySpeaker filters self-echo and collapses consecutive same-speaker
 *   - renderTranscriptMd produces # Transcript + ## Speaker blocks (no self-echo)
 *   - finalize writes both files + detects participants + records coverage
 *   - coverage "partial" when a >10s gap exists between consecutive chunks
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	mkdtempSync,
	writeFileSync,
	readFileSync,
	rmSync,
	copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	readChunks,
	groupBySpeaker,
	renderTranscriptMd,
	finalize,
} from "../src/archive-writer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-archive-"));
	copyFileSync(
		join(__dirname, "fixtures", "sample-raw.jsonl"),
		join(dir, "raw.jsonl"),
	);
	return dir;
}

test("readChunks returns array of 5 objects from sample fixture", async () => {
	const dir = await setup();
	const cs = await readChunks(dir);
	assert.equal(cs.length, 5);
	assert.equal(cs[0].text, "Good morning");
	rmSync(dir, { recursive: true, force: true });
});

test("readChunks returns [] when raw.jsonl missing (resilient to no-audio meetings)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-empty-"));
	const cs = await readChunks(dir);
	assert.deepEqual(cs, []);
	rmSync(dir, { recursive: true, force: true });
});

test("groupBySpeaker filters self-echo and groups consecutive same-speaker chunks", async () => {
	const dir = await setup();
	const cs = await readChunks(dir);
	const groups = groupBySpeaker(cs);
	// Alice (2 chunks) → Bob (1) → Alice (1) — self-echo removed
	assert.equal(groups.length, 3);
	assert.equal(groups[0].name, "Alice");
	assert.equal(groups[0].lines.length, 2);
	assert.equal(groups[1].name, "Bob");
	assert.equal(groups[2].name, "Alice");
	rmSync(dir, { recursive: true, force: true });
});

test("renderTranscriptMd produces speaker-grouped markdown", async () => {
	const dir = await setup();
	const cs = await readChunks(dir);
	const md = renderTranscriptMd(groupBySpeaker(cs));
	assert.match(md, /# Transcript/);
	assert.match(md, /## Alice/);
	assert.match(md, /## Bob/);
	assert.ok(!/Tek here to help/.test(md), "self-echo must be filtered");
	rmSync(dir, { recursive: true, force: true });
});

test("finalize writes transcript.md + meta.json with participants detected from chunks", async () => {
	const dir = await setup();
	const r = await finalize({
		archiveDir: dir,
		meta: {
			meetUrl: "https://meet.google.com/abc",
			meetCode: "abc-defg-hij",
			title: "Test Standup",
			startedAt: 1000,
			endedAt: 6000,
			participants: [],
		},
	});
	const md = readFileSync(r.transcriptMdPath, "utf8");
	const meta = JSON.parse(readFileSync(r.metaPath, "utf8"));
	assert.ok(md.includes("Alice"));
	assert.ok(meta.participants.includes("Alice"));
	assert.ok(meta.participants.includes("Bob"));
	assert.equal(meta.reconciliation, "pending");
	assert.equal(meta.coverage, "full");
	assert.equal(meta.meetCode, "abc-defg-hij");
	rmSync(dir, { recursive: true, force: true });
});

test("finalize prefers caller-supplied participants over derived ones", async () => {
	const dir = await setup();
	const r = await finalize({
		archiveDir: dir,
		meta: {
			meetUrl: "x",
			meetCode: "x",
			title: "x",
			startedAt: 1000,
			endedAt: 6000,
			participants: ["Carol", "Dave"],
		},
	});
	const meta = JSON.parse(readFileSync(r.metaPath, "utf8"));
	assert.deepEqual(meta.participants, ["Carol", "Dave"]);
	rmSync(dir, { recursive: true, force: true });
});

test("coverage='partial' when raw.jsonl has >10s gap", async () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-gap-"));
	writeFileSync(
		join(dir, "raw.jsonl"),
		[
			'{"t_start_ms":1000,"t_end_ms":2000,"text":"a","speakerGuess":"X","source":"whisper","transcribe":true}',
			'{"t_start_ms":15000,"t_end_ms":16000,"text":"b","speakerGuess":"Y","source":"whisper","transcribe":true}',
		].join("\n"),
	);
	const r = await finalize({
		archiveDir: dir,
		meta: {
			meetUrl: "x",
			meetCode: "x",
			title: "x",
			startedAt: 1000,
			endedAt: 16000,
		},
	});
	const meta = JSON.parse(readFileSync(r.metaPath, "utf8"));
	assert.equal(meta.coverage, "partial");
	rmSync(dir, { recursive: true, force: true });
});
