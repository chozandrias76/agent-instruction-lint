import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";
import type {
	Code,
	Definition,
	Heading,
	Image,
	ImageReference,
	InlineCode,
	Link,
	LinkReference,
	Root,
} from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";

export interface MarkdownLink {
	url: string;
	line?: number;
	column?: number;
}

export interface MarkdownLinkOptions {
	includeImages?: boolean;
}

export interface MarkdownReferenceOptions extends MarkdownLinkOptions {}

export interface MarkdownHeading {
	text: string;
	depth: number;
	line: number;
}

export interface InlineMarkdownReferences {
	links: string[];
	codeSpans: string[];
}

export interface MarkdownRange {
	startLine: number;
	endLine: number;
}

export interface MarkdownStructure {
	headings: MarkdownHeading[];
	codeRanges: MarkdownRange[];
}

interface ParentLike {
	children?: unknown[];
}

interface LiteralLike {
	value?: string;
	alt?: string;
	children?: unknown[];
}

const processor = unified().use(remarkParse);

export async function readMarkdownLinks(
	filePath: string,
	options?: MarkdownLinkOptions,
): Promise<MarkdownLink[]> {
	const content = await readFile(filePath, "utf8");
	const tree = processor.parse(content) as Root;
	return collectMarkdownLinks(tree, options);
}

export async function readHeadingSlugs(filePath: string): Promise<Set<string>> {
	const { headings } = await readMarkdownStructure(filePath);
	const slugger = new GithubSlugger();
	const slugs = new Set<string>();

	for (const heading of headings) {
		slugs.add(slugger.slug(heading.text));
	}

	return slugs;
}

export async function readMarkdownStructure(
	filePath: string,
): Promise<MarkdownStructure> {
	const content = await readFile(filePath, "utf8");
	const tree = processor.parse(content) as Root;
	const structure: MarkdownStructure = {
		headings: [],
		codeRanges: [],
	};

	visit(tree, "heading", (node: Heading) => {
		structure.headings.push({
			text: nodeToText(node),
			depth: node.depth,
			line: node.position?.start?.line ?? 1,
		});
	});
	visit(tree, "code", (node: Code) => {
		structure.codeRanges.push({
			startLine: node.position?.start?.line ?? 1,
			endLine: node.position?.end?.line ?? node.position?.start?.line ?? 1,
		});
	});

	return structure;
}

export async function readMarkdownHeadings(
	filePath: string,
): Promise<MarkdownHeading[]> {
	const { headings } = await readMarkdownStructure(filePath);
	return headings;
}

export async function readMarkdownCodeRanges(
	filePath: string,
): Promise<MarkdownRange[]> {
	const { codeRanges } = await readMarkdownStructure(filePath);
	return codeRanges;
}

export function readInlineMarkdownLinks(
	markdown: string,
	options?: MarkdownLinkOptions,
): MarkdownLink[] {
	const tree = processor.parse(markdown) as Root;
	return collectMarkdownLinks(tree, options);
}

export function readInlineMarkdownReferences(
	markdown: string,
	options?: MarkdownReferenceOptions,
): InlineMarkdownReferences {
	const tree = processor.parse(markdown) as Root;
	const references: InlineMarkdownReferences = {
		links: [],
		codeSpans: [],
	};

	for (const link of collectMarkdownLinks(tree, options)) {
		references.links.push(link.url);
	}
	visit(tree, "inlineCode", (node: InlineCode) => {
		references.codeSpans.push(String(node.value ?? ""));
	});

	return references;
}

export function readMarkdownPathReferences(
	markdown: string,
	sourceFile: string,
	options?: MarkdownReferenceOptions,
): Set<string> {
	const references = new Set<string>();
	const { links, codeSpans } = readInlineMarkdownReferences(markdown, options);
	const barePathPattern =
		/(?:^|[\s(])((?:file:\/\/[^\s)]+|~\/[\w./%+-]+|\/[\w./%+-]+|(?:\.{1,2}\/)?[\w./%+-]+)\.md(?:[?#][^\s),;:]*)?)(?=$|[\s),;:!?]|\.(?![\w-]))/gim;
	const barePathText =
		options?.includeImages === false
			? stripImageSyntaxForBarePathScan(markdown)
			: markdown;

	for (const link of links) {
		addMarkdownPathReferenceVariants(references, link, sourceFile);
	}
	for (const codeSpan of codeSpans) {
		addMarkdownPathReferenceVariants(references, codeSpan, sourceFile);
	}
	for (const match of barePathText.matchAll(barePathPattern)) {
		addMarkdownPathReferenceVariants(references, match[1], sourceFile);
	}

	return references;
}

export function isLocalMarkdownLink(url: string): boolean {
	if (!url) {
		return false;
	}
	if (url.startsWith("#")) {
		return true;
	}
	if (url.startsWith("file://")) {
		return true;
	}
	if (url.startsWith("//")) {
		return false;
	}
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) {
		return false;
	}
	return true;
}

export function resolveMarkdownLink(
	sourceFile: string,
	url: string,
	repoRoot: string,
): { targetFile: string; fragment?: string } {
	const [pathPartWithQuery, rawFragment] = url.split("#", 2);
	const pathPart = pathPartWithQuery.split("?", 2)[0];
	const decodedPathPart = decodePathLikeValue(pathPart);
	const targetFile = !decodedPathPart
		? sourceFile
		: decodedPathPart.startsWith("file://")
			? fileURLToPath(decodedPathPart)
			: decodedPathPart.startsWith("~/")
				? path.resolve(os.homedir(), decodedPathPart.slice(2))
				: path.isAbsolute(decodedPathPart)
					? path.normalize(decodedPathPart)
					: path.resolve(path.dirname(sourceFile), decodedPathPart);

	return {
		targetFile,
		fragment: rawFragment ? decodeFragmentLikeValue(rawFragment) : undefined,
	};
}

function decodeFragmentLikeValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function addMarkdownPathReferenceVariants(
	references: Set<string>,
	reference: string,
	sourceFile: string,
): void {
	const cleaned = reference.trim().split(/[?#]/)[0] ?? "";
	if (!cleaned) {
		return;
	}

	const decoded = decodePathLikeValue(cleaned);
	const normalized = decoded.startsWith("file://")
		? path.posix.normalize(fileURLToPath(decoded))
		: decoded.startsWith("~/")
			? path.posix.normalize(path.join(os.homedir(), decoded.slice(2)))
			: path.posix.normalize(decoded);
	if (!/\.md$/i.test(normalized)) {
		return;
	}

	references.add(normalized);
	references.add(path.posix.basename(normalized));
	if (
		decoded.startsWith("file://") ||
		decoded.startsWith("~/") ||
		path.posix.isAbsolute(normalized)
	) {
		return;
	}
	const resolved = path.posix.normalize(
		path.posix.join(path.posix.dirname(sourceFile), normalized),
	);
	references.add(resolved);
	references.add(path.posix.basename(resolved));
}

function decodePathLikeValue(value: string): string {
	if (!value || value.startsWith("file://")) {
		return value;
	}
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}
function collectMarkdownLinks(
	tree: Root,
	options?: MarkdownLinkOptions,
): MarkdownLink[] {
	const links: MarkdownLink[] = [];
	const definitions = new Map<string, string>();
	const includeImages = options?.includeImages ?? true;

	visit(tree, "definition", (node: Definition) => {
		const identifier = String(node.identifier ?? "")
			.trim()
			.toLowerCase();
		const url = String(node.url ?? "");
		if (identifier && url) {
			definitions.set(identifier, url);
		}
	});
	visit(tree, "link", (node: Link) => {
		links.push({
			url: String(node.url ?? ""),
			line: node.position?.start?.line,
			column: node.position?.start?.column,
		});
	});
	if (includeImages) {
		visit(tree, "image", (node: Image) => {
			links.push({
				url: String(node.url ?? ""),
				line: node.position?.start?.line,
				column: node.position?.start?.column,
			});
		});
	}
	visit(tree, "linkReference", (node: LinkReference) => {
		const url = definitions.get(
			String(node.identifier ?? "")
				.trim()
				.toLowerCase(),
		);
		if (!url) {
			return;
		}
		links.push({
			url,
			line: node.position?.start?.line,
			column: node.position?.start?.column,
		});
	});
	if (includeImages) {
		visit(tree, "imageReference", (node: ImageReference) => {
			const url = definitions.get(
				String(node.identifier ?? "")
					.trim()
					.toLowerCase(),
			);
			if (!url) {
				return;
			}
			links.push({
				url,
				line: node.position?.start?.line,
				column: node.position?.start?.column,
			});
		});
	}

	return links;
}

function stripImageSyntaxForBarePathScan(markdown: string): string {
	const tree = processor.parse(markdown) as Root;
	const imageReferenceIdentifiers = new Set<string>();
	const linkReferenceIdentifiers = new Set<string>();
	const ranges: Array<{ start: number; end: number }> = [];

	visit(tree, "image", (node: Image) => {
		addRange(ranges, node.position?.start?.offset, node.position?.end?.offset);
	});
	visit(tree, "imageReference", (node: ImageReference) => {
		imageReferenceIdentifiers.add(
			String(node.identifier ?? "")
				.trim()
				.toLowerCase(),
		);
		addRange(ranges, node.position?.start?.offset, node.position?.end?.offset);
	});
	visit(tree, "linkReference", (node: LinkReference) => {
		linkReferenceIdentifiers.add(
			String(node.identifier ?? "")
				.trim()
				.toLowerCase(),
		);
	});
	visit(tree, "definition", (node: Definition) => {
		const identifier = String(node.identifier ?? "")
			.trim()
			.toLowerCase();
		if (
			identifier &&
			imageReferenceIdentifiers.has(identifier) &&
			!linkReferenceIdentifiers.has(identifier)
		) {
			addRange(
				ranges,
				node.position?.start?.offset,
				node.position?.end?.offset,
			);
		}
	});

	if (ranges.length === 0) {
		return markdown;
	}

	const characters = [...markdown];
	for (const range of ranges) {
		for (let index = range.start; index < range.end; index += 1) {
			characters[index] = " ";
		}
	}
	return characters.join("");
}

function addRange(
	ranges: Array<{ start: number; end: number }>,
	start: number | undefined,
	end: number | undefined,
): void {
	if (start === undefined || end === undefined || end <= start) {
		return;
	}
	ranges.push({ start, end });
}

function nodeToText(node: unknown): string {
	const current = node as LiteralLike & ParentLike;
	let value = "";

	if (typeof current.value === "string") {
		value += current.value;
	}
	if (typeof current.alt === "string") {
		value += current.alt;
	}
	for (const child of current.children ?? []) {
		value += nodeToText(child);
	}

	return value.trim();
}
