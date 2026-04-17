export type Severity = "error" | "warning" | "note";

export interface Finding {
	ruleId: string;
	severity: Severity;
	filePath: string;
	message: string;
	evidence: string;
	line?: number;
	column?: number;
	suggestion?: string;
}

export interface InstructionModelConfig {
	name: string;
	chainFromRootToCwd?: boolean;
	overrideFiles?: string[];
	baseFiles?: string[];
	fallbackFiles?: string[];
}

export interface RolesConfig {
	rootControllers?: string[];
	scopedControllers?: string[];
	maintainerGuides?: string[];
	consumerGuides?: string[];
	citationLogs?: string[];
	evalCompanions?: string[];
	supportingDocs?: string[];
}

export interface MarkerGroups {
	[group: string]: string[];
}

export interface CitationConfig {
	protected: string[];
	log: string;
	entryDocs?: string[];
	requiredMarkers?: MarkerGroups;
	optionalMarkers?: MarkerGroups;
}

export interface CanonicalPhraseConfig {
	value: string;
	recognizedVariants?: string[];
	forbiddenEmittedForms?: string[];
}

export interface PhraseConfig {
	canonical?: CanonicalPhraseConfig[];
}

export interface AgentInstructionLintConfig {
	$schema?: string;
	instructionModel?: InstructionModelConfig;
	roles?: RolesConfig;
	citation?: CitationConfig;
	phrases?: PhraseConfig;
}
