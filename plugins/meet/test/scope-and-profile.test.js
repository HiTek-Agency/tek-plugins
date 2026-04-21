import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Repo root is 3 levels up from test dir: test -> meet -> plugins -> tek-plugins
// Then tek/ sibling: tek-plugins/../tek/packages/gateway/src/...
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const GATEWAY_SRC = join(REPO_ROOT, "tek", "packages", "gateway", "src");

function hasGatewayFile(rel) {
	return existsSync(join(GATEWAY_SRC, rel));
}

function readGateway(rel) {
	return readFileSync(join(GATEWAY_SRC, rel), "utf8");
}

test(
	"gateway google-oauth-flow.ts includes meetings.space.readonly scope",
	{ skip: !hasGatewayFile("google/google-oauth-flow.ts") },
	() => {
		const src = readGateway("google/google-oauth-flow.ts");
		assert.match(src, /meetings\.space\.readonly/);
		assert.match(src, /meet:\s*"off"\s*\|\s*"read"/);
	},
);

test(
	"gateway tool-profiles.ts has meet group and excludes it from local",
	{ skip: !hasGatewayFile("agent/tool-profiles.ts") },
	() => {
		const src = readGateway("agent/tool-profiles.ts");
		assert.match(src, /meet__join_observer/);
		assert.match(src, /meet__join_participant/);
		const localMatch = src.match(/local:\s*\[([\s\S]*?)\]/);
		assert.ok(localMatch, "local profile not found");
		assert.doesNotMatch(localMatch[1], /"meet"/);
	},
);

test(
	"gateway manual.ts has google-meet topic with session/always asymmetry",
	{ skip: !hasGatewayFile("tools/manual.ts") },
	() => {
		const src = readGateway("tools/manual.ts");
		assert.match(src, /"google-meet":/);
		assert.match(src, /meet__join_observer/);
		assert.match(src, /observer = session approval/);
	},
);
