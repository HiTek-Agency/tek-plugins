/**
 * Plan 104-05 Task 3: Google Meet v2 API post-meeting reconciler.
 *
 * Per CONTEXT D-05 + D-11, when the user's Workspace tier exposes the Meet
 * API's conferenceRecords.transcripts.entries endpoint, we replace our local
 * whisper speakerGuess values with the authoritative participant attributions
 * from Google's own transcription service.
 *
 * Design (per RESEARCH §MEET-12, §MEET-13):
 *   - fire-and-forget — onMeetingEnd does not await this
 *   - polls every pollIntervalMs (default 60s) for up to deadlineMs (default 60min)
 *   - short-circuits to "unavailable" after 2 empty-record polls so we don't
 *     hammer the API for an hour on accounts that will never have data
 *     (RESEARCH Pitfall 3 — free Gmail + Workspace tiers without Meet transcription)
 *   - on success: reads raw.jsonl, replaces speakerGuess via time-overlap
 *     fuzzy match (≥50% overlap), writes raw.jsonl back, updates meta.json
 *   - leaves the original transcript.md alone — the caller (onMeetingEnd) is
 *     responsible for re-running finalize() if they want the rewritten md
 *     (this keeps the reconciler's I/O surface minimal and testable)
 *
 * Unit tests inject a mock `meetClient` so no real network calls happen.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

async function loadGoogleapis() {
	const mod = await Function('return import("googleapis")')();
	return mod.google;
}

/**
 * Compute time-range overlap fraction. Returns a number in [0, 1] where 1.0
 * means full overlap relative to the LONGER of the two ranges. Two ranges
 * that don't overlap at all return 0. Defensive against zero-length ranges.
 */
export function timeOverlap(a, b) {
	const start = Math.max(a.start, b.start);
	const end = Math.min(a.end, b.end);
	const overlap = Math.max(0, end - start);
	const dur = Math.max(a.end - a.start, b.end - b.start);
	return dur > 0 ? overlap / dur : 0;
}

function readJsonl(path) {
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	} catch {
		return [];
	}
}

function writeJsonl(path, rows) {
	writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/**
 * Pure function: for each Meet-API entry, find any local chunks whose
 * time-range overlaps ≥50% and replace speakerGuess + source. Returns a
 * COPY — caller writes back. Never mutates the input array.
 *
 * Exported for unit testing and for plan 104-05's onMeetingEnd to call
 * directly if we ever want reconcile-then-finalize in a single pass.
 */
export function applyEntryMatches(localChunks, meetEntries) {
	const updated = localChunks.map((c) => ({ ...c }));
	for (const entry of meetEntries) {
		const entryRange = { start: entry.startMs, end: entry.endMs };
		for (const lc of updated) {
			const ol = timeOverlap(
				{ start: lc.t_start_ms, end: lc.t_end_ms },
				entryRange,
			);
			if (ol >= 0.5) {
				lc.speakerGuess = entry.participantName;
				lc.source = "meet-api";
			}
		}
	}
	return updated;
}

/**
 * Start the polling loop. Returns a handle `{promise, cancel}`:
 *   - promise resolves to one of:
 *       {status: "reconciled", entries, updates}
 *       {status: "unavailable", reason: "no-conference-record"}
 *       {status: "timeout"}
 *       {status: "cancelled"}
 *   - cancel() flips a flag that the loop checks after each await; in-flight
 *     API call still completes, but the next iteration doesn't start.
 *
 * @param {object} args
 * @param {string} args.meetingCode  Meet code from the URL (e.g. "abc-defg-hij")
 * @param {Date|number} args.startedAt  meeting start time (for conferenceRecord filter)
 * @param {string} args.archiveDir     absolute path to the meeting archive dir
 * @param {object} args.auth           OAuth2Client with meetings.space.readonly scope
 * @param {number} [args.pollIntervalMs=60000]
 * @param {number} [args.deadlineMs=3600000]
 * @param {object} [args.meetClient]   injected for tests
 * @returns {Promise<{promise: Promise<object>, cancel: () => void}>}
 */
export async function startReconciliation({
	meetingCode,
	startedAt,
	archiveDir,
	auth,
	pollIntervalMs = 60_000,
	deadlineMs = 60 * 60 * 1000,
	meetClient,
}) {
	let cancelled = false;
	let meet = meetClient;
	if (!meet) {
		const google = await loadGoogleapis();
		meet = google.meet({ version: "v2", auth });
	}
	const startedAtMs =
		startedAt instanceof Date ? startedAt.getTime() : Number(startedAt);
	const metaPath = join(archiveDir, "meta.json");
	const rawPath = join(archiveDir, "raw.jsonl");

	async function updateMeta(patch) {
		try {
			const meta = JSON.parse(readFileSync(metaPath, "utf8"));
			writeFileSync(
				metaPath,
				JSON.stringify({ ...meta, ...patch }, null, 2),
			);
		} catch {
			// meta.json may not exist yet if reconciler started before finalize
			// wrote it — patch alone isn't a valid meta file, so we skip
		}
	}

	const deadline = Date.now() + deadlineMs;
	let emptyPolls = 0;

	const promise = (async () => {
		while (Date.now() < deadline && !cancelled) {
			let records;
			try {
				records = await meet.conferenceRecords.list({
					filter: `space.meetingCode="${meetingCode}"`,
				});
			} catch (e) {
				// 403 on unauthorized / no Workspace tier / revoked scope — treat
				// as unavailable immediately, no point retrying.
				await updateMeta({
					reconciliation: "unavailable",
					reconciledAt: Date.now(),
					reconciliationError: String(e?.message || e),
				});
				return { status: "unavailable", reason: "api-error" };
			}
			if (cancelled) break;
			const list = records?.data?.conferenceRecords || [];
			// Pick the record whose startTime is at or after our meeting start
			// (minus a 60s slack for clock skew between gateway and Google).
			const record = list.find(
				(r) => new Date(r.startTime || 0).getTime() >= startedAtMs - 60_000,
			);
			if (!record) {
				emptyPolls++;
				if (emptyPolls >= 2) {
					await updateMeta({
						reconciliation: "unavailable",
						reconciledAt: Date.now(),
					});
					return { status: "unavailable", reason: "no-conference-record" };
				}
				await new Promise((r) => setTimeout(r, pollIntervalMs));
				continue;
			}
			let transcriptsResp;
			try {
				transcriptsResp = await meet.conferenceRecords.transcripts.list({
					parent: record.name,
				});
			} catch (e) {
				await updateMeta({
					reconciliation: "unavailable",
					reconciledAt: Date.now(),
					reconciliationError: String(e?.message || e),
				});
				return { status: "unavailable", reason: "transcripts-api-error" };
			}
			if (cancelled) break;
			const ready = (transcriptsResp?.data?.transcripts || []).find(
				(t) => t.state === "FILE_GENERATED",
			);
			if (!ready) {
				await new Promise((r) => setTimeout(r, pollIntervalMs));
				continue;
			}
			let entriesResp;
			try {
				entriesResp = await meet.conferenceRecords.transcripts.entries.list({
					parent: ready.name,
				});
			} catch (e) {
				await updateMeta({
					reconciliation: "unavailable",
					reconciledAt: Date.now(),
					reconciliationError: String(e?.message || e),
				});
				return { status: "unavailable", reason: "entries-api-error" };
			}
			const meetEntries = (entriesResp?.data?.transcriptEntries || []).map(
				(e) => ({
					participantName: e.participant || "Unknown",
					startMs: new Date(e.startTime || 0).getTime(),
					endMs: new Date(e.endTime || 0).getTime(),
					text: e.text || "",
				}),
			);
			const localChunks = readJsonl(rawPath);
			const updated = applyEntryMatches(localChunks, meetEntries);
			writeJsonl(rawPath, updated);
			await updateMeta({
				reconciliation: "reconciled",
				reconciledAt: Date.now(),
			});
			return {
				status: "reconciled",
				entries: meetEntries.length,
				updates: updated.filter((c) => c.source === "meet-api").length,
			};
		}
		if (cancelled) {
			await updateMeta({
				reconciliation: "cancelled",
				reconciledAt: Date.now(),
			});
			return { status: "cancelled" };
		}
		await updateMeta({
			reconciliation: "timeout",
			reconciledAt: Date.now(),
		});
		return { status: "timeout" };
	})();

	return {
		promise,
		cancel: () => {
			cancelled = true;
		},
	};
}
