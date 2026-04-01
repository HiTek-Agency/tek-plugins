/**
 * URL Summarize Plugin — summarize web pages, articles, YouTube videos, and
 * other URLs using AI via the `summarize` CLI.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PROVIDER_ENV_MAP = {
	openai: "OPENAI_API_KEY",
	anthropic: "ANTHROPIC_API_KEY",
	google: "GEMINI_API_KEY",
};

const PROVIDER_DEFAULT_MODEL = {
	google: "google/gemini-2.5-flash",
	openai: "openai/gpt-4o-mini",
	anthropic: "anthropic/claude-sonnet-4-5",
};

const SUMMARIZE_SEARCH_PATHS = [
	join(homedir(), "tek", "bin", "summarize"),
];

async function findSummarizeCli() {
	for (const p of SUMMARIZE_SEARCH_PATHS) {
		try {
			await execFileAsync(p, ["--version"], { timeout: 5000 });
			return p;
		} catch {
			// not here
		}
	}
	try {
		const { stdout } = await execFileAsync("which", ["summarize"]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

export async function register(context) {
	const config = context.getConfig();
	const provider = config.provider || "google";
	const modelOverride = config.model || "";
	const defaultLength = config.defaultLength || "medium";

	const cliPath = await findSummarizeCli();
	if (!cliPath) {
		context.logger.warn(
			"summarize CLI not found. Install it with: npm i -g @steipete/summarize",
		);
	} else {
		context.logger.info(`summarize CLI found: ${cliPath}`);
	}

	let apiKey = null;
	try {
		apiKey = context.getVaultKey(provider);
	} catch {
		context.logger.warn(`Could not read vault key for provider "${provider}"`);
	}

	context.addTool("summarize_url", {
		description:
			"Summarize the content at a URL (web page, article, YouTube video, PDF, etc). " +
			"Returns a concise AI-generated summary without wasting tokens on raw content. " +
			"Use this when you need to understand what's at a URL without fetching the full page.",
		parameters: {
			type: "object",
			properties: {
				url: { type: "string", description: "The URL to summarize" },
				length: {
					type: "string",
					enum: ["short", "medium", "long"],
					description: `Summary length: short (~900 chars), medium (~1800), long (~4200). Default: ${defaultLength}`,
				},
				query: {
					type: "string",
					description:
						"Optional focus query — the summary will emphasize information relevant to this question or topic",
				},
			},
			required: ["url"],
		},
		execute: async ({ url, length, query }) => {
			const cli = cliPath ?? (await findSummarizeCli());
			if (!cli) {
				return {
					error: true,
					message:
						"The summarize CLI is not installed. " +
						"Install it with: npm i -g @steipete/summarize (requires Node 22+) " +
						"or: brew install steipete/tap/summarize",
				};
			}

			const currentConfig = context.getConfig();
			const currentProvider = currentConfig.provider || provider;
			const currentModel = currentConfig.model || modelOverride;

			let currentApiKey = apiKey;
			try {
				currentApiKey = context.getVaultKey(currentProvider);
			} catch {
				// use cached
			}

			if (!currentApiKey) {
				return {
					error: true,
					message: `No API key found for provider "${currentProvider}". Add one in Tek Settings > API Keys.`,
				};
			}

			const cliArgs = [url];
			const model = currentModel || PROVIDER_DEFAULT_MODEL[currentProvider];
			if (model) cliArgs.push("--model", model);
			cliArgs.push("--length", length || defaultLength);
			cliArgs.push("--plain", "--json");
			if (query) cliArgs.push("--prompt", query);

			const envVarName = PROVIDER_ENV_MAP[currentProvider];
			const env = { ...process.env, PATH: process.env.PATH || "" };
			if (envVarName && currentApiKey) env[envVarName] = currentApiKey;

			try {
				context.logger.info(
					`Summarizing URL: ${url} (provider: ${currentProvider}, length: ${length || defaultLength})`,
				);

				const { stdout, stderr } = await execFileAsync(cli, cliArgs, {
					env,
					timeout: 120_000,
					maxBuffer: 10 * 1024 * 1024,
				});

				if (stderr) context.logger.debug(`summarize stderr: ${stderr}`);

				try {
					const result = JSON.parse(stdout);
					return {
						url,
						summary: result.summary || result.content || stdout,
						title: result.title || undefined,
						wordCount: result.wordCount || undefined,
						model: result.model || model,
						cached: result.cached || false,
					};
				} catch {
					return { url, summary: stdout.trim(), model };
				}
			} catch (err) {
				const errMsg = err.stderr || err.message || String(err);
				context.logger.error(`summarize failed for ${url}: ${errMsg}`);
				return { error: true, url, message: `Failed to summarize URL: ${errMsg}` };
			}
		},
	});

	context.addContextSection(
		"URL Summarization",
		"You have the `summarize_url` tool available. Use it to summarize web pages, articles, " +
			"YouTube videos, and other URLs. This is more efficient than fetching raw page content " +
			"because it returns a concise AI-generated summary. Use it when you need to understand " +
			"what's at a URL or when the user shares a link.",
	);

	context.logger.info(
		`URL Summarize plugin registered (provider: ${provider}, length: ${defaultLength})`,
	);
}

export async function cleanup() {
	// No persistent resources to clean up
}
