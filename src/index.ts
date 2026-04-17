import { spawnSync } from "node:child_process";

import { loadConfig } from "./config.js";
import {
	runCite001,
	runCite002,
	runCite003,
	runCite004,
	runCite005,
} from "./rules/citation.js";
import { runLink001 } from "./rules/link001.js";
import { runPhrase001 } from "./rules/phrase.js";
import {
	runBoot001,
	runBoot002,
	runTopo001,
	runTopo002,
	runTopo003,
} from "./rules/topology.js";
import type { Finding } from "./types.js";

export async function lintRepository(options: {
	repoRoot: string;
	configPath?: string;
	diffText?: string;
}): Promise<Finding[]> {
	const config = await loadConfig(options.repoRoot, options.configPath);
	const diffText = options.diffText ?? getGitDiff(options.repoRoot);

	const findings = [
		...(await runLink001(options.repoRoot, config)),
		...runCite001(config, diffText),
		...runCite002(config, diffText),
		...runCite003(config, diffText),
		...(await runCite004(options.repoRoot, config, diffText)),
		...(await runCite005(options.repoRoot, config)),
		...runPhrase001(config, diffText),
		...(await runTopo001(options.repoRoot, config)),
		...(await runTopo002(options.repoRoot, config)),
		...(await runTopo003(options.repoRoot, config)),
		...(await runBoot001(options.repoRoot, config)),
		...(await runBoot002(options.repoRoot, config)),
	];

	return findings.sort(compareFindings);
}

export function compareFindings(left: Finding, right: Finding): number {
	if (left.filePath !== right.filePath) {
		return left.filePath.localeCompare(right.filePath);
	}

	const lineOrder = compareOptionalNumber(left.line, right.line);
	if (lineOrder !== 0) {
		return lineOrder;
	}

	const columnOrder = compareOptionalNumber(left.column, right.column);
	if (columnOrder !== 0) {
		return columnOrder;
	}

	if (left.ruleId !== right.ruleId) {
		return left.ruleId.localeCompare(right.ruleId);
	}
	if (left.evidence !== right.evidence) {
		return left.evidence.localeCompare(right.evidence);
	}
	return left.message.localeCompare(right.message);
}

function compareOptionalNumber(
	left: number | undefined,
	right: number | undefined,
): number {
	if (left === right) {
		return 0;
	}
	if (left === undefined) {
		return 1;
	}
	if (right === undefined) {
		return -1;
	}
	return left - right;
}

function getGitDiff(repoRoot: string): string {
	try {
		runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
		const unstaged = runGit(repoRoot, [
			"diff",
			"--no-ext-diff",
			"--unified=0",
			"--relative",
		]);
		const staged = runGit(repoRoot, [
			"diff",
			"--cached",
			"--no-ext-diff",
			"--unified=0",
			"--relative",
		]);
		const untrackedPaths = runGit(repoRoot, [
			"ls-files",
			"--others",
			"--exclude-standard",
		])
			.split(/\r?\n/)
			.map((entry) => entry.trim())
			.filter(Boolean);
		const untrackedDiffs = untrackedPaths.map((filePath) =>
			runGit(
				repoRoot,
				[
					"diff",
					"--no-index",
					"--no-ext-diff",
					"--unified=0",
					"--",
					"/dev/null",
					filePath,
				],
				[0, 1],
			),
		);
		return [
			unstaged.trimEnd(),
			staged.trimEnd(),
			...untrackedDiffs.map((text) => text.trimEnd()),
		]
			.filter(Boolean)
			.join("\n");
	} catch {
		return "";
	}
}

function runGit(
	repoRoot: string,
	args: string[],
	allowedExitCodes: number[] = [0],
): string {
	const result = spawnSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!allowedExitCodes.includes(result.status ?? 0)) {
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
	}
	return result.stdout;
}

export type { AgentInstructionLintConfig, Finding } from "./types.js";
