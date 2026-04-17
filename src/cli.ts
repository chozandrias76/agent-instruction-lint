#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import packageJson from "../package.json" with { type: "json" };

import { lintRepository } from "./index.js";
import type { Finding } from "./types.js";

export const CLI_VERSION = packageJson.version;

export interface CliOptions {
	repoRoot: string;
	configPath?: string;
	diffFile?: string;
	format: "text" | "json";
	help: boolean;
	version: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		repoRoot: process.cwd(),
		format: "text",
		help: false,
		version: false,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (arg === "--version") {
			options.version = true;
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

export function helpText(
	invokedPath = process.argv[1],
	env = process.env,
): string {
	return [
		`Usage: ${formatUsageCommand(invokedPath, env)} [options]`,
		"",
		"Options:",
		"  --repo-root <path>   Repository root to lint (default: current working directory)",
		"  --config <path>      Config path relative to repo root (default: agent-instruction-lint.json)",
		"  --diff-file <path>   Read diff text from a file instead of the default combined staged+unstaged+untracked git diff",
		"  --format <text|json> Output format (default: text)",
		"  --version            Show the CLI version",
		"  --help, -h           Show this help text",
	].join("\n");
}

export function formatUsageCommand(
	invokedPath: string | undefined,
	env: NodeJS.ProcessEnv,
): string {
	if (env.npm_lifecycle_event === "lint") {
		return "npm run lint --";
	}
	if (!invokedPath) {
		return "agent-instruction-lint";
	}
	const basename = path.basename(invokedPath);
	if (basename !== "cli.js" && basename !== "cli.ts") {
		return basename;
	}
	const relativePath = path.relative(process.cwd(), path.resolve(invokedPath));
	const displayPath =
		relativePath && !relativePath.startsWith("..") ? relativePath : basename;
	return `node ${displayPath}`;
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
	if (options.version) {
		process.stdout.write(`${CLI_VERSION}\n`);
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

export function isDirectExecution(
	invokedPath: string | undefined,
	currentPath: string,
): boolean {
	if (!invokedPath) {
		return false;
	}
	return (
		normalizeExecutablePath(invokedPath) ===
		normalizeExecutablePath(currentPath)
	);
}

function normalizeExecutablePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	try {
		return realpathSync(resolved);
	} catch {
		return resolved;
	}
}

const invokedPath = process.argv[1];
const currentPath = import.meta.filename;

if (isDirectExecution(invokedPath, currentPath)) {
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
