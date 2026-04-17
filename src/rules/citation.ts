import { access, readFile } from "node:fs/promises";
import path from "node:path";

import picomatch from "picomatch";

import { type DiffLine, parseGitDiff } from "../diff.js";
import {
	isLocalMarkdownLink,
	readHeadingSlugs,
	readInlineMarkdownLinks,
	readInlineMarkdownReferences,
	readMarkdownLinks,
	readMarkdownPathReferences,
	resolveMarkdownLink,
} from "../markdown.js";
import type { AgentInstructionLintConfig, Finding } from "../types.js";

const NORMATIVE_PATTERN =
	/\b(?:must(?: not)?|never|always|only|required|forbidden|canonical|exact|hard block|do not)\b/i;
const STRUCTURAL_PATTERN =
	/\b(?:procedure|precedence|routing|bootstrap|approval|stop condition|output format|entrypoint|read-order|load exactly|state)\b/i;
const COMMAND_PATTERN = /`[^`]+`|\b(?:bd|git|read|load|start with)\b/i;
const STATE_PATTERN = /\b(?:STATE:|KLAATU|BERADA|NIKTO)\b/;

export function runCite001(
	config: AgentInstructionLintConfig,
	diffText: string,
): Finding[] {
	if (!config.citation) {
		return [];
	}

	const citation = config.citation;
	const diff = parseGitDiff(diffText);
	const changedPaths = new Set(diff.keys());
	const citationLogChanged = changedPaths.has(citation.log);
	const isProtected = matcher(citation.protected);
	const findings: Finding[] = [];

	for (const [filePath, fileDiff] of diff.entries()) {
		if (!isProtected(filePath)) {
			continue;
		}
		if (!hasBehavioralChange(fileDiff.added, fileDiff.removed)) {
			continue;
		}
		if (citationLogChanged) {
			continue;
		}

		const behavioralLine =
			findBehavioralDiffLine(fileDiff.addedLines) ??
			findBehavioralDiffLine(fileDiff.removedLines);
		findings.push({
			ruleId: "CITE001",
			severity: "error",
			filePath,
			line: behavioralLine?.line,
			message: `Behavioral change in protected file requires an update to ${citation.log}`,
			evidence: behavioralLine?.text ?? "behavioral diff detected",
			suggestion: `Add or update a citation entry in ${citation.log}.`,
		});
	}

	return findings;
}

export async function runCite004(
	repoRoot: string,
	config: AgentInstructionLintConfig,
	diffText: string,
): Promise<Finding[]> {
	const citation = config.citation;
	if (!citation) {
		return [];
	}

	const blocks = extractAddedCitationEntryBlocks(diffText, citation.log);
	if (blocks.length === 0) {
		return [];
	}

	const citationLogAbsolutePath = path.resolve(repoRoot, citation.log);
	const headingCache = new Map<string, Promise<Set<string>>>();
	const findings: Finding[] = [];

	for (const block of blocks) {
		const lines = block.text.split("\n");
		for (const link of readInlineMarkdownLinks(block.text)) {
			if (!isLocalMarkdownLink(link.url)) {
				continue;
			}
			const { targetFile, fragment } = resolveMarkdownLink(
				citationLogAbsolutePath,
				link.url,
				repoRoot,
			);
			const lineOffset = (link.line ?? 1) - 1;
			const evidence = lines[lineOffset] || link.url;
			try {
				await access(targetFile);
			} catch {
				findings.push({
					ruleId: "CITE004",
					severity: "error",
					filePath: citation.log,
					line: block.startLine + lineOffset,
					column: link.column,
					message: `Citation entry contains a local evidence link that does not resolve: ${link.url}`,
					evidence,
					suggestion:
						"Fix the local evidence path or replace it with an existing artifact link.",
				});
				continue;
			}
			if (!fragment || !/\.md$/i.test(targetFile)) {
				continue;
			}
			const headings = getCachedHeadings(headingCache, targetFile);
			if (!(await headings).has(fragment.toLowerCase())) {
				findings.push({
					ruleId: "CITE004",
					severity: "error",
					filePath: citation.log,
					line: block.startLine + lineOffset,
					column: link.column,
					message: `Citation entry contains a markdown evidence fragment that does not resolve: ${link.url}`,
					evidence,
					suggestion:
						"Update the fragment to an existing heading slug or point at the correct evidence section.",
				});
			}
		}
	}

	return findings;
}

export async function runCite005(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<Finding[]> {
	const citation = config.citation;
	if (!citation || (citation.entryDocs?.length ?? 0) === 0) {
		return [];
	}

	const findings: Finding[] = [];
	for (const entryDoc of citation.entryDocs ?? []) {
		const absolutePath = path.resolve(repoRoot, entryDoc);
		try {
			await access(absolutePath);
		} catch {
			findings.push({
				ruleId: "CITE005",
				severity: "error",
				filePath: entryDoc,
				message: `Configured citation-contract entry doc does not exist: ${entryDoc}`,
				evidence: entryDoc,
				suggestion:
					"Fix the configured entry-doc path or create the missing file.",
			});
			continue;
		}
		const content = await readFile(absolutePath, "utf8");
		const links = await readMarkdownLinks(absolutePath, {
			includeImages: false,
		});
		const basename = path.basename(citation.log);
		const referencedPaths = extractCitationReferencedPaths(content, entryDoc);

		const hasLinkedCitation = links.some((link) => {
			const { targetFile } = resolveMarkdownLink(
				absolutePath,
				link.url,
				repoRoot,
			);
			return (
				path.posix.normalize(path.relative(repoRoot, targetFile)) ===
				citation.log
			);
		});
		const hasExplicitMention =
			referencedPaths.has(path.posix.normalize(citation.log)) ||
			referencedPaths.has(basename);

		if (!hasLinkedCitation && !hasExplicitMention) {
			findings.push({
				ruleId: "CITE005",
				severity: "error",
				filePath: entryDoc,
				message: `Citation-contract entry doc does not reference ${citation.log}`,
				evidence: entryDoc,
				suggestion: `Add a citation-log link or explicit citation rule pointing to ${citation.log}.`,
			});
		}
	}

	return findings;
}

export interface AddedCitationEntryBlock {
	text: string;
	startLine: number;
}

export function extractAddedCitationEntryBlocks(
	diffText: string,
	citationLogPath: string,
): AddedCitationEntryBlock[] {
	const diff = parseGitDiff(diffText);
	const citationDiff = diff.get(citationLogPath);
	if (!citationDiff || citationDiff.addedLines.length === 0) {
		return [];
	}

	const blocks: AddedCitationEntryBlock[] = [];
	let current: AddedCitationEntryBlock | undefined;
	let currentEndLine = 0;

	for (const [index, addedLine] of citationDiff.addedLines.entries()) {
		const isEntryHeading = isCitationEntryHeading(
			citationDiff.addedLines,
			index,
		);
		const isContiguous = current && addedLine.line === currentEndLine + 1;

		if (current && (!isContiguous || isEntryHeading)) {
			if (current.text.trim()) {
				blocks.push({
					text: current.text.trim(),
					startLine: current.startLine,
				});
			}
			current = undefined;
		}

		if (!current) {
			if (!isEntryHeading) {
				continue;
			}
			current = {
				text: addedLine.text,
				startLine: addedLine.line,
			};
			currentEndLine = addedLine.line;
			continue;
		}

		current.text += `\n${addedLine.text}`;
		currentEndLine = addedLine.line;
	}

	if (current && current.text.trim()) {
		blocks.push({
			text: current.text.trim(),
			startLine: current.startLine,
		});
	}

	return blocks;
}

function isCitationEntryHeading(
	addedLines: DiffLine[],
	index: number,
): boolean {
	const current = addedLines[index];
	if (!current) {
		return false;
	}
	if (current.text.startsWith("## ")) {
		return true;
	}
	if (!current.text.trim()) {
		return false;
	}
	const next = addedLines[index + 1];
	if (!next || next.line !== current.line + 1) {
		return false;
	}
	return /^---+\s*$/.test(next.text);
}

export function runCite002(
	config: AgentInstructionLintConfig,
	diffText: string,
): Finding[] {
	const citation = config.citation;
	if (!citation) {
		return [];
	}

	const diff = parseGitDiff(diffText);
	const changedProtectedPaths = [...diff.keys()].filter((filePath) =>
		matcher(citation.protected)(filePath),
	);
	if (changedProtectedPaths.length === 0 || !diff.has(citation.log)) {
		return [];
	}

	const blocks = extractAddedCitationEntryBlocks(diffText, citation.log);
	const citationDiff = diff.get(citation.log);
	const referencedPaths = extractCitationReferencedPaths(
		blocks.map((block) => block.text).join("\n"),
		citation.log,
	);
	const findings: Finding[] = [];
	const reportLine = blocks[0]?.startLine ?? citationDiff?.addedLines[0]?.line;

	for (const filePath of changedProtectedPaths) {
		const basename = path.basename(filePath);
		const isMentioned =
			referencedPaths.has(path.posix.normalize(filePath)) ||
			referencedPaths.has(basename);

		if (!isMentioned) {
			findings.push({
				ruleId: "CITE002",
				severity: "error",
				filePath: citation.log,
				line: reportLine,
				message: `Citation entry does not mention changed protected file ${filePath}`,
				evidence: filePath,
				suggestion:
					"Add the changed protected file to the citation entry's updated-files or evidence list.",
			});
		}
	}

	return findings;
}

export function runCite003(
	config: AgentInstructionLintConfig,
	diffText: string,
): Finding[] {
	const citation = config.citation;
	if (!citation) {
		return [];
	}

	const blocks = extractAddedCitationEntryBlocks(diffText, citation.log);
	if (blocks.length === 0) {
		return [];
	}

	const required = citation.requiredMarkers ?? {};
	const findings: Finding[] = [];

	for (const block of blocks) {
		const missingGroups = Object.entries(required)
			.filter(([, markers]) => markers.length > 0)
			.filter(
				([, markers]) => !markers.some((marker) => block.text.includes(marker)),
			)
			.map(([group]) => group);

		if (missingGroups.length > 0) {
			findings.push({
				ruleId: "CITE003",
				severity: "error",
				filePath: citation.log,
				line: block.startLine,
				message: `Citation entry is missing required marker groups: ${missingGroups.join(", ")}`,
				evidence: block.text.split("\n")[0] ?? citation.log,
				suggestion:
					"Add the missing citation structure markers to the new entry.",
			});
		}
	}

	return findings;
}

function extractCitationReferencedPaths(
	text: string,
	sourceFile: string,
): Set<string> {
	return readMarkdownPathReferences(text, sourceFile, {
		includeImages: false,
	});
}

function getCachedHeadings(
	cache: Map<string, Promise<Set<string>>>,
	filePath: string,
): Promise<Set<string>> {
	let headings = cache.get(filePath);
	if (!headings) {
		headings = readHeadingSlugs(filePath).then((slugs) => {
			const lowered = new Set<string>();
			for (const slug of slugs) {
				lowered.add(slug.toLowerCase());
			}
			return lowered;
		});
		cache.set(filePath, headings);
	}
	return headings;
}

function findBehavioralDiffLine(lines: DiffLine[]): DiffLine | undefined {
	return lines.find((line) => isBehavioralLine(line.text));
}

function hasBehavioralChange(added: string[], removed: string[]): boolean {
	return [...added, ...removed].some((line) => isBehavioralLine(line));
}

function isBehavioralLine(line: string): boolean {
	const trimmed = line.trim();
	if (!trimmed) {
		return false;
	}
	return (
		NORMATIVE_PATTERN.test(trimmed) ||
		STATE_PATTERN.test(trimmed) ||
		((/^#{1,6}\s/.test(trimmed) ||
			/^[-*]\s/.test(trimmed) ||
			/^\d+\.\s/.test(trimmed)) &&
			(STRUCTURAL_PATTERN.test(trimmed) || COMMAND_PATTERN.test(trimmed))) ||
		(STRUCTURAL_PATTERN.test(trimmed) && COMMAND_PATTERN.test(trimmed))
	);
}

function matcher(patterns: string[]): (value: string) => boolean {
	const tests = patterns.map((pattern) => picomatch(pattern));
	return (value: string) => tests.some((test) => test(value));
}
