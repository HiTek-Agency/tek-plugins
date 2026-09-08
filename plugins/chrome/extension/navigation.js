/** Complete within the gateway's 30s RPC budget, including tab-close failures. */
export async function navigateTab(tabs, tabId, url, timeoutMs = 25_000) {
	let resolveLoad, rejectLoad;
	const loaded = new Promise((resolve, reject) => {
		resolveLoad = resolve;
		rejectLoad = reject;
	});
	let updated = false;
	const onUpdated = (id, info, tab) => {
		if (id === tabId && updated && info.status === "complete") resolveLoad(tab);
	};
	const onRemoved = (id) => {
		if (id === tabId) rejectLoad(new Error(`Chrome tab ${tabId} was closed during navigation`));
	};
	tabs.onUpdated.addListener(onUpdated);
	tabs.onRemoved.addListener(onRemoved);
	const timer = setTimeout(() => rejectLoad(new Error("Chrome navigation timed out")), timeoutMs);
	try {
		return await Promise.race([
			loaded,
			(async () => {
				await tabs.update(tabId, { url });
				updated = true;
				// Fast/cached and same-document loads may finish before update
				// resolves. Inspect status with listeners already installed.
				const tab = await tabs.get(tabId);
				if (tab.status === "complete") resolveLoad(tab);
				return loaded;
			})(),
		]);
	} finally {
		clearTimeout(timer);
		tabs.onUpdated.removeListener(onUpdated);
		tabs.onRemoved.removeListener(onRemoved);
	}
}
