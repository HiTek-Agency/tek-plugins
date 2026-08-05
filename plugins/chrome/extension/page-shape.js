/**
 * Shape normalized accessibility nodes into bounded, model-friendly page state.
 *
 * `interactive` is the safe default for ordinary reads/actions. `full` keeps
 * every normalized node available, but only one deterministic page at a time.
 * This preserves deep browser control without feeding the whole document back
 * after every click.
 */

export const PAGE_STATE_MODES = ["summary", "interactive", "full", "none"];

const INTERACTIVE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"dialog",
	"link",
	"listbox",
	"menu",
	"menuitem",
	"option",
	"radio",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem",
]);

const SUMMARY_ROLES = new Set([
	...INTERACTIVE_ROLES,
	"alert",
	"heading",
	"main",
	"navigation",
	"status",
]);

const LIMITS = {
	summary: { nodes: 40, bytes: 8 * 1024, textChars: 6_000 },
	interactive: { nodes: 140, bytes: 24 * 1024, textChars: 8_000 },
	full: { nodes: 240, bytes: 32 * 1024, textChars: 8_000 },
};

function positiveInt(value, fallback, max) {
	const n = Number(value);
	if (!Number.isFinite(n) || n < 1) return fallback;
	return Math.min(Math.floor(n), max);
}

export function resolvePageMode(args = {}, fallback = "interactive") {
	if (args.returnPage === false || args.pageMode === "none" || args.mode === "none") {
		return "none";
	}
	const requested = args.pageMode ?? args.mode;
	if (PAGE_STATE_MODES.includes(requested)) return requested;
	// Backwards compatibility: legacy returnPage:true now means a compact
	// interactive snapshot, never the former complete-tree payload.
	return fallback;
}

function boundNodeStrings(node, maxBytes) {
	const maxStringChars = Math.max(128, Math.floor(maxBytes / 8));
	let truncated = false;
	const bounded = Object.fromEntries(
		Object.entries(node).map(([key, value]) => {
			if (typeof value !== "string" || value.length <= maxStringChars) return [key, value];
			truncated = true;
			return [key, `${value.slice(0, maxStringChars - 1)}…`];
		}),
	);
	return { node: bounded, truncated };
}

function paginateNodes(nodes, maxNodes, maxBytes) {
	const pages = [];
	let current = [];
	let bytes = 2; // []
	let contentTruncated = false;

	for (const rawNode of nodes) {
		const bounded = boundNodeStrings(rawNode, maxBytes);
		contentTruncated ||= bounded.truncated;
		const nodeBytes = JSON.stringify(bounded.node).length + (current.length > 0 ? 1 : 0);
		if (current.length > 0 && (current.length >= maxNodes || bytes + nodeBytes > maxBytes)) {
			pages.push(current);
			current = [];
			bytes = 2;
		}
		current.push(bounded.node);
		bytes += JSON.stringify(bounded.node).length + (current.length > 1 ? 1 : 0);
	}
	if (current.length > 0) pages.push(current);
	if (pages.length === 0) pages.push([]);
	return { pages, contentTruncated };
}

export function shapePageState(
	nodes,
	text = "",
	{ mode = "interactive", page = 1, pageSize } = {},
) {
	const resolvedMode = PAGE_STATE_MODES.includes(mode) ? mode : "interactive";
	if (resolvedMode === "none") return null;
	const limits = LIMITS[resolvedMode];
	const candidates =
		resolvedMode === "full"
			? nodes
			: nodes.filter((node) => {
					const role = String(node.role ?? "");
					const name = String(node.name ?? "").trim();
					const roles = resolvedMode === "summary" ? SUMMARY_ROLES : INTERACTIVE_ROLES;
					return roles.has(role) && (name.length > 0 || role === "textbox");
				});
	const effectivePageSize = positiveInt(pageSize, limits.nodes, 500);
	const nodePagination = paginateNodes(candidates, effectivePageSize, limits.bytes);
	const nodeTotalPages = nodePagination.pages.length;
	const cleanText = String(text).replace(/\s+\n/g, "\n").trim();
	const textTotalPages = Math.max(1, Math.ceil(cleanText.length / limits.textChars));
	const totalPages = Math.max(nodeTotalPages, textTotalPages);
	const effectivePage = Math.min(positiveInt(page, 1, totalPages), totalPages);
	const axTree = nodePagination.pages[effectivePage - 1] ?? [];

	const textStart = (effectivePage - 1) * limits.textChars;
	const textSlice = cleanText.slice(textStart, textStart + limits.textChars);
	const hasMore = effectivePage < totalPages;

	return {
		mode: resolvedMode,
		text: textSlice,
		axTree,
		page: effectivePage,
		totalPages,
		hasMore,
		...(hasMore ? { nextPage: effectivePage + 1 } : {}),
		truncated:
			nodePagination.contentTruncated || candidates.length < nodes.length || hasMore,
		totalNodes: nodes.length,
		matchingNodes: candidates.length,
		textChars: cleanText.length,
	};
}
