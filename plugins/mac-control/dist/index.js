/**
 * Mac Control Plugin — gives agents the ability to see and interact with the Mac desktop.
 * Wraps the Peekaboo CLI (brew install steipete/tap/peekaboo) for screenshots,
 * UI element discovery, clicking, typing, window management, and app control.
 */
import { execFile } from "node:child_process";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const DEFAULT_SNAPSHOT_DIR = join(homedir(), ".config", "tek", "mac-control", "snapshots");
const DEFAULT_RETENTION_DAYS = 2;
/** How often to re-run the cleanup sweep while the gateway is alive. */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
/** Module-level handle so cleanup() can stop the sweep timer on plugin unload. */
let cleanupTimer = null;
/** Expand a leading `~` to the user's home directory. */
function expandHome(p) {
    if (p.startsWith("~/"))
        return join(homedir(), p.slice(2));
    if (p === "~")
        return homedir();
    return p;
}
/**
 * Delete files in `dir` whose mtime is older than `retentionDays`. Returns
 * `{ deleted, scanned }`. Silently no-ops if the dir doesn't exist or
 * retention is <= 0. Runs shallow + recursive (peekaboo organizes snapshots
 * in subdirs per session).
 */
async function cleanupOldSnapshots(dir, retentionDays) {
    if (!retentionDays || retentionDays <= 0)
        return { deleted: 0, scanned: 0 };
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    let deleted = 0;
    let scanned = 0;
    async function walk(path) {
        let entries;
        try {
            entries = await readdir(path, { withFileTypes: true });
        }
        catch {
            return; // dir doesn't exist (or perms) — nothing to do
        }
        for (const ent of entries) {
            const full = join(path, ent.name);
            if (ent.isDirectory()) {
                await walk(full);
                // After recursing, try to remove the dir if now empty
                try {
                    const left = await readdir(full);
                    if (left.length === 0) {
                        await unlink(full).catch(() => { });
                    }
                }
                catch {
                    /* ignore */
                }
                continue;
            }
            scanned++;
            try {
                const st = await stat(full);
                if (st.mtimeMs < cutoff) {
                    await unlink(full);
                    deleted++;
                }
            }
            catch {
                /* ignore — file may have been removed mid-scan */
            }
        }
    }
    await walk(dir);
    return { deleted, scanned };
}
/** Known locations where peekaboo CLI may be installed */
const PEEKABOO_SEARCH_PATHS = [
    "/opt/homebrew/bin/peekaboo", // Homebrew (Apple Silicon)
    "/usr/local/bin/peekaboo", // Homebrew (Intel)
    join(homedir(), "tek", "bin", "peekaboo"), // bundled with tek (if available)
];
/** Default timeout for peekaboo commands (30s) */
const DEFAULT_TIMEOUT = 30_000;
/** Screenshot timeout (may take longer with AI analysis) */
const SCREENSHOT_TIMEOUT = 60_000;
/**
 * Find the peekaboo CLI binary.
 *
 * Preference order:
 *   1. TEK_BUNDLED_PEEKABOO env var — set by Tek Gateway.app, pointing
 *      at its bundled-and-re-signed sidecar in Contents/MacOS/.
 *      This is the binary whose TCC identity inherits from Tek Gateway.app, so
 *      Screen Recording / Accessibility / Automation grants actually work.
 *   2. Homebrew / ~/tek/bin locations (for dev or standalone gateway).
 *   3. $PATH fallback.
 */
async function findPeekabooCli() {
    const bundled = process.env.TEK_BUNDLED_PEEKABOO;
    if (bundled) {
        try {
            await execFileAsync(bundled, ["--version"], { timeout: 5000 });
            return bundled;
        }
        catch {
            // Bundled path set but not executable — fall through to search paths
        }
    }
    for (const p of PEEKABOO_SEARCH_PATHS) {
        try {
            await execFileAsync(p, ["--version"], { timeout: 5000 });
            return p;
        }
        catch {
            // not here
        }
    }
    try {
        const { stdout } = await execFileAsync("which", ["peekaboo"]);
        return stdout.trim() || null;
    }
    catch {
        return null;
    }
}
/** macOS permission error patterns from Peekaboo/osascript output */
const PERMISSION_PATTERNS = [
    {
        pattern: /PERMISSION_ERROR_ACCESSIBILITY|not allowed assistive access|accessibility.*not.*(enabled|permitted|required|granted)|requires? accessibility|assistive access|accessibility permission/i,
        fix: "macOS Accessibility permission required. Grant it to Tek Gateway in System Settings > Privacy & Security > Accessibility. If you configured an external peekaboo binary, grant that binary separately.",
    },
    {
        pattern: /PERMISSION_ERROR_SCREEN_RECORDING|screen recording.*(not.*permitted|required|needed|not.*granted)|screen capture.*(not|required)|screen recording permission/i,
        fix: "macOS Screen Recording permission required. Grant it to Tek Gateway in System Settings > Privacy & Security > Screen Recording. If you configured an external peekaboo binary, grant that binary separately.",
    },
    {
        pattern: /PERMISSION_ERROR_AUTOMATION|not authorized to send apple events|automation.*permission/i,
        fix: "macOS Automation permission required. Go to System Settings > Privacy & Security > Automation and grant access.",
    },
];
function detectPermissionError(text) {
    for (const { pattern, fix } of PERMISSION_PATTERNS) {
        if (pattern.test(text))
            return fix;
    }
    return null;
}
/**
 * Run a peekaboo command with JSON output. Returns parsed JSON or error object.
 * Detects macOS permission errors and returns actionable fix instructions.
 */
async function runPeekaboo(cli, args, timeout = DEFAULT_TIMEOUT) {
    try {
        const { stdout, stderr } = await execFileAsync(cli, [...args, "--json"], {
            timeout,
            maxBuffer: 50 * 1024 * 1024, // 50MB for screenshots with base64
            env: { ...process.env, PATH: process.env.PATH || "" },
        });
        if (stderr) {
            // Check stderr for permission errors before discarding
            const permFix = detectPermissionError(stderr);
            if (permFix) {
                return { error: true, permissionError: true, message: permFix, raw: stderr.trim() };
            }
        }
        try {
            const parsed = JSON.parse(stdout);
            // Check if peekaboo returned an error in JSON that's permission-related
            if (parsed.error && typeof parsed.message === "string") {
                const permFix = detectPermissionError(parsed.message);
                if (permFix) {
                    return { error: true, permissionError: true, message: permFix, raw: parsed.message };
                }
            }
            return parsed;
        }
        catch {
            return { result: stdout.trim() };
        }
    }
    catch (err) {
        const error = err;
        // Peekaboo writes structured errors as JSON on stdout even when it
        // exits non-zero. execFileAsync throws on non-zero exit, so without
        // reading err.stdout we'd discard the real error details. Parse it
        // first and return the structured payload (lets callers see e.g.
        // PERMISSION_ERROR_SCREEN_RECORDING instead of "Command failed ...").
        if (error.stdout) {
            try {
                const parsed = JSON.parse(error.stdout);
                const msgCandidate = typeof parsed.error?.message === "string"
                    ? (parsed.error.message)
                    : typeof parsed.message === "string"
                        ? parsed.message
                        : "";
                const permFix = msgCandidate ? detectPermissionError(msgCandidate) : null;
                if (permFix) {
                    return { error: true, permissionError: true, message: permFix, raw: msgCandidate };
                }
                return { ...parsed, error: true, exitCode: error.code };
            }
            catch {
                // stdout wasn't JSON — fall through to text-based handling
            }
        }
        const errText = error.stderr || error.stdout || error.message || String(err);
        // Detect permission errors in the exception text
        const permFix = detectPermissionError(errText);
        if (permFix) {
            return { error: true, permissionError: true, message: permFix, raw: errText };
        }
        // Detect timeout (likely a permission dialog blocked the process)
        if (error.killed || error.code === "ETIMEDOUT") {
            return {
                error: true,
                timedOut: true,
                message: `Command timed out after ${timeout / 1000}s. This may indicate a macOS permission dialog is blocking execution. Check System Settings > Privacy & Security for Accessibility and Screen Recording permissions.`,
            };
        }
        return {
            error: true,
            exitCode: error.code,
            message: errText,
        };
    }
}
export async function register(context) {
    // Only register on macOS
    if (process.platform !== "darwin") {
        context.logger.warn("Mac Control plugin only works on macOS, skipping tool registration");
        return;
    }
    const config = context.getConfig();
    const _screenshotMaxWidth = config.screenshotMaxWidth || 1920;
    // Resolve the snapshot directory (default: ~/.config/tek/mac-control/snapshots).
    // Empty string opts into peekaboo's default (which writes to the Desktop —
    // usually not what anyone wants).
    const configuredDir = typeof config.screenshotDir === "string" ? config.screenshotDir.trim() : "";
    const snapshotDir = configuredDir === ""
        ? DEFAULT_SNAPSHOT_DIR
        : resolve(expandHome(configuredDir));
    const retentionDays = typeof config.retentionDays === "number" ? config.retentionDays : DEFAULT_RETENTION_DAYS;
    // Create dir up-front so peekaboo doesn't fail on first write
    try {
        await mkdir(snapshotDir, { recursive: true });
    }
    catch (e) {
        context.logger.warn(`Failed to create screenshot dir ${snapshotDir}: ${e instanceof Error ? e.message : String(e)}. Peekaboo may fall back to your Desktop.`);
    }
    // Initial cleanup, then a rolling sweep every 6h while the plugin is loaded
    const runCleanup = async () => {
        try {
            const { deleted, scanned } = await cleanupOldSnapshots(snapshotDir, retentionDays);
            if (scanned > 0) {
                context.logger.info(`Cleaned up ${deleted} of ${scanned} snapshots older than ${retentionDays}d in ${snapshotDir}`);
            }
        }
        catch (e) {
            context.logger.warn(`Snapshot cleanup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    };
    await runCleanup();
    // Guard against double-register leaving a stray timer behind
    if (cleanupTimer)
        clearInterval(cleanupTimer);
    cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
    // Don't keep the event loop alive just for cleanup
    cleanupTimer.unref?.();
    // Check CLI availability
    const cliPath = await findPeekabooCli();
    if (!cliPath) {
        context.logger.warn("peekaboo CLI not found. Install it with: brew install steipete/tap/peekaboo");
    }
    else {
        context.logger.info(`peekaboo CLI found: ${cliPath}`);
    }
    context.logger.info(`Mac Control snapshot dir: ${snapshotDir} (retention: ${retentionDays}d, sweep every 6h)`);
    // Helper: get CLI or return error
    const getCli = async () => {
        return cliPath ?? (await findPeekabooCli());
    };
    const notInstalled = () => ({
        error: true,
        message: "peekaboo CLI is not installed. Install with: brew install steipete/tap/peekaboo",
    });
    context.addTool("mac__control_status", {
        description: "Read the user-owned, provider-neutral Mac automation lease and its Gateway enforcement boundary.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => ({ paused: false, boundary: "gateway-host-lease" }),
    });
    // ── mac__see ─────────────────────────────────────────────────────────
    context.addTool("mac__see", {
        description: "Capture the screen and discover UI elements with annotated IDs. " +
            "Returns a snapshot (with a snapshotId) + element map; pass snapshotId back to " +
            "mac__click/type/hotkey so those actions target the same captured state. " +
            "Use mode='screen' for a full-desktop capture, or supply an app name (or 'frontmost') " +
            "for a single-app capture.",
        parameters: {
            type: "object",
            properties: {
                app: {
                    type: "string",
                    description: 'Target app name (e.g. "Safari", "Finder") or "frontmost" for the active app. ' +
                        "Leave empty with mode='screen' to capture the whole desktop.",
                },
                mode: {
                    type: "string",
                    enum: ["screen", "window", "frontmost"],
                    description: "Capture mode: 'screen' = whole desktop (don't pass app), 'window' = targeted window, 'frontmost' = frontmost app",
                },
                windowTitle: {
                    type: "string",
                    description: "Capture a specific window by title (partial match)",
                },
            },
            required: [],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            // `see` is the see-then-act entry point in peekaboo 3.x — it captures
            // a snapshot and returns a UI element map with clickable IDs.
            // (`capture live` is a different subcommand: a long-running streaming
            // session — not what we want for a one-shot discovery call.)
            const cliArgs = ["see"];
            // mode=screen captures the whole desktop — don't also pass --app
            if (args.mode === "screen") {
                cliArgs.push("--mode", "screen");
            }
            else {
                if (args.app)
                    cliArgs.push("--app", args.app);
                if (args.mode)
                    cliArgs.push("--mode", args.mode);
            }
            if (args.windowTitle)
                cliArgs.push("--window-title", args.windowTitle);
            cliArgs.push("--path", snapshotDir);
            return runPeekaboo(cli, cliArgs, SCREENSHOT_TIMEOUT);
        },
    });
    // ── mac__click ───────────────────────────────────────────────────────
    context.addTool("mac__click", {
        description: "Click on a UI element by its ID (from mac__see), text label, or screen coordinates. " +
            "Pass snapshotId from the mac__see call to avoid hitting stale/wrong app elements. " +
            "Supports single, double, and right-click.",
        parameters: {
            type: "object",
            properties: {
                elementId: {
                    type: "string",
                    description: "Element ID from mac__see output (e.g. B1, T2, S3)",
                },
                query: {
                    type: "string",
                    description: "Text label to search for and click (e.g. 'Save', 'OK')",
                },
                coords: {
                    type: "string",
                    description: "Screen coordinates as 'x,y' (e.g. '500,300')",
                },
                action: {
                    type: "string",
                    enum: ["single", "double", "right"],
                    description: "Click type (default: single)",
                },
                app: {
                    type: "string",
                    description: "Target app for the click — strongly recommended when switching between apps to scope the action correctly",
                },
                snapshotId: {
                    type: "string",
                    description: "Snapshot ID from a recent mac__see call. Ensures this click targets elements from that exact capture, not whatever's most-recent.",
                },
            },
            required: [],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            const cliArgs = ["click"];
            if (args.query)
                cliArgs.push(args.query);
            if (args.elementId)
                cliArgs.push("--on", args.elementId);
            if (args.coords)
                cliArgs.push("--coords", args.coords);
            if (args.action === "double")
                cliArgs.push("--double");
            if (args.action === "right")
                cliArgs.push("--right");
            if (args.app)
                cliArgs.push("--app", args.app);
            if (args.snapshotId)
                cliArgs.push("--snapshot", args.snapshotId);
            return runPeekaboo(cli, cliArgs);
        },
    });
    // ── mac__type ────────────────────────────────────────────────────────
    context.addTool("mac__type", {
        description: "Type text into the focused element. For cross-app workflows, pass `app` and/or " +
            "`snapshotId` so peekaboo targets the correct window instead of the most-recently-captured one.",
        parameters: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    description: "Text to type",
                },
                app: {
                    type: "string",
                    description: "Target app name — peekaboo will focus it before typing",
                },
                snapshotId: {
                    type: "string",
                    description: "Snapshot ID from a recent mac__see call — scopes the type to that capture's context",
                },
            },
            required: ["text"],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            const cliArgs = ["type", args.text];
            if (args.app)
                cliArgs.push("--app", args.app);
            if (args.snapshotId)
                cliArgs.push("--snapshot", args.snapshotId);
            return runPeekaboo(cli, cliArgs);
        },
    });
    // ── mac__hotkey ──────────────────────────────────────────────────────
    context.addTool("mac__hotkey", {
        description: "Press keyboard shortcuts and key combinations. " +
            "Examples: 'cmd+c' (copy), 'cmd+v' (paste), 'cmd+shift+4' (screenshot), 'cmd+tab' (switch app). " +
            "Pass `app` to route the shortcut to a specific app, or `snapshotId` for see-then-act scoping.",
        parameters: {
            type: "object",
            properties: {
                keys: {
                    type: "string",
                    description: "Key combo string (e.g. 'cmd+c', 'cmd+shift+s', 'ctrl+alt+delete')",
                },
                app: {
                    type: "string",
                    description: "Target app for the hotkey",
                },
                snapshotId: {
                    type: "string",
                    description: "Snapshot ID from a recent mac__see call",
                },
            },
            required: ["keys"],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            // Peekaboo expects comma-separated keys (`cmd,c`), not plus-separated
            // (`cmd+c`). Accept either form from the caller and normalize.
            const normalized = args.keys.trim().replace(/\s*\+\s*/g, ",");
            // Use explicit --keys flag form (more robust than positional, which
            // ambiguously splits on spaces in some peekaboo versions).
            const cliArgs = ["hotkey", "--keys", normalized];
            if (args.app)
                cliArgs.push("--app", args.app);
            if (args.snapshotId)
                cliArgs.push("--snapshot", args.snapshotId);
            return runPeekaboo(cli, cliArgs);
        },
    });
    // ── mac__screenshot ──────────────────────────────────────────────────
    context.addTool("mac__screenshot", {
        description: "Take a screenshot of the screen, a specific window, or app. " +
            "Returns the image for the active Tek model to inspect; no separate vision subscription is required.",
        parameters: {
            type: "object",
            properties: {
                app: {
                    type: "string",
                    description: 'Target app to screenshot (or "frontmost")',
                },
                mode: {
                    type: "string",
                    enum: ["screen", "window", "frontmost"],
                    description: "Capture mode (default: screen)",
                },
                path: {
                    type: "string",
                    description: "Save screenshot to this file path instead of returning base64",
                },
            },
            required: [],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            const cliArgs = ["image"];
            // mode=screen captures the full desktop and must NOT have --app set
            // (peekaboo errors or silently falls back otherwise). Only pass --app
            // for window/frontmost modes, or when mode is unset and the caller
            // named an app.
            if (args.mode === "screen") {
                cliArgs.push("--mode", "screen");
            }
            else {
                if (args.app)
                    cliArgs.push("--app", args.app);
                if (args.mode)
                    cliArgs.push("--mode", args.mode);
            }
            if (args.path) {
                cliArgs.push("--path", args.path);
            }
            else {
                // Default output to the configured snapshot dir so peekaboo
                // doesn't litter the user's Desktop.
                cliArgs.push("--path", snapshotDir);
                cliArgs.push("--format", "png");
            }
            return runPeekaboo(cli, cliArgs, SCREENSHOT_TIMEOUT);
        },
    });
    // ── mac__open_app ────────────────────────────────────────────────────
    context.addTool("mac__open_app", {
        description: "Launch, focus, quit, or hide an application.",
        parameters: {
            type: "object",
            properties: {
                name: {
                    type: "string",
                    description: 'App name (e.g. "Safari", "Terminal", "Finder")',
                },
                action: {
                    type: "string",
                    enum: ["launch", "focus", "quit", "hide", "unhide"],
                    description: "What to do with the app (default: launch)",
                },
            },
            required: ["name"],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            const action = args.action || "launch";
            // Peekaboo's `app` command takes a verb subcommand (launch/quit/hide/
            // unhide/switch) followed by the app name — NOT an --action flag.
            if (action === "focus" || action === "switch") {
                // `app focus` doesn't exist; focus is done via `app switch --to <name>`
                return runPeekaboo(cli, ["app", "switch", "--to", args.name]);
            }
            if (action === "launch") {
                // `app launch` fails for always-running apps like Finder. Try
                // launch first; if it returns an error, fall back to `switch --to`
                // which brings an already-running app to the front.
                const launchResult = await runPeekaboo(cli, ["app", "launch", args.name]);
                if (launchResult && launchResult.error) {
                    const fallback = await runPeekaboo(cli, ["app", "switch", "--to", args.name]);
                    if (fallback && !fallback.error) {
                        return { ...fallback, note: `${args.name} was already running — focused it instead` };
                    }
                    return launchResult;
                }
                return launchResult;
            }
            // quit, hide, unhide all take --app <name>
            return runPeekaboo(cli, ["app", action, "--app", args.name]);
        },
    });
    // ── mac__window ─────────────────────────────────────────────────────
    context.addTool("mac__window", {
        description: "Manage application windows. " +
            "For 'list': if `app` is omitted, lists all running apps (pick one, then call again with that app to see its windows). " +
            "For 'focus/move/resize/close/minimize': `app` is required.",
        parameters: {
            type: "object",
            properties: {
                action: {
                    type: "string",
                    enum: ["list", "focus", "move", "resize", "close", "minimize", "maximize"],
                    description: "Window action (default: list)",
                },
                app: {
                    type: "string",
                    description: "Target app name. Required for all actions except 'list' (where omitting it lists all running apps instead).",
                },
                title: {
                    type: "string",
                    description: "Window title to target (partial match supported)",
                },
                x: { type: "number", description: "X position (for move)" },
                y: { type: "number", description: "Y position (for move)" },
                width: { type: "number", description: "Width (for resize)" },
                height: { type: "number", description: "Height (for resize)" },
            },
            required: [],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            const action = args.action || "list";
            if (action === "list") {
                // peekaboo requires --app for `list windows`. If caller didn't
                // supply one, fall back to listing all apps so they can pick.
                if (!args.app) {
                    return runPeekaboo(cli, ["list", "apps"]);
                }
                return runPeekaboo(cli, ["list", "windows", "--app", args.app]);
            }
            if (!args.app && !args.title) {
                return {
                    error: true,
                    message: `mac__window action '${action}' requires at least 'app' or 'title'. Call mac__window with action='list' first to see available apps/windows.`,
                };
            }
            // Window manipulation: `peekaboo window <verb> --app X [--window-title Y]`
            // Only move accepts -x/-y; only resize accepts --width/--height.
            // Passing them for other actions (focus/close/minimize/maximize)
            // causes peekaboo to error with "Unknown option --x".
            const cliArgs = ["window", action];
            if (args.app)
                cliArgs.push("--app", args.app);
            if (args.title)
                cliArgs.push("--window-title", args.title);
            if (action === "move") {
                if (args.x !== undefined)
                    cliArgs.push("--x", String(args.x));
                if (args.y !== undefined)
                    cliArgs.push("--y", String(args.y));
            }
            if (action === "resize") {
                if (args.width !== undefined)
                    cliArgs.push("--width", String(args.width));
                if (args.height !== undefined)
                    cliArgs.push("--height", String(args.height));
            }
            return runPeekaboo(cli, cliArgs);
        },
    });
    // ── mac__system_info ─────────────────────────────────────────────────
    context.addTool("mac__system_info", {
        description: "Get system information: running applications, windows, screens, and permissions status.",
        parameters: {
            type: "object",
            properties: {
                item: {
                    type: "string",
                    enum: ["apps", "windows", "screens", "permissions"],
                    description: "What to list (default: apps)",
                },
            },
            required: [],
        },
        execute: async (args) => {
            const cli = await getCli();
            if (!cli)
                return notInstalled();
            const item = args.item || "apps";
            if (item === "permissions") {
                return runPeekaboo(cli, ["permissions", "status"]);
            }
            if (item === "screens") {
                return runPeekaboo(cli, ["list", "screens"]);
            }
            if (item === "windows") {
                // `list windows` requires --app in peekaboo 3.x. Use mac__window
                // with a specific app to enumerate its windows; from here we
                // fall through to listing apps so callers see their options.
                return {
                    ...(await runPeekaboo(cli, ["list", "apps"])),
                    note: "Listing apps (peekaboo requires --app for windows listing). Use mac__window(action='list', app='...') to see a specific app's windows.",
                };
            }
            return runPeekaboo(cli, ["list", "apps"]);
        },
    });
    // Add context section so agents know about Mac control
    context.addContextSection("Mac Control", [
        "Mac control tools: mac__control_status, mac__see, mac__click, mac__type, mac__hotkey, mac__screenshot, mac__open_app, mac__window, mac__system_info.",
        "All actions share the desktop-owned Gateway host lease; changing models or providers cannot bypass Take Over.",
        "",
        "See-then-act pattern:",
        "  1. mac__see { app: 'Safari' } → returns snapshot + UI element map. Capture the returned snapshotId.",
        "  2. mac__click / mac__type / mac__hotkey — ALWAYS pass the snapshotId from the most recent mac__see for that app.",
        "     This prevents the 'latest snapshot' from being a different app and your action hitting the wrong place.",
        "",
        "Scope:",
        "  - mac__see { mode: 'screen' } → capture the WHOLE desktop (dock, menu bar, all windows). No app needed.",
        "  - mac__see { app: 'Foo' } → single-app UI map, best for interacting inside that app.",
        "  - mac__see { app: 'frontmost' } → whatever's currently foregrounded.",
        "",
        "Full screenshot: mac__screenshot { mode: 'screen' } for whole desktop; mac__screenshot { app: 'Chrome' } for an app.",
        "Hotkeys: use 'cmd+c' style (plus-sign) — the plugin converts to peekaboo's comma format. Pass app+snapshotId for reliability.",
        "App launch: mac__open_app auto-falls-back to switch-to if launch fails (for always-running apps like Finder).",
    ].join("\n"));
    context.logger.info(`Mac Control plugin registered (peekaboo: ${cliPath ?? "not found"})`);
}
export async function cleanup() {
    if (cleanupTimer) {
        clearInterval(cleanupTimer);
        cleanupTimer = null;
    }
}
export default { register, cleanup };
