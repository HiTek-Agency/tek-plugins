/**
 * Bot Chrome profile manager.
 *
 * Spawns a dedicated headful Chrome instance for the Meet bot using a
 * separate --user-data-dir (so it never touches the user's real browser
 * profile per CONTEXT D-17) and --load-extension pointing at the installed
 * meet extension. Starts at about:blank so the MAIN-world content script
 * can monkey-patch getUserMedia BEFORE Meet loads (RESEARCH Pitfall 1);
 * plan 104-04 navigates to the Meet URL via CDP after the WS handshake.
 *
 * macOS-only for MVP per CONTEXT D-03. spawnFn injection allows unit tests
 * to run without spawning a real Chrome.
 */

import { spawn as realSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const PROFILE_DIR = join(
	homedir(),
	".config",
	"tek",
	"meet",
	"chrome-profile",
);
export const DEFAULT_EXTENSION_DIR = join(
	homedir(),
	".config",
	"tek",
	"plugins",
	"meet",
	"extension",
);

let _chromeProc = null;

export function getChromeExec() {
	if (platform() === "darwin") {
		return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
	}
	throw new Error(
		"Platform not supported — Tek Meet is macOS-only for MVP (see CONTEXT D-03).",
	);
}

/**
 * Pure argv builder — exported for unit testing. The bot opens at about:blank
 * by DEFAULT (plan 104-02 invariant — the MAIN-world content script must run
 * before Meet loads per RESEARCH Pitfall 1); plan 104-04 drives the
 * navigation to the real Meet URL via CDP after the extension completes its
 * WS handshake.
 *
 * Plan 104-07 adds an opt-in `startUrl` override for the first-run bot
 * sign-in flow (accounts.google.com). Callers that join meetings MUST stick
 * with the about:blank default.
 */
export function buildChromeArgs({
	profileDir = PROFILE_DIR,
	extensionDir = DEFAULT_EXTENSION_DIR,
	startUrl = "about:blank",
} = {}) {
	return [
		`--user-data-dir=${profileDir}`,
		`--load-extension=${extensionDir}`,
		"--new-window",
		"--no-first-run",
		"--no-default-browser-check",
		startUrl,
	];
}

/**
 * Spawn (or reuse) the bot Chrome. Returns a handle with {pid, profileDir, meetUrl, reused}.
 * Does NOT navigate to meetUrl — that happens in plan 104-04 via CDP after handshake.
 */
export async function spawnBotChrome({
	meetUrl,
	logger = console,
	spawnFn = realSpawn,
	extensionDir,
	profileDir,
	startUrl,
} = {}) {
	if (_chromeProc && !_chromeProc.killed) {
		logger.info?.("[meet] bot chrome already running; reusing");
		return {
			pid: _chromeProc.pid,
			profileDir: profileDir ?? PROFILE_DIR,
			meetUrl,
			reused: true,
		};
	}
	const resolvedProfileDir = profileDir ?? PROFILE_DIR;
	mkdirSync(resolvedProfileDir, { recursive: true });
	const exec = getChromeExec();
	const args = buildChromeArgs({
		profileDir: resolvedProfileDir,
		extensionDir,
		startUrl,
	});
	logger.info?.(`[meet] spawning bot chrome: ${exec}`);
	const proc = spawnFn(exec, args, { detached: false, stdio: "ignore" });
	_chromeProc = proc;
	if (typeof _chromeProc.on === "function") {
		_chromeProc.on("exit", (code) => {
			logger.info?.(`[meet] bot chrome exited (code=${code})`);
			if (_chromeProc === proc) _chromeProc = null;
		});
	}
	return {
		pid: _chromeProc.pid,
		profileDir: resolvedProfileDir,
		meetUrl,
		reused: false,
	};
}

export async function stopBotChrome() {
	if (!_chromeProc) return { stopped: false, reason: "not-running" };
	const proc = _chromeProc;
	const result = await new Promise((resolve) => {
		let forced = false;
		const exited = () => {
			clearTimeout(timer);
			resolve({ stopped: true, forced });
		};
		const timer = setTimeout(() => {
			forced = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				/* report unconfirmed below */
			}
			// Signal delivery is not proof of exit. Retain the handle so a
			// retry can stop it; a later exit callback clears only this process.
			resolve({
				stopped: false,
				forced: true,
				reason: "termination-unconfirmed",
			});
		}, 5000);
		// Register before kill: a fast (or synchronously mocked) exit must not
		// get missed and then look like an unconfirmed forced termination.
		proc.once?.("exit", exited);
		try {
			proc.kill("SIGTERM");
		} catch {
			/* timeout reports unconfirmed */
		}
	});
	if (result.stopped && _chromeProc === proc) _chromeProc = null;
	return result;
}

/** Test-only reset — NOT part of public API. */
export function _resetForTests() {
	_chromeProc = null;
}
