/**
 * Chrome Control Plugin — drives your real Chrome browser via a local MV3 extension
 * over a loopback WebSocket. The gateway-side plugin owns the WS server, authenticates
 * the extension handshake, and exposes chrome__* tools that proxy RPCs through to the
 * extension's offscreen document (which uses chrome.debugger / scripting / tabs APIs).
 *
 * This file is a scaffold stub for Phase 101 Plan 02. Full behavior lands in:
 *   - Plan 03 — WS server + pairing handshake
 *   - Plan 04 — tabs/navigation/read/find/click/type tools
 *   - Plan 05 — screenshot + javascript_tool
 */

const TOOL_NAMES = [
	"chrome__tabs_list",
	"chrome__tabs_create",
	"chrome__navigate",
	"chrome__read_page",
	"chrome__find",
	"chrome__click",
	"chrome__form_input",
	"chrome__screenshot",
	// javascript_tool is dangerous — user must always approve each call
	"chrome__javascript_tool",
];

const NOT_YET = async () => ({
	ok: false,
	reason: "not yet implemented (plan 04/05)",
});

export async function register(context) {
	const config = context.getConfig() || {};
	const wsPort = config.wsPort ?? 52871;
	const screenshotMaxWidth = config.screenshotMaxWidth ?? 1920;

	context.logger?.info?.(
		`chrome plugin loaded (stub — handshake added in plan 03). wsPort=${wsPort} screenshotMaxWidth=${screenshotMaxWidth}`,
	);

	for (const name of TOOL_NAMES) {
		const toolDef = {
			description: `${name} (stub — implemented in plan 04/05)`,
			parameters: { type: "object", properties: {}, required: [] },
			execute: NOT_YET,
		};

		if (name === "chrome__javascript_tool") {
			// Always-approve tier — agent-originated JS eval must never be silent
			context.addTool(name, toolDef, { approvalTier: "always" });
		} else {
			context.addTool(name, toolDef);
		}
	}

	context.addContextSection?.(
		"Chrome Control",
		"You have Chrome browser control tools available (chrome__tabs_list, chrome__tabs_create, " +
			"chrome__navigate, chrome__read_page, chrome__find, chrome__click, chrome__form_input, " +
			"chrome__screenshot, chrome__javascript_tool). These are currently stubbed — full behavior " +
			"arrives in later plans of Phase 101. `chrome__javascript_tool` always requires user approval.",
	);
}

export async function cleanup() {
	// No persistent resources yet — WS server + debugger session cleanup arrives in plan 03/04.
}
