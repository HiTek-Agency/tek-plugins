import { test } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_CONTROL_POLICY,
	grantTab,
	isTabAllowed,
	normalizeControlPolicy,
	revokeTab,
	setControlPaused,
} from "../extension/control-policy.js";

test("defaults to paused with no granted tabs", () => {
	assert.deepEqual(normalizeControlPolicy(null), DEFAULT_CONTROL_POLICY);
});

test("normalizes and de-duplicates tab ids", () => {
	assert.deepEqual(normalizeControlPolicy({ paused: false, allowedTabIds: [4, 4, -1, "5"] }), {
		paused: false,
		allowedTabIds: [4],
	});
});

test("granting a tab resumes control without disturbing existing grants", () => {
	const next = grantTab({ paused: true, allowedTabIds: [2] }, 7);
	assert.deepEqual(next, { paused: false, allowedTabIds: [2, 7] });
	assert.equal(isTabAllowed(next, 7), true);
});

test("revoking and pausing preserve the remaining lease", () => {
	const revoked = revokeTab({ paused: false, allowedTabIds: [2, 7] }, 2);
	assert.deepEqual(revoked, { paused: false, allowedTabIds: [7] });
	assert.deepEqual(setControlPaused(revoked, true), { paused: true, allowedTabIds: [7] });
});
