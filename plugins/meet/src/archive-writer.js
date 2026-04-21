/**
 * Plan 104-05: Archive writer — reads raw.jsonl → transcript.md + meta.json.
 *
 * Pure functions over the line-delimited JSON stream produced by plan 104-03's
 * raw-jsonl-writer.js. Called at meeting end (onMeetingEnd in src/index.js)
 * after the whisper transcriber has flushed its tail buffer.
 *
 * D-12 archive layout:
 *   ~/.config/tek/meet-transcripts/<YYYY-MM-DD>_<meet-code>_<safe-title>/
 *     ├── transcript.md   (this module writes, time-ordered + speaker-grouped)
 *     ├── summary.md      (written by summarize.js — this module's sibling)
 *     ├── raw.jsonl       (append-only during meeting, immutable after end)
 *     └── meta.json       (this module writes participants + timestamps + reconciliation state)
 *
 * Filtering rules:
 *   - drop `transcribe: false` chunks (self-echo frames flagged by the
 *     suppression pass-through — see plan 104-03 deviation 1)
 *   - drop `source === "self-echo"` chunks (same rule, different signal)
 *   - drop chunks with empty/whitespace-only text (whisper silence passes)
 *
 * Grouping: consecutive same-speakerGuess chunks collapse into one quoted
 * block. speakerGuess:null becomes the literal "Unknown speaker" label so
 * readers can spot drop-outs; plan 104-05's reconciler patches these back
 * when/if the Meet v2 API transcript becomes available.
 *
 * Coverage detection: meta.coverage = "partial" if any two consecutive chunks
 * have a gap > 10s (plan 104-03 RESEARCH Pitfall 5). Otherwise "full".
 */

import { createReadStream, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

function formatTime(ms) {
	const d = new Date(ms);
	return d.toLocaleTimeString("en-US", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	});
}

/**
 * Read raw.jsonl line-by-line. Returns [] if the file doesn't exist yet
 * (resilience: finalize can be called on an archive dir that never received
 * any audio frames — Chrome spawn failed, extension never handshaked, etc.).
 */
export async function readChunks(archiveDir) {
	const p = join(archiveDir, "raw.jsonl");
	if (!existsSync(p)) return [];
	const lines = [];
	const rl = createInterface({
		input: createReadStream(p),
		crlfDelay: Infinity,
	});
	for await (const line of rl) {
		if (!line.trim()) continue;
		try {
			lines.push(JSON.parse(line));
		} catch {
			// bad line — drop silently (partial write mid-meeting)
		}
	}
	return lines;
}

/**
 * Filter self-echo + empty text; group consecutive same-speaker chunks into
 * one block. Returns array of {name, startedAt, lines[]}.
 */
export function groupBySpeaker(chunks) {
	const visible = chunks.filter(
		(c) =>
			c.transcribe !== false &&
			c.source !== "self-echo" &&
			typeof c.text === "string" &&
			c.text.trim().length > 0,
	);
	const groups = [];
	let cur = null;
	for (const c of visible) {
		const name = c.speakerGuess ?? "Unknown speaker";
		if (!cur || cur.name !== name) {
			cur = {
				name,
				startedAt: c.t_start_ms,
				lines: [c.text.trim()],
			};
			groups.push(cur);
		} else {
			cur.lines.push(c.text.trim());
		}
	}
	return groups;
}

export function renderTranscriptMd(groups) {
	const out = ["# Transcript", ""];
	for (const g of groups) {
		out.push(`## ${g.name} — ${formatTime(g.startedAt)}`);
		out.push("");
		out.push(g.lines.join(" "));
		out.push("");
	}
	return out.join("\n");
}

/**
 * Coverage heuristic: "partial" if any two consecutive chunks have a gap
 * exceeding 10_000 ms between the end of one and the start of the next.
 * Otherwise "full". Signals to plan 104-05's reconciler that the local
 * transcript may have dropped audio (offscreen doc hibernated, tabCapture
 * revoked, etc.).
 */
function detectCoverage(chunks) {
	if (chunks.length < 2) return "full";
	let maxGap = 0;
	for (let i = 1; i < chunks.length; i++) {
		const gap = chunks[i].t_start_ms - chunks[i - 1].t_end_ms;
		if (gap > maxGap) maxGap = gap;
	}
	return maxGap > 10_000 ? "partial" : "full";
}

/**
 * Public API called from src/index.js onMeetingEnd().
 *
 * @param {object} opts
 * @param {string} opts.archiveDir absolute path to the meeting archive dir
 * @param {object} opts.meta       {meetUrl, meetCode, title, startedAt, endedAt, participants?}
 * @returns {Promise<{transcriptMdPath: string, metaPath: string, chunks: object[], groups: object[], coverage: "full"|"partial"}>}
 */
export async function finalize({ archiveDir, meta }) {
	const chunks = await readChunks(archiveDir);
	const groups = groupBySpeaker(chunks);
	const md = renderTranscriptMd(groups);
	writeFileSync(join(archiveDir, "transcript.md"), md);

	// Participants: prefer the caller's list (tracked live via plan 104-04);
	// fall back to the unique speakerGuess values seen in chunks. Deduplicated
	// while preserving first-seen order.
	const seen = new Set();
	const derivedParticipants = [];
	for (const c of chunks) {
		const name = c.speakerGuess;
		if (typeof name === "string" && name.length > 0 && !seen.has(name)) {
			seen.add(name);
			derivedParticipants.push(name);
		}
	}
	const coverage = detectCoverage(chunks);
	const finalMeta = {
		...meta,
		participants:
			meta.participants && meta.participants.length
				? meta.participants
				: derivedParticipants,
		reconciliation: "pending",
		reconciledAt: null,
		coverage,
	};
	writeFileSync(join(archiveDir, "meta.json"), JSON.stringify(finalMeta, null, 2));

	return {
		transcriptMdPath: join(archiveDir, "transcript.md"),
		metaPath: join(archiveDir, "meta.json"),
		chunks,
		groups,
		coverage,
	};
}
