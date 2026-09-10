#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const registry = JSON.parse(readFileSync(join(root, "registry.json"), "utf8"));
const entries = registry.plugins.filter((plugin) => plugin.source?.path);
const listedPaths = new Set();
const ids = new Set();
for (const entry of registry.plugins) {
	if (typeof entry.id !== "string" || ids.has(entry.id)) throw new Error(`Duplicate or missing plugin ID: ${entry.id}`);
	ids.add(entry.id);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

for (const entry of entries) {
	const pluginDir = resolve(root, entry.source.path);
	if (!relative(join(root, "plugins"), pluginDir) || relative(join(root, "plugins"), pluginDir).startsWith("..")) {
		throw new Error(`${entry.id}: source path must be inside plugins/`);
	}
	const manifestPath = join(pluginDir, "plugin.json");
	const packagePath = join(pluginDir, "package.json");
	if (!existsSync(manifestPath) || !existsSync(packagePath)) {
		throw new Error(`${entry.id}: source path must contain plugin.json and package.json`);
	}
	const manifest = readJson(manifestPath);
	const packageJson = readJson(packagePath);
	listedPaths.add(relative(root, pluginDir));
	for (const [label, actual] of [
		["id", manifest.id],
		["manifest version", manifest.version],
		["package version", packageJson.version],
	]) {
		if (actual !== (label === "id" ? entry.id : entry.version)) {
			throw new Error(`${entry.id}: registry ${label} does not match (${actual})`);
		}
	}
	if (JSON.stringify([...(manifest.permissions ?? [])].sort()) !== JSON.stringify([...(entry.permissions ?? [])].sort())) {
		throw new Error(`${entry.id}: registry permissions do not match the manifest`);
	}
	const entryPoint = manifest.entryPoint ?? "dist/index.js";
	const entryPath = resolve(pluginDir, entryPoint);
	if (relative(pluginDir, entryPath).startsWith("..") || !existsSync(entryPath)) {
		throw new Error(`${entry.id}: missing or external entry point ${entryPoint}`);
	}
	const extensionPath = join(pluginDir, "extension", "manifest.json");
	if (existsSync(extensionPath) && readJson(extensionPath).version !== manifest.version) {
		throw new Error(`${entry.id}: extension version does not match the plugin`);
	}
}

for (const dir of readdirSync(join(root, "plugins"), { withFileTypes: true })) {
	if (!dir.isDirectory()) continue;
	const path = `plugins/${dir.name}`;
	if (existsSync(join(root, path, "plugin.json")) && !listedPaths.has(path)) {
		throw new Error(`${path}: plugin manifest is missing from registry.json`);
	}
}

console.log(`Registry is consistent: ${entries.length} source plugins checked.`);
