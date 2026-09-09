/** Open only the fixed Google sign-in page in this extension's Chrome profile.
 * No existing tab is selected, navigated, or closed. Account choice stays in Chrome.
 */
export async function openBotSignin(args, chromeApi) {
	if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0)) {
		throw new Error("meet.open-signin: no arguments accepted");
	}
	let tab;
	try {
		tab = await chromeApi.tabs.create({ url: "https://accounts.google.com/signin", active: true });
	} catch {
		throw new Error("meet.open-signin: could not open the Google sign-in tab");
	}
	if (!Number.isInteger(tab?.id) || tab.id < 0) {
		throw new Error("meet.open-signin: new tab could not be confirmed");
	}
	return { ok: true, tabId: tab.id };
}
