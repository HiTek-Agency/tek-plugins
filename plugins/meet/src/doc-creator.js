/**
 * Plan 104-05 Task 2: Google Doc creator.
 *
 * Uses the same googleapis client pattern as packages/gateway/src/skills/google-workspace.ts
 * (see docs_create around line 440): google.docs({version:"v1", auth}).documents.create +
 * documents.batchUpdate with a single insertText request at index 1.
 *
 * `auth` must be an authenticated OAuth2Client with at minimum the
 * https://www.googleapis.com/auth/documents scope. Plugins don't own Google
 * auth today — plan 104-09 will wire ctx.getGoogleAuth() into the plugin
 * sandbox. Until then, this module is only called when the plugin context
 * happens to expose a compatible helper; otherwise onMeetingEnd logs a warn
 * and skips Doc creation (the local summary.md + transcript.md are still
 * canonical per plan 104-05 must-have #7).
 *
 * Mock-friendly: accepts an optional `docsClient` param for unit tests so we
 * don't actually import googleapis in the test run.
 */

async function loadGoogleapis() {
	// Dynamic import so the plugin works even if googleapis isn't in its own
	// node_modules (the gateway package is the source of truth — same lazy-import
	// pattern as meet-transcriber.js's @fugood/whisper.node loader).
	const mod = await Function('return import("googleapis")')();
	return mod.google;
}

/**
 * @param {object} args
 * @param {import('google-auth-library').OAuth2Client} args.auth authenticated OAuth2Client
 * @param {string} args.title       Doc title (e.g. "Standup — 2026-04-21")
 * @param {string} args.summaryMd   markdown string to write first
 * @param {string} args.transcriptMd  markdown string to write after an ---- separator
 * @param {object} [args.docsClient] injected for tests ({documents:{create, batchUpdate}})
 * @returns {Promise<{documentId: string, url: string}>}
 */
export async function createMeetingDoc({
	auth,
	title,
	summaryMd,
	transcriptMd,
	docsClient,
}) {
	let docs = docsClient;
	if (!docs) {
		const google = await loadGoogleapis();
		docs = google.docs({ version: "v1", auth });
	}

	const created = await docs.documents.create({ requestBody: { title } });
	const documentId = created.data?.documentId;
	if (!documentId) {
		throw new Error("docs.documents.create returned no documentId");
	}

	const body = [summaryMd, "", "----", "", transcriptMd].join("\n");

	await docs.documents.batchUpdate({
		documentId,
		requestBody: {
			requests: [{ insertText: { location: { index: 1 }, text: body } }],
		},
	});

	return {
		documentId,
		url: `https://docs.google.com/document/d/${documentId}/edit`,
	};
}
