import { readFile } from "node:fs/promises";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import schema from "../agent-instruction-lint.schema.json" with {
	type: "json",
};
import type { AgentInstructionLintConfig } from "./types.js";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

export async function loadConfig(
	repoRoot: string,
	configPath = "agent-instruction-lint.json",
): Promise<AgentInstructionLintConfig> {
	const resolvedPath = path.resolve(repoRoot, configPath);
	let rawText: string;
	try {
		rawText = await readFile(resolvedPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Config file not found: ${resolvedPath}`);
		}
		throw error;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText) as unknown;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid JSON in config at ${resolvedPath}: ${message}`);
	}

	if (!validate(parsed)) {
		const message = ajv.errorsText(validate.errors, { separator: "\n" });
		throw new Error(`Invalid config at ${resolvedPath}: ${message}`);
	}

	return normalizeConfig(parsed as AgentInstructionLintConfig);
}

export function normalizeConfig(
	config: AgentInstructionLintConfig,
): AgentInstructionLintConfig {
	return {
		$schema: config.$schema,
		instructionModel: config.instructionModel
			? {
					name: config.instructionModel.name,
					chainFromRootToCwd: config.instructionModel.chainFromRootToCwd,
					overrideFiles: config.instructionModel.overrideFiles ?? [],
					baseFiles: config.instructionModel.baseFiles ?? [],
					fallbackFiles: config.instructionModel.fallbackFiles ?? [],
				}
			: undefined,
		roles: {
			rootControllers: config.roles?.rootControllers ?? [],
			scopedControllers: config.roles?.scopedControllers ?? [],
			maintainerGuides: config.roles?.maintainerGuides ?? [],
			consumerGuides: config.roles?.consumerGuides ?? [],
			citationLogs: config.roles?.citationLogs ?? [],
			evalCompanions: config.roles?.evalCompanions ?? [],
			supportingDocs: config.roles?.supportingDocs ?? [],
		},
		citation: config.citation
			? {
					protected: config.citation.protected,
					log: config.citation.log,
					entryDocs: config.citation.entryDocs ?? [],
					requiredMarkers: config.citation.requiredMarkers ?? {},
					optionalMarkers: config.citation.optionalMarkers ?? {},
				}
			: undefined,
		phrases: {
			canonical: config.phrases?.canonical ?? [],
		},
	};
}
