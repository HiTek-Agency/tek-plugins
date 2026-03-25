/**
 * Plugin entry point.
 * Exports register() and optionally cleanup().
 *
 * IMPORTANT: Must be valid ES module (use export, not module.exports).
 * Cannot import from @tek/core — use the context object for everything.
 */

/**
 * @param {object} context - Sandboxed plugin context
 */
export async function register(context) {
	const config = context.getConfig();
	const exampleSetting = config.exampleSetting || "hello";

	// Register a tool that agents can use
	context.addTool("example", {
		description: "An example tool — replace with your implementation",
		parameters: {
			type: "object",
			properties: {
				input: {
					type: "string",
					description: "Input to process",
				},
			},
			required: ["input"],
		},
		execute: async ({ input }) => {
			context.logger.info(`Example tool called with: ${input}`);
			return {
				result: `${exampleSetting}: ${input}`,
			};
		},
	});

	// Add context section so agents know about this plugin
	context.addContextSection(
		"My Plugin",
		"You have access to the `example` tool. Use it when...",
	);

	context.logger.info(`My Plugin registered (setting: ${exampleSetting})`);
}

export async function cleanup() {
	// Called when plugin is unloaded — clean up any resources
}
