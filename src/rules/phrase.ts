import { parseGitDiff } from "../diff.js";
import type { AgentInstructionLintConfig, Finding } from "../types.js";

export function runPhrase001(
	config: AgentInstructionLintConfig,
	diffText: string,
): Finding[] {
	const phraseConfigs = config.phrases?.canonical ?? [];
	if (phraseConfigs.length === 0) {
		return [];
	}

	const diff = parseGitDiff(diffText);
	const findings: Finding[] = [];

	for (const [filePath, fileDiff] of diff.entries()) {
		if (!/\.md$/i.test(filePath)) {
			continue;
		}

		for (const addedLine of fileDiff.addedLines) {
			for (const phraseConfig of phraseConfigs) {
				for (const forbidden of phraseConfig.forbiddenEmittedForms ?? []) {
					const column = findForbiddenPhraseColumn(addedLine.text, forbidden);
					if (!column) {
						continue;
					}

					findings.push({
						ruleId: "PHRASE001",
						severity: "error",
						filePath,
						line: addedLine.line,
						column,
						message: `Forbidden emitted phrase form used instead of canonical phrase ${phraseConfig.value}`,
						evidence: forbidden,
						suggestion: `Replace ${JSON.stringify(forbidden)} with ${JSON.stringify(phraseConfig.value)} in emitted docs/examples.`,
					});
				}
			}
		}
	}

	return findings;
}

function findForbiddenPhraseColumn(
	line: string,
	forbidden: string,
): number | undefined {
	const escaped = escapeRegExp(forbidden);
	const pattern = new RegExp(
		`(^|[^\\p{L}\\p{N}_-])(${escaped})(?=$|[^\\p{L}\\p{N}_-])`,
		"u",
	);
	const match = pattern.exec(line);
	if (!match) {
		return undefined;
	}
	return match.index + (match[1]?.length ?? 0) + 1;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
