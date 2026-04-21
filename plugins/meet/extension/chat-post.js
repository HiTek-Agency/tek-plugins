/**
 * Tek Meet — CDP command sequence builder for in-call chat post (Plan 104-04).
 *
 * Google Meet has NO REST API for sending chat messages (verified in
 * RESEARCH §2.3 / §MEET-10). The only path is DOM automation. We use
 * chrome.debugger + CDP to:
 *   1. Click the chat-open button
 *   2. Wait for the chat panel to mount
 *   3. Focus the chat textarea
 *   4. Wait for the focus to settle
 *   5. Insert the text via Input.insertText (bypasses IME + keyboard-event races)
 *   6. Dispatch Enter keyDown
 *   7. Dispatch Enter keyUp
 *
 * Meet's DOM is brittle (Google ships UI updates silently), so both the
 * chat-button and chat-input selectors are priority lists tried in order —
 * first match wins. If NO selector matches, the Runtime.evaluate expression
 * returns null and the SW can log a warning; the insert + Enter will no-op
 * against an unfocused page.
 *
 * buildChatPostCommands() returns a plain JS array of {method, params} —
 * pure, side-effect-free, easy to unit test. The SW iterates the array,
 * handling `_wait` commands as setTimeout and everything else via
 * chrome.debugger.sendCommand.
 *
 * buildTransparencyText() composes the D-18 locked announcement:
 *   "Tek assistant is attending on behalf of <user>. I'm recording a local
 *    transcript for note-taking."
 * <user> is the bot's sign-in display name (or a configured override). This
 * wording is NON-NEGOTIABLE per CONTEXT D-18 — the plan's acceptance criteria
 * greps for the literal "Tek assistant is attending on behalf of" prefix.
 */

const CHAT_BUTTON_SELECTORS = [
	'button[aria-label*="Chat with everyone" i]',
	'button[aria-label*="Open chat" i]',
	'button[aria-label*="Show chat" i]',
];

const CHAT_INPUT_SELECTORS = [
	'textarea[aria-label*="Send a message" i]',
	'textarea[aria-label*="message" i]',
	'textarea[placeholder*="Send a message" i]',
];

const POST_CLICK_WAIT_MS = 500;
const POST_FOCUS_WAIT_MS = 100;

/**
 * Compose the exact D-18 transparency message. The wording is locked —
 * change only with an explicit user decision.
 *
 * @param {string|null|undefined} userName
 * @returns {string}
 */
export function buildTransparencyText(userName) {
	const name = typeof userName === "string" && userName.length > 0 ? userName : "Tek user";
	return `Tek assistant is attending on behalf of ${name}. I'm recording a local transcript for note-taking.`;
}

/**
 * Compose the ordered CDP command list to post `text` in Meet's in-call chat.
 * @param {string} text
 * @returns {Array<{method: string, params: object}>}
 */
export function buildChatPostCommands(text) {
	// Embed the selector lists literally in the Runtime.evaluate expressions
	// so the command list is fully self-contained (SW doesn't need to bind
	// anything when it plays the sequence back).
	const buttonSelsList = CHAT_BUTTON_SELECTORS.map((s) => JSON.stringify(s)).join(", ");
	const inputSelsList = CHAT_INPUT_SELECTORS.map((s) => JSON.stringify(s)).join(", ");

	return [
		{
			method: "Runtime.evaluate",
			params: {
				expression: `(() => { const sels = [${buttonSelsList}]; for (const s of sels) { const b = document.querySelector(s); if (b) { b.click(); return s; } } return null; })()`,
				returnByValue: true,
			},
		},
		{ method: "_wait", params: { ms: POST_CLICK_WAIT_MS } },
		{
			method: "Runtime.evaluate",
			params: {
				expression: `(() => { const sels = [${inputSelsList}]; for (const s of sels) { const t = document.querySelector(s); if (t) { t.focus(); return s; } } return null; })()`,
				returnByValue: true,
			},
		},
		{ method: "_wait", params: { ms: POST_FOCUS_WAIT_MS } },
		{ method: "Input.insertText", params: { text } },
		{
			method: "Input.dispatchKeyEvent",
			params: {
				type: "keyDown",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
			},
		},
		{
			method: "Input.dispatchKeyEvent",
			params: {
				type: "keyUp",
				key: "Enter",
				code: "Enter",
				windowsVirtualKeyCode: 13,
				nativeVirtualKeyCode: 13,
			},
		},
	];
}
