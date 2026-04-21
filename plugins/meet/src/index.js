// Tek Meet — gateway-side (plan 104-01b SCAFFOLD). Plan 104-02 replaces this file with real behavior.
// IMPORTANT: approvalTier values ARE NOT placeholders — they are locked-in per CONTEXT D-02 + checker blocker-3.
//   - join_observer: "session" (tab audio only, no mic exposure — one approval per session is enough)
//   - join_participant: "always" (mic exposure — approve every use)
export async function register(ctx) {
	const logger = ctx.log ?? console;
	logger.info?.("[meet] plugin loaded (scaffold — no behavior yet; see plan 104-02)");
	ctx.addTool(
		"join_observer",
		{
			description:
				"Join a Google Meet as a silent observer (SCAFFOLD — not yet implemented). Tab audio only; no mic exposure.",
			inputSchema: {
				type: "object",
				properties: { url: { type: "string" } },
				required: ["url"],
			},
			execute: async () => ({ ok: false, reason: "scaffold-only" }),
		},
		{ approvalTier: "session" },
	);
	ctx.addTool(
		"join_participant",
		{
			description:
				"Join a Google Meet with wake-word participant mode (SCAFFOLD — not yet implemented). Mic exposure when wake-word fires.",
			inputSchema: {
				type: "object",
				properties: {
					url: { type: "string" },
					voiceProfileId: { type: "string" },
				},
				required: ["url"],
			},
			execute: async () => ({ ok: false, reason: "scaffold-only" }),
		},
		{ approvalTier: "always" },
	);
}
