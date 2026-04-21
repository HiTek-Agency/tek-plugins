/**
 * Raw JSONL transcript writer + archive-directory resolver.
 *
 * Per CONTEXT D-12, every meeting produces a directory at
 *   ~/.config/tek/meet-transcripts/<YYYY-MM-DD>_<meet-code>_<safe-title>/
 * containing (eventually):
 *   - raw.jsonl      — one whisper chunk per line (this plan)
 *   - transcript.md  — speaker-attributed running transcript (plan 104-05)
 *   - summary.md     — AI summary (plan 104-07)
 *   - meta.json      — meeting metadata (plan 104-07)
 *
 * This module provides:
 *   - resolveArchiveDir({startedAt, meetCode, title}) — creates the dir,
 *     appending -2/-3/... if a same-named dir already exists on disk
 *   - appendChunk(archiveDir, chunkObj) — appends one JSON line to raw.jsonl
 *   - ARCHIVE_ROOT — for tests + documentation
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ARCHIVE_ROOT = join(homedir(), ".config", "tek", "meet-transcripts");

function slug(s) {
	return (
		(s || "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 40) || "untitled"
	);
}

function ymd(date) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

/**
 * Create (or pick a non-colliding) archive directory under ARCHIVE_ROOT.
 *
 * @param {object} opts
 * @param {Date}   [opts.startedAt=new Date()]
 * @param {string} [opts.meetCode="unknown"]
 * @param {string} [opts.title=""]
 * @returns {string} absolute path to the created directory
 */
export function resolveArchiveDir({ startedAt = new Date(), meetCode = "unknown", title = "" } = {}) {
	const base = `${ymd(startedAt)}_${meetCode}_${slug(title)}`;
	let dir = join(ARCHIVE_ROOT, base);
	let n = 2;
	while (existsSync(dir)) {
		dir = join(ARCHIVE_ROOT, `${base}-${n}`);
		n++;
		if (n > 99) {
			throw new Error(`too many archive-dir collisions for ${base}`);
		}
	}
	mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Append one chunk object as a JSON line to raw.jsonl in archiveDir.
 * Creates archiveDir if missing (for resilience against directory deletion
 * mid-meeting — we'd rather re-create than drop audio).
 *
 * @param {string} archiveDir
 * @param {object} chunkObj  {t_start_ms, t_end_ms, text, speakerGuess, source, transcribe, ...}
 */
export function appendChunk(archiveDir, chunkObj) {
	if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true });
	appendFileSync(join(archiveDir, "raw.jsonl"), JSON.stringify(chunkObj) + "\n");
}
