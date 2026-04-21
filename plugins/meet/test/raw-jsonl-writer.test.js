/**
 * Unit tests for src/raw-jsonl-writer.js.
 *
 * Tests run in tmpdir to avoid polluting the user's real
 * ~/.config/tek/meet-transcripts/. For resolveArchiveDir (which is bound to
 * ARCHIVE_ROOT under homedir), we use unique meetCode values to avoid any
 * collision with existing archives on the test machine, then clean up.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendChunk, resolveArchiveDir, ARCHIVE_ROOT } from "../src/raw-jsonl-writer.js";

test("ARCHIVE_ROOT ends with meet-transcripts", () => {
	assert.match(ARCHIVE_ROOT, /meet-transcripts$/);
});

test("appendChunk writes JSONL to raw.jsonl (creates dir if missing)", () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-test-"));
	appendChunk(dir, {
		t_start_ms: 1,
		t_end_ms: 2,
		text: "hello",
		source: "whisper",
		transcribe: true,
	});
	appendChunk(dir, {
		t_start_ms: 2,
		t_end_ms: 3,
		text: "world",
		source: "whisper",
		transcribe: true,
	});
	const content = readFileSync(join(dir, "raw.jsonl"), "utf8");
	const lines = content.trim().split("\n");
	assert.equal(lines.length, 2);
	assert.equal(JSON.parse(lines[0]).text, "hello");
	assert.equal(JSON.parse(lines[1]).text, "world");
	rmSync(dir, { recursive: true, force: true });
});

test("appendChunk recreates archiveDir if it's been deleted", () => {
	const dir = mkdtempSync(join(tmpdir(), "tek-meet-test-"));
	// Delete the dir entirely — appendChunk must recreate it
	rmSync(dir, { recursive: true, force: true });
	assert.equal(existsSync(dir), false);
	appendChunk(dir, { t_start_ms: 1, t_end_ms: 2, text: "resilient" });
	assert.equal(existsSync(dir), true);
	assert.equal(existsSync(join(dir, "raw.jsonl")), true);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveArchiveDir produces collision-free path with -2/-3 suffixes", () => {
	// Use a unique meet code so we don't collide with any real archive on
	// the dev machine.
	const unique = `unit-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
	const d = new Date("2026-04-20T12:00:00Z");
	const dir = resolveArchiveDir({ startedAt: d, meetCode: unique, title: "standup" });
	assert.match(dir, new RegExp(`${unique}_standup`));
	assert.ok(existsSync(dir));
	// Second call with same inputs should append -2
	const dir2 = resolveArchiveDir({ startedAt: d, meetCode: unique, title: "standup" });
	assert.notEqual(dir, dir2);
	assert.match(dir2, /-2$/);
	// Third call should append -3
	const dir3 = resolveArchiveDir({ startedAt: d, meetCode: unique, title: "standup" });
	assert.match(dir3, /-3$/);
	rmSync(dir, { recursive: true, force: true });
	rmSync(dir2, { recursive: true, force: true });
	rmSync(dir3, { recursive: true, force: true });
});

test("resolveArchiveDir slugifies title (lowercase, alphanum-dash, max 40)", () => {
	const unique = `slug-test-${Date.now()}`;
	const d = new Date("2026-04-20T00:00:00Z");
	const dir = resolveArchiveDir({
		startedAt: d,
		meetCode: unique,
		title: "Q2 Planning!! With Customers & Execs",
	});
	// Original title chars → lowercased + non-alphanum collapsed to dashes,
	// truncated to 40 chars.
	assert.match(dir, /q2-planning-with-customers-execs/);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveArchiveDir falls back to 'untitled' when title is empty", () => {
	const unique = `empty-title-${Date.now()}`;
	const d = new Date("2026-04-20T00:00:00Z");
	const dir = resolveArchiveDir({ startedAt: d, meetCode: unique, title: "" });
	assert.match(dir, /_untitled$/);
	rmSync(dir, { recursive: true, force: true });
});

test("resolveArchiveDir formats date as YYYY-MM-DD", () => {
	const unique = `date-test-${Date.now()}`;
	// Use local-time-safe construction to avoid off-by-one across TZs.
	const d = new Date(2026, 3, 1); // April 1, 2026 (month index is 0-based)
	const dir = resolveArchiveDir({ startedAt: d, meetCode: unique, title: "t" });
	assert.match(dir, /2026-04-01_/);
	rmSync(dir, { recursive: true, force: true });
});
