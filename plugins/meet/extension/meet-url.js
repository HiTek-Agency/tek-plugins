/** Return true only for a canonical HTTPS Google Meet room URL. */
export function isMeetUrl(value) {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "meet.google.com" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			/^\/[a-z0-9]+(?:-[a-z0-9]+)+\/?$/i.test(url.pathname)
		);
	} catch {
		return false;
	}
}
