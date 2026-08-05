/**
 * Tek Chrome Control — Accessibility-tree pruning.
 *
 * Pure function extracted for unit testability. Drops nodes with neither a
 * meaningful role (generic/none excluded) nor a non-empty name, then trims
 * the surviving list until the JSON serialization fits under MAX_AX_BYTES
 * (100 KB). Returns { axTree, truncated, totalNodes }.
 */

export const MAX_AX_BYTES = 100 * 1024; // 100 KB

export function pruneAxTree(nodes, { maxBytes = MAX_AX_BYTES } = {}) {
	const kept = nodes
		.filter((n) => {
			const role = n.role?.value;
			const name = n.name?.value;
			const hasRole = role && role !== "generic" && role !== "none";
			const hasName = name && String(name).trim().length > 0;
			return hasRole || hasName;
		})
		.map((n) => ({
			axNodeId: n.nodeId,
			backendDOMNodeId: n.backendDOMNodeId,
			role: n.role?.value,
			name: n.name?.value,
			description: n.description?.value,
			parentId: n.parentId,
		}));
	if (!Number.isFinite(maxBytes)) {
		return { axTree: kept, truncated: false, totalNodes: kept.length };
	}

	let subset = kept;
	let serialized = JSON.stringify(subset);
	let truncated = false;
	while (serialized.length > maxBytes && subset.length > 1) {
		truncated = true;
		subset = subset.slice(0, Math.floor(subset.length * 0.7));
		serialized = JSON.stringify(subset);
	}
	return { axTree: subset, truncated, totalNodes: kept.length };
}
