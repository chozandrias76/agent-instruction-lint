#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";

import { lintRepository } from "./index.js";
import type { Finding } from "./types.js";

export interface CliOptions {
	repoRoot: string;
	configPath?: string;
	diffFile?: string;
	format: "text" | "json";
	help: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		repoRoot: process.cwd(),
		format: "text",
		help: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--repo-root") {
			options.repoRoot = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--config") {
			options.configPath = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--diff-file") {
			options.diffFile = requireValue(argv, ++index, arg);
			continue;
		}
		if (arg === "--format") {
			const format = requireValue(argv, ++index, arg);
			if (format !== "text" && format !== "json") {
				throw new Error(`Unsupported --format value: ${format}`);
			}
			options.format = format;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	return options;
}

export function formatFindingsText(findings: Finding[]): string {
	if (findings.length === 0) {
		return "0 findings";
	}

	return findings
		.map((finding) => {
			const location = [finding.filePath, finding.line, finding.column]
				.filter((part) => part !== undefined && part !== "")
				.join(":");
			const lines = [
				`${location ? `${location} ` : ""}${finding.ruleId} ${finding.severity} ${finding.message}`,
				`  evidence: ${finding.evidence}`,
			];
			if (finding.suggestion) {
				lines.push(`  suggestion: ${finding.suggestion}`);
			}
			return lines.join("\n");
		})
		.join("\n\n");
}

export function helpText(): string {
	return [
		"Usage: npm run lint -- [options]",
		"",
		"Options:",
		"  --repo-root <path>   Repository root to lint (default: current working directory)",
		"  --config <path>      Config path relative to repo root (default: agent-instruction-lint.json)",
		"  --diff-file <path>   Read diff text from a file instead of the default combined staged+unstaged+untracked git diff",
		"  --format <text|json> Output format (default: text)",
		"  --help, -h           Show this help text",
	].join("\n");
}

async function requireDiffText(diffFile: string): Promise<string> {
	const resolvedPath = path.resolve(diffFile);
	try {
		return await readFile(resolvedPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(`Diff file not found: ${resolvedPath}`);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read diff file at ${resolvedPath}: ${message}`);
	}
}

function requireValue(argv: string[], index: number, flag: string): string {
	const value = argv[index];
	if (!value) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

export async function runCli(argv: string[]): Promise<number> {
	const options = parseCliArgs(argv);
	if (options.help) {
		process.stdout.write(`${helpText()}\n`);
		return 0;
	}

	const diffText = options.diffFile
		? await requireDiffText(options.diffFile)
		: undefined;
	const findings = await lintRepository({
		repoRoot: path.resolve(options.repoRoot),
		configPath: options.configPath,
		diffText,
	});

	if (options.format === "json") {
		process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
	} else {
		process.stdout.write(`${formatFindingsText(findings)}\n`);
	}

	return findings.length > 0 ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
const currentPath = import.meta.filename;

if (invokedPath && currentPath === invokedPath) {
	runCli(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			process.stderr.write(`${message}\n`);
			process.exitCode = 2;
		},
	);
}
