/**
 * Pure message dispatcher used by extension/background.js.
 * Extracted into its own module so node:test can import it without requiring
 * the chrome.* extension APIs (background.js uses them; this file does not).
 *
 * Plan 104-02 stubs all tool calls with a "not-implemented" result; plans
 * 104-04 / 104-05 / 104-06 replace those stubs with real tabCapture / CDP /
 * TTS implementations.
 */

export async function dispatch(msg, sendFn) {
	if (!msg || typeof msg !== "object") return;
	if (msg.kind === "welcome") {
		return { kind: "ack", okay: true };
	}
	if (msg.kind === "call") {
		sendFn({
			kind: "result",
			id: msg.id,
			error: `tool ${msg.tool} not implemented in plan 104-02 (scaffolded, see plans 04-06)`,
		});
		return;
	}
	if (msg.kind === "ping") {
		sendFn({ kind: "pong", t: Date.now() });
		return;
	}
}
