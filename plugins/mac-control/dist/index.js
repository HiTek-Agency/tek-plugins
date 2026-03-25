/**
 * Mac Control Plugin — gives agents the ability to see and interact with the Mac desktop.
 * Wraps the Peekaboo CLI (brew install steipete/tap/peekaboo) for screenshots,
 * UI element discovery, clicking, typing, window management, and app control.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Known locations where peekaboo CLI may be installed */
const PEEKABOO_SEARCH_PATHS = [
	"/opt/homebrew/bin/peekaboo",
	"/usr/local/bin/peekaboo",
	join(homedir(), "tek", "bin", "peekaboo"),
];

const DEFAULT_TIMEOUT = 30_000;
const SCREENSHOT_TIMEOUT = 60_000;

async function findPeekabooCli() {
	for (const p of PEEKABOO_SEARCH_PATHS) {
		try {
			await execFileAsync(p, ["--version"], { timeout: 5000 });
			return p;
		} catch {
			// not here
		}
	}
	try {
		const { stdout } = await execFileAsync("which", ["peekaboo"]);
		return stdout.trim() || null;
	} catch {
		return null;
	}
}

async function runPeekaboo(cli, args, timeout = DEFAULT_TIMEOUT) {
	try {
		const { stdout, stderr } = await execFileAsync(cli, [...args, "--json"], {
			timeout,
			maxBuffer: 50 * 1024 * 1024,
			env: { ...process.env, PATH: process.env.PATH || "" },
		});
		try {
			return JSON.parse(stdout);
		} catch {
			return { result: stdout.trim() };
		}
	} catch (err) {
		return {
			error: true,
			message: err.stderr || err.message || String(err),
		};
	}
}

export async function register(context) {
	if (process.platform !== "darwin") {
		context.logger.warn("Mac Control plugin only works on macOS, skipping tool registration");
		return;
	}

	const config = context.getConfig();

	const cliPath = await findPeekabooCli();
	if (!cliPath) {
		context.logger.warn(
			"peekaboo CLI not found. Install it with: brew install steipete/tap/peekaboo",
		);
	} else {
		context.logger.info(`peekaboo CLI found: ${cliPath}`);
	}

	const getCli = async () => cliPath ?? (await findPeekabooCli());

	const notInstalled = () => ({
		error: true,
		message: "peekaboo CLI is not installed. Install with: brew install steipete/tap/peekaboo",
	});

	// ── mac__see ─────────────────────────────────────────────────────────
	context.addTool("mac__see", {
		description:
			"Capture the screen and discover UI elements with annotated IDs. " +
			"Returns a snapshot with clickable element IDs (e.g. B1, T2) that can be used with mac__click. " +
			"Use this to understand what's on screen before interacting.",
		parameters: {
			type: "object",
			properties: {
				app: {
					type: "string",
					description: 'Target app name (e.g. "Safari", "Finder") or "frontmost" for the active app',
				},
			},
			required: [],
		},
		execute: async ({ app }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const args = ["capture", "live"];
			if (app) args.push("--app", app);
			return runPeekaboo(cli, args, SCREENSHOT_TIMEOUT);
		},
	});

	// ── mac__click ───────────────────────────────────────────────────────
	context.addTool("mac__click", {
		description:
			"Click on a UI element by its ID (from mac__see), text label, or screen coordinates. " +
			"Supports single, double, and right-click.",
		parameters: {
			type: "object",
			properties: {
				elementId: { type: "string", description: "Element ID from mac__see output (e.g. B1, T2, S3)" },
				query: { type: "string", description: "Text label to search for and click (e.g. 'Save', 'OK')" },
				coords: { type: "string", description: "Screen coordinates as 'x,y' (e.g. '500,300')" },
				action: { type: "string", enum: ["single", "double", "right"], description: "Click type (default: single)" },
				app: { type: "string", description: "Target app for the click" },
			},
			required: [],
		},
		execute: async ({ elementId, query, coords, action, app }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const args = ["click"];
			if (query) args.push(query);
			if (elementId) args.push("--on", elementId);
			if (coords) args.push("--coords", coords);
			if (action === "double") args.push("--double");
			if (action === "right") args.push("--right");
			if (app) args.push("--app", app);
			return runPeekaboo(cli, args);
		},
	});

	// ── mac__type ────────────────────────────────────────────────────────
	context.addTool("mac__type", {
		description:
			"Type text into the focused element or a specific UI element. " +
			"For pasting longer text, use mac__hotkey with 'cmd+v' after setting clipboard.",
		parameters: {
			type: "object",
			properties: {
				text: { type: "string", description: "Text to type" },
				app: { type: "string", description: "Target app to type into" },
			},
			required: ["text"],
		},
		execute: async ({ text, app }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const args = ["type", text];
			if (app) args.push("--app", app);
			return runPeekaboo(cli, args);
		},
	});

	// ── mac__hotkey ──────────────────────────────────────────────────────
	context.addTool("mac__hotkey", {
		description:
			"Press keyboard shortcuts and key combinations. " +
			"Examples: 'cmd+c' (copy), 'cmd+v' (paste), 'cmd+shift+4' (screenshot), 'cmd+tab' (switch app).",
		parameters: {
			type: "object",
			properties: {
				keys: { type: "string", description: "Key combo string (e.g. 'cmd+c', 'cmd+shift+s')" },
				app: { type: "string", description: "Target app for the hotkey" },
			},
			required: ["keys"],
		},
		execute: async ({ keys, app }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const args = ["hotkey", keys];
			if (app) args.push("--app", app);
			return runPeekaboo(cli, args);
		},
	});

	// ── mac__screenshot ──────────────────────────────────────────────────
	context.addTool("mac__screenshot", {
		description:
			"Take a screenshot of the screen, a specific window, or app. " +
			"Returns the image as base64 data. Optionally analyze it with AI vision.",
		parameters: {
			type: "object",
			properties: {
				app: { type: "string", description: 'Target app to screenshot (or "frontmost")' },
				mode: { type: "string", enum: ["screen", "window", "frontmost"], description: "Capture mode (default: screen)" },
				path: { type: "string", description: "Save screenshot to this file path instead of returning base64" },
				analyze: { type: "string", description: "Optional question to analyze the screenshot with AI vision" },
			},
			required: [],
		},
		execute: async ({ app, mode, path, analyze }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const args = ["image"];
			if (app) args.push("--app", app);
			if (mode) args.push("--mode", mode);
			if (path) {
				args.push("--path", path);
			} else {
				args.push("--format", "png");
			}
			if (analyze) args.push("--analyze", analyze);
			return runPeekaboo(cli, args, SCREENSHOT_TIMEOUT);
		},
	});

	// ── mac__open_app ────────────────────────────────────────────────────
	context.addTool("mac__open_app", {
		description: "Launch, focus, quit, or hide an application.",
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: 'App name (e.g. "Safari", "Terminal", "Finder")' },
				action: { type: "string", enum: ["launch", "focus", "quit", "hide", "unhide"], description: "What to do with the app (default: launch)" },
			},
			required: ["name"],
		},
		execute: async ({ name, action }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const a = action || "launch";
			return runPeekaboo(cli, ["app", "--action", a, "--name", name]);
		},
	});

	// ── mac__window ─────────────────────────────────────────────────────
	context.addTool("mac__window", {
		description:
			"List, focus, move, resize, or manage windows. " +
			"Use 'list' to see all windows, then target specific ones by app or title.",
		parameters: {
			type: "object",
			properties: {
				action: { type: "string", enum: ["list", "focus", "move", "resize", "close", "minimize"], description: "Window action (default: list)" },
				app: { type: "string", description: "Target app name" },
				title: { type: "string", description: "Window title to target" },
				x: { type: "number", description: "X position (for move)" },
				y: { type: "number", description: "Y position (for move)" },
				width: { type: "number", description: "Width (for resize)" },
				height: { type: "number", description: "Height (for resize)" },
			},
			required: [],
		},
		execute: async ({ action, app, title, x, y, width, height }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const a = action || "list";
			if (a === "list") {
				const args = ["list", "windows"];
				if (app) args.push("--app", app);
				return runPeekaboo(cli, args);
			}
			const args = ["window", a];
			if (app) args.push("--app", app);
			if (title) args.push("--window-title", title);
			if (x !== undefined && y !== undefined) args.push("--position", `${x},${y}`);
			if (width !== undefined && height !== undefined) args.push("--size", `${width},${height}`);
			return runPeekaboo(cli, args);
		},
	});

	// ── mac__system_info ─────────────────────────────────────────────────
	context.addTool("mac__system_info", {
		description: "Get system information: running applications, windows, screens, and permissions status.",
		parameters: {
			type: "object",
			properties: {
				item: { type: "string", enum: ["apps", "windows", "screens", "permissions"], description: "What to list (default: apps)" },
			},
			required: [],
		},
		execute: async ({ item }) => {
			const cli = await getCli();
			if (!cli) return notInstalled();
			const i = item || "apps";
			if (i === "permissions") return runPeekaboo(cli, ["permissions", "status"]);
			if (i === "screens") return runPeekaboo(cli, ["list", "screens"]);
			if (i === "windows") return runPeekaboo(cli, ["list", "windows"]);
			return runPeekaboo(cli, ["list", "apps"]);
		},
	});

	context.addContextSection(
		"Mac Control",
		"You have Mac control tools available (mac__see, mac__click, mac__type, mac__hotkey, " +
			"mac__screenshot, mac__open_app, mac__window, mac__system_info). " +
			"Use `mac__see` first to capture the screen and discover clickable UI element IDs, " +
			"then use `mac__click` with those IDs to interact. This is the see-then-act pattern. " +
			"Use `mac__screenshot` for just an image, `mac__see` when you need to interact.",
	);

	context.logger.info(`Mac Control plugin registered (peekaboo: ${cliPath ?? "not found"})`);
}

export async function cleanup() {
	// No persistent resources to clean up
}
