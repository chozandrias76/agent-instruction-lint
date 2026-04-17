import { readFile } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import {
	isLocalMarkdownLink,
	type MarkdownHeading,
	type MarkdownRange,
	readMarkdownLinks,
	readMarkdownPathReferences,
	readMarkdownStructure,
	resolveMarkdownLink,
} from "../markdown.js";
import type { AgentInstructionLintConfig, Finding } from "../types.js";

interface Claim {
	filePath: string;
	line: number;
	text: string;
	hasLocalPrecedenceMarker: boolean;
	scopeTokens: string[];
}

interface Edge {
	source: string;
	target: string;
	line: number;
	text: string;
	scopeTokens: string[];
}

const AUTHORITY_MARKER =
	/\b(?:canonical|authoritative|entrypoint|execution root|root file|remains authoritative|start with)\b/i;
const BOOTSTRAP_MARKER =
	/\b(?:first grounding read|first required read|must be the grounding read|the grounding read|start with)\b/i;
const PRECEDENCE_MARKER =
	/\b(?:fallback|only as a fallback|supplement|override|remains binding|wins on conflict|root file wins|first match wins|takes precedence)\b/i;
const CONFLICTING_PRECEDENCE_MARKER =
	/\b(?:wins on conflict|root file wins|first match wins|remains binding|takes precedence|override)\b/i;
const READ_CHAIN_MARKER = /\b(?:read|load|follow|start with)\b/i;
const NORMATIVE_LINE_MARKER =
	/\b(?:must(?: not)?|never|always|only|required|forbidden|canonical|exact|hard block|do not|read|load|start with|follow|use|keep)\b/i;
const SCOPE_TOKEN_PATTERNS: Array<{ token: string; pattern: RegExp }> = [
	{ token: "codex", pattern: /\bcodex\b/i },
	{ token: "zeph", pattern: /\bzeph\b/i },
	{ token: "mux", pattern: /\bmux\b/i },
	{ token: "openai", pattern: /\bopenai\b/i },
	{ token: "claude", pattern: /\bclaude\b/i },
	{ token: "ollama", pattern: /\bollama\b/i },
	{ token: "compatible", pattern: /\bcompatible\b/i },
	{ token: "candle", pattern: /\bcandle\b/i },
	{ token: "global", pattern: /\bglobal\b|\bhome directory\b|~\//i },
	{ token: "workspace", pattern: /\bworkspace\b/i },
	{
		token: "project",
		pattern: /\bproject\b|\brepo(?:sitory)?\b|\bcwd\b|\bcurrent directory\b/i,
	},
	{ token: "tui", pattern: /\btui\b/i },
	{ token: "cli", pattern: /\bcli\b|\bcommand\b/i },
];

export async function runTopo001(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<Finding[]> {
	const files = await collectFiles(repoRoot, [
		...(config.roles?.rootControllers ?? []),
		...(config.roles?.scopedControllers ?? []),
	]);
	const claims = await collectClaims(repoRoot, files, AUTHORITY_MARKER);
	return buildPairwiseFindings(
		"TOPO001",
		claims,
		(left, right) => ({
			filePath: left.filePath,
			line: left.line,
			message:
				"Multiple controller files claim canonical/root authority without an explicit precedence relation",
			evidence: `${left.filePath}:${left.line} ${left.text} | ${right.filePath}:${right.line} ${right.text}`,
			suggestion:
				"Add an explicit precedence/supplement rule or narrow one file's authority claim.",
		}),
		{ requireScopeOverlap: true },
	);
}

export async function runTopo002(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<Finding[]> {
	const files = await collectFiles(repoRoot, [
		...(config.roles?.rootControllers ?? []),
		...(config.roles?.scopedControllers ?? []),
	]);
	const claims = await collectClaims(
		repoRoot,
		files,
		CONFLICTING_PRECEDENCE_MARKER,
	);
	return buildPairwiseFindings(
		"TOPO002",
		claims,
		(left, right) => ({
			filePath: left.filePath,
			line: left.line,
			message:
				"Multiple controller files define precedence or conflict-winning semantics for the same scope",
			evidence: `${left.filePath}:${left.line} ${left.text} | ${right.filePath}:${right.line} ${right.text}`,
			suggestion:
				"Narrow one precedence rule or state explicitly which file wins on conflict.",
		}),
		{ suppressResolvedByPrecedenceMarkers: false, requireScopeOverlap: true },
	);
}

export async function runTopo003(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<Finding[]> {
	const rootFiles = await collectFiles(
		repoRoot,
		config.roles?.rootControllers ?? [],
	);
	const scopedFiles = await collectFiles(
		repoRoot,
		config.roles?.scopedControllers ?? [],
	);
	const rootCandidates = await collectNormalizedNormativeLines(
		repoRoot,
		rootFiles,
	);
	const scopedCandidates = await collectNormalizedNormativeLines(
		repoRoot,
		scopedFiles,
	);
	const findings: Finding[] = [];

	for (const rootCandidate of rootCandidates) {
		for (const scopedCandidate of scopedCandidates) {
			if (rootCandidate.normalized !== scopedCandidate.normalized) {
				continue;
			}
			if (
				!overlapScopeTokens(
					rootCandidate.scopeTokens,
					scopedCandidate.scopeTokens,
				)
			) {
				continue;
			}
			findings.push({
				ruleId: "TOPO003",
				severity: "warning",
				filePath: scopedCandidate.filePath,
				line: scopedCandidate.line,
				message:
					"Scoped controller repeats a normalized normative line from a root controller",
				evidence: `${rootCandidate.filePath}:${rootCandidate.line} ${rootCandidate.text} | ${scopedCandidate.filePath}:${scopedCandidate.line} ${scopedCandidate.text}`,
				suggestion:
					"Keep the rule in the root controller unless the scoped restatement is truly necessary and narrowed.",
			});
			break;
		}
	}

	return findings;
}

export async function runBoot001(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<Finding[]> {
	const files = await collectFiles(repoRoot, [
		...(config.roles?.rootControllers ?? []),
		...(config.roles?.scopedControllers ?? []),
		...(config.roles?.consumerGuides ?? []),
		...(config.roles?.supportingDocs ?? []),
	]);
	const edges = await collectReadEdges(repoRoot, files);
	const cycles = findCycles(edges);
	const findingsByEvidence = new Map<string, Finding>();

	for (const cycle of cycles) {
		const evidence = cycle
			.map((edge) => `${edge.source}:${edge.line} -> ${edge.target}`)
			.join(" | ");
		findingsByEvidence.set(evidence, {
			ruleId: "BOOT001",
			severity: "error",
			filePath: cycle[0]?.source ?? files[0] ?? "",
			line: cycle[0]?.line,
			message: "Bootstrap/read-order cycle detected across instruction files",
			evidence,
			suggestion:
				"Break the cycle or add a single authoritative bootstrap path with an explicit stop condition.",
		});
	}

	return [...findingsByEvidence.values()];
}

export async function runBoot002(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<Finding[]> {
	const files = await collectFiles(repoRoot, [
		...(config.roles?.rootControllers ?? []),
		...(config.roles?.consumerGuides ?? []),
		...(config.roles?.supportingDocs ?? []),
	]);
	const claims = await collectClaims(repoRoot, files, BOOTSTRAP_MARKER);
	return buildPairwiseFindings(
		"BOOT002",
		claims,
		(left, right) => ({
			filePath: left.filePath,
			line: left.line,
			message:
				"Multiple files claim the first bootstrap/grounding read without an explicit precedence relation",
			evidence: `${left.filePath}:${left.line} ${left.text} | ${right.filePath}:${right.line} ${right.text}`,
			suggestion:
				"Add an explicit fallback/precedence rule so only one bootstrap entrypoint is authoritative.",
		}),
		{ requireScopeOverlap: true },
	);
}

async function collectFiles(
	repoRoot: string,
	patterns: string[],
): Promise<string[]> {
	if (patterns.length === 0) {
		return [];
	}

	const matches = await fg(patterns, {
		cwd: repoRoot,
		onlyFiles: true,
		unique: true,
		dot: true,
	});

	return matches.sort();
}

async function collectClaims(
	repoRoot: string,
	files: string[],
	marker: RegExp,
): Promise<Claim[]> {
	const claims: Claim[] = [];

	for (const relativeFile of files) {
		const absoluteFile = path.resolve(repoRoot, relativeFile);
		const content = await readFile(absoluteFile, "utf8");
		const lines = content.split(/\r?\n/);
		const { headings, codeRanges } = await readMarkdownStructure(absoluteFile);
		const activeLineFlags = buildActiveLineFlags(lines.length, codeRanges);

		lines.forEach((line, index) => {
			const trimmed = line.trim();
			if (!activeLineFlags[index] || !marker.test(line)) {
				return;
			}
			const nearbyLines = lines.filter((_, candidateIndex) => {
				return (
					activeLineFlags[candidateIndex] &&
					candidateIndex >= Math.max(0, index - 1) &&
					candidateIndex < Math.min(lines.length, index + 2)
				);
			});
			claims.push({
				filePath: relativeFile,
				line: index + 1,
				text: trimmed,
				hasLocalPrecedenceMarker: nearbyLines.some((candidateLine) =>
					PRECEDENCE_MARKER.test(candidateLine),
				),
				scopeTokens: extractScopeTokens(
					lines,
					index,
					headings,
					activeLineFlags,
				),
			});
		});
	}

	return claims;
}

async function collectNormalizedNormativeLines(
	repoRoot: string,
	files: string[],
): Promise<
	Array<{
		filePath: string;
		line: number;
		text: string;
		normalized: string;
		scopeTokens: string[];
	}>
> {
	const candidates: Array<{
		filePath: string;
		line: number;
		text: string;
		normalized: string;
		scopeTokens: string[];
	}> = [];

	for (const relativeFile of files) {
		const absoluteFile = path.resolve(repoRoot, relativeFile);
		const content = await readFile(absoluteFile, "utf8");
		const lines = content.split(/\r?\n/);
		const { headings, codeRanges } = await readMarkdownStructure(absoluteFile);
		const activeLineFlags = buildActiveLineFlags(lines.length, codeRanges);

		lines.forEach((line, index) => {
			const trimmed = line.trim();
			if (!activeLineFlags[index] || !isNormativeCandidateLine(trimmed)) {
				return;
			}
			const normalized = normalizeNormativeLine(trimmed);
			if (!normalized) {
				return;
			}
			candidates.push({
				filePath: relativeFile,
				line: index + 1,
				text: trimmed,
				normalized,
				scopeTokens: extractScopeTokens(
					lines,
					index,
					headings,
					activeLineFlags,
				),
			});
		});
	}

	return candidates;
}

async function collectReadEdges(
	repoRoot: string,
	files: string[],
): Promise<Edge[]> {
	const edges: Edge[] = [];
	const seen = new Set<string>();
	const knownTargets = files.map((filePath) => ({
		filePath,
		basename: path.posix.basename(filePath),
	}));

	for (const relativeFile of files) {
		const absoluteFile = path.resolve(repoRoot, relativeFile);
		const content = await readFile(absoluteFile, "utf8");
		const lines = content.split(/\r?\n/);
		const { headings, codeRanges } = await readMarkdownStructure(absoluteFile);
		const activeLineFlags = buildActiveLineFlags(lines.length, codeRanges);
		const pushEdge = (targetFilePath: string, index: number, text: string) => {
			if (targetFilePath === relativeFile) {
				return;
			}
			const edge: Edge = {
				source: relativeFile,
				target: targetFilePath,
				line: index + 1,
				text,
				scopeTokens: extractScopeTokens(
					lines,
					index,
					headings,
					activeLineFlags,
				),
			};
			const signature = `${edge.source}:${edge.line}->${edge.target}:${edge.text}`;
			if (seen.has(signature)) {
				return;
			}
			seen.add(signature);
			edges.push(edge);
		};

		const markdownLinks = await readMarkdownLinks(absoluteFile, {
			includeImages: false,
		});
		for (const link of markdownLinks) {
			if (!isLocalMarkdownLink(link.url)) {
				continue;
			}
			const index = Math.max(0, (link.line ?? 1) - 1);
			if (
				!activeLineFlags[index] ||
				!READ_CHAIN_MARKER.test(lines[index] ?? "")
			) {
				continue;
			}
			const { targetFile } = resolveMarkdownLink(
				absoluteFile,
				link.url,
				repoRoot,
			);
			const relativeTarget = path.posix.normalize(
				path.relative(repoRoot, targetFile),
			);
			const target = knownTargets.find(
				(candidate) => candidate.filePath === relativeTarget,
			);
			if (!target) {
				continue;
			}
			pushEdge(target.filePath, index, (lines[index] ?? "").trim());
		}

		lines.forEach((line, index) => {
			const trimmed = line.trim();
			if (!activeLineFlags[index] || !READ_CHAIN_MARKER.test(line)) {
				return;
			}
			const references = extractReferencedPaths(line, relativeFile);
			for (const target of knownTargets) {
				if (
					!references.has(target.filePath) &&
					!references.has(target.basename)
				) {
					continue;
				}
				pushEdge(target.filePath, index, trimmed);
			}
		});
	}

	return edges;
}

function extractReferencedPaths(line: string, sourceFile: string): Set<string> {
	return readMarkdownPathReferences(line, sourceFile, {
		includeImages: false,
	});
}

function edgeMatchesPathScope(edge: Edge, pathEdges: Edge[]): boolean {
	return pathEdges.every((existingEdge) =>
		overlapScopeTokens(existingEdge.scopeTokens, edge.scopeTokens),
	);
}

function findCycles(edges: Edge[]): Edge[][] {
	const edgesBySource = new Map<string, Edge[]>();
	for (const edge of edges) {
		const current = edgesBySource.get(edge.source) ?? [];
		current.push(edge);
		edgesBySource.set(edge.source, current);
	}

	const cycles = new Map<string, Edge[]>();

	function visit(
		start: string,
		current: string,
		pathEdges: Edge[],
		seen: Set<string>,
	): void {
		for (const edge of edgesBySource.get(current) ?? []) {
			if (!edgeMatchesPathScope(edge, pathEdges)) {
				continue;
			}
			if (edge.target === start) {
				const cycleEdges = [...pathEdges, edge];
				const signature = cycleEdges
					.map((cycleEdge) => {
						const scope = cycleEdge.scopeTokens.join(",");
						return `${cycleEdge.source}:${cycleEdge.line}->${cycleEdge.target}[${scope}]`;
					})
					.sort()
					.join("|");
				cycles.set(signature, cycleEdges);
				continue;
			}
			if (seen.has(edge.target)) {
				continue;
			}
			visit(
				start,
				edge.target,
				[...pathEdges, edge],
				new Set([...seen, edge.target]),
			);
		}
	}

	for (const source of edgesBySource.keys()) {
		visit(source, source, [], new Set([source]));
	}

	return [...cycles.values()];
}

function isNormativeCandidateLine(line: string): boolean {
	if (!line) {
		return false;
	}
	const structuralPrefix = /^(?:#{1,6}\s+|[-*]\s+|\d+\.\s+)/.test(line);
	return structuralPrefix || NORMATIVE_LINE_MARKER.test(line);
}

function normalizeNormativeLine(line: string): string {
	return line
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+\.\s+/, "")
		.replace(/`/g, "")
		.replace(/[\p{P}\p{S}]+/gu, " ")
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim();
}

function buildActiveLineFlags(
	lineCount: number,
	codeRanges: MarkdownRange[],
): boolean[] {
	const activeLineFlags = Array.from({ length: lineCount }, () => true);

	for (const range of codeRanges) {
		const startLine = Math.max(1, range.startLine);
		const endLine = Math.min(lineCount, range.endLine);
		for (let line = startLine; line <= endLine; line += 1) {
			activeLineFlags[line - 1] = false;
		}
	}

	return activeLineFlags;
}

function activeHeadingContext(
	headings: MarkdownHeading[],
	claimLine: number,
): MarkdownHeading[] {
	const stack: MarkdownHeading[] = [];

	for (const heading of headings) {
		if (heading.line >= claimLine) {
			break;
		}
		while (
			stack.length > 0 &&
			(stack.at(-1)?.depth ?? Number.POSITIVE_INFINITY) >= heading.depth
		) {
			stack.pop();
		}
		stack.push(heading);
	}

	return stack;
}

function extractScopeTokens(
	lines: string[],
	index: number,
	headings: MarkdownHeading[],
	activeLineFlags: boolean[],
): string[] {
	const claimLine = index + 1;
	const headingContext = activeHeadingContext(headings, claimLine)
		.slice(-2)
		.map((heading) => heading.text);
	const contextLines = [
		...headingContext,
		...lines.filter((_, candidateIndex) => {
			return (
				activeLineFlags[candidateIndex] &&
				candidateIndex >= Math.max(0, index - 1) &&
				candidateIndex < Math.min(lines.length, index + 2)
			);
		}),
	];
	const localContext = contextLines.join(" ");
	const tokens = new Set<string>();
	for (const candidate of SCOPE_TOKEN_PATTERNS) {
		if (candidate.pattern.test(localContext)) {
			tokens.add(candidate.token);
		}
	}
	for (const line of contextLines) {
		addStructuredScopeTokens(tokens, line);
	}
	return [...tokens].sort();
}

function addStructuredScopeTokens(tokens: Set<string>, line: string): void {
	const trimmed = line.trim().replace(/^#{1,6}\s+/, "");
	const match = /^(model|tool|provider|surface)\s*:\s*(.+)$/i.exec(trimmed);
	if (!match) {
		return;
	}
	const kind = match[1].toLowerCase();
	const value = normalizeStructuredScopeValue(match[2]);
	if (!value) {
		return;
	}
	tokens.add(`${kind}:${value}`);
}

function normalizeStructuredScopeValue(value: string): string {
	return value.toLowerCase().replace(/[`"']/g, "").replace(/\s+/g, " ").trim();
}

function overlapScopeTokens(left: string[], right: string[]): boolean {
	if (left.length === 0 || right.length === 0) {
		return true;
	}
	return left.some((token) => right.includes(token));
}

function claimsShareScope(left: Claim, right: Claim): boolean {
	return overlapScopeTokens(left.scopeTokens, right.scopeTokens);
}

function buildPairwiseFindings(
	ruleId: string,
	claims: Claim[],
	build: (left: Claim, right: Claim) => Omit<Finding, "ruleId" | "severity">,
	options?: {
		suppressResolvedByPrecedenceMarkers?: boolean;
		requireScopeOverlap?: boolean;
	},
): Finding[] {
	const findings: Finding[] = [];

	for (let index = 0; index < claims.length; index += 1) {
		const left = claims[index];
		for (let next = index + 1; next < claims.length; next += 1) {
			const right = claims[next];
			if (left.filePath === right.filePath) {
				continue;
			}
			if (
				options?.suppressResolvedByPrecedenceMarkers !== false &&
				(left.hasLocalPrecedenceMarker || right.hasLocalPrecedenceMarker)
			) {
				continue;
			}
			if (options?.requireScopeOverlap && !claimsShareScope(left, right)) {
				continue;
			}
			findings.push({
				ruleId,
				severity: "error",
				...build(left, right),
			});
		}
	}

	return findings;
}
