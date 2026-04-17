import { access } from "node:fs/promises";
import path from "node:path";

import fg from "fast-glob";

import {
	isLocalMarkdownLink,
	readHeadingSlugs,
	readMarkdownLinks,
	resolveMarkdownLink,
} from "../markdown.js";
import type { AgentInstructionLintConfig, Finding } from "../types.js";

export async function runLink001(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<Finding[]> {
	const files = await collectLinkRuleFiles(repoRoot, config);
	const headingCache = new Map<string, Promise<Set<string>>>();
	const findings: Finding[] = [];

	for (const relativeFile of files) {
		const absoluteFile = path.resolve(repoRoot, relativeFile);
		const links = await readMarkdownLinks(absoluteFile);

		for (const link of links) {
			if (!isLocalMarkdownLink(link.url)) {
				continue;
			}

			const { targetFile, fragment } = resolveMarkdownLink(
				absoluteFile,
				link.url,
				repoRoot,
			);
			const relativeTarget =
				path.relative(repoRoot, targetFile) || relativeFile;

			const targetExists = await fileExists(targetFile);
			if (!targetExists) {
				findings.push({
					ruleId: "LINK001",
					severity: "error",
					filePath: relativeFile,
					line: link.line,
					column: link.column,
					message: `Local link target does not exist: ${link.url}`,
					evidence: relativeTarget,
					suggestion: "Update the link target or restore the referenced file.",
				});
				continue;
			}

			if (!fragment || !isMarkdownFile(targetFile)) {
				continue;
			}

			const headings = getCachedHeadings(headingCache, targetFile);
			if (!(await headings).has(fragment.toLowerCase())) {
				findings.push({
					ruleId: "LINK001",
					severity: "error",
					filePath: relativeFile,
					line: link.line,
					column: link.column,
					message: `Markdown fragment does not resolve: ${link.url}`,
					evidence: `${relativeTarget}#${fragment}`,
					suggestion: "Update the fragment to an existing heading slug.",
				});
			}
		}
	}

	return findings;
}

async function collectLinkRuleFiles(
	repoRoot: string,
	config: AgentInstructionLintConfig,
): Promise<string[]> {
	const patterns = new Set<string>([
		...(config.roles?.rootControllers ?? []),
		...(config.roles?.scopedControllers ?? []),
		...(config.roles?.maintainerGuides ?? []),
		...(config.roles?.consumerGuides ?? []),
		...(config.roles?.citationLogs ?? []),
		...(config.roles?.evalCompanions ?? []),
		...(config.roles?.supportingDocs ?? []),
	]);

	if (config.citation?.log) {
		patterns.add(config.citation.log);
	}
	for (const entryDoc of config.citation?.entryDocs ?? []) {
		patterns.add(entryDoc);
	}

	if (patterns.size === 0) {
		return [];
	}

	const matches = await fg([...patterns], {
		cwd: repoRoot,
		onlyFiles: true,
		unique: true,
		dot: true,
	});

	return matches.sort();
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

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function isMarkdownFile(filePath: string): boolean {
	return /\.md$/i.test(filePath);
}
