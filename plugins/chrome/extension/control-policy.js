/**
 * Provider-neutral user control lease for Chrome. The extension owns this
 * policy; gateways and models may observe it but cannot grant themselves tabs
 * or resume control.
 */

export const DEFAULT_CONTROL_POLICY = Object.freeze({
	paused: true,
	allowedTabIds: [],
});

export function normalizeControlPolicy(value) {
	const ids = Array.isArray(value?.allowedTabIds)
		? [...new Set(value.allowedTabIds.filter((id) => Number.isInteger(id) && id >= 0))]
		: [];
	return {
		paused: typeof value?.paused === "boolean" ? value.paused : true,
		allowedTabIds: ids,
	};
}

export function isTabAllowed(policy, tabId) {
	return Number.isInteger(tabId) && normalizeControlPolicy(policy).allowedTabIds.includes(tabId);
}

export function grantTab(policy, tabId) {
	const next = normalizeControlPolicy(policy);
	if (!Number.isInteger(tabId) || tabId < 0) return next;
	return {
		paused: false,
		allowedTabIds: [...new Set([...next.allowedTabIds, tabId])],
	};
}

export function revokeTab(policy, tabId) {
	const next = normalizeControlPolicy(policy);
	return {
		...next,
		allowedTabIds: next.allowedTabIds.filter((id) => id !== tabId),
	};
}

export function setControlPaused(policy, paused) {
	return { ...normalizeControlPolicy(policy), paused: paused === true };
}
