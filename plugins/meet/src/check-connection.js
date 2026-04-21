/**
 * Pure connection-check logic — exported for unit testing without a live WS server.
 * Enforces loopback origin + URL-query token equality. Mirrors the chrome plugin's
 * checkConnection() shape exactly (plans 104-02, phase 101 pattern).
 */

export function isLoopback(addr) {
	return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Returns { ok: true } on accept, { ok: false, code, reason } on reject.
 * 403 = non-loopback, 401 = missing/wrong token.
 */
export function checkConnection(remoteAddress, urlString, expectedToken) {
	if (!isLoopback(remoteAddress)) {
		return { ok: false, code: 403, reason: "non-loopback" };
	}
	let token = null;
	try {
		const u = new URL(urlString, "http://127.0.0.1");
		token = u.searchParams.get("token");
	} catch {
		// fall through — token stays null
	}
	if (!token || token !== expectedToken) {
		return { ok: false, code: 401, reason: "unauthorized" };
	}
	return { ok: true };
}
