export interface DiffLine {
	text: string;
	line: number;
}

export interface FileDiff {
	path: string;
	added: string[];
	removed: string[];
	addedLines: DiffLine[];
	removedLines: DiffLine[];
}

export function parseGitDiff(diffText: string): Map<string, FileDiff> {
	const fileDiffs = new Map<string, FileDiff>();
	let current: FileDiff | undefined;
	let inHunk = false;
	let nextOldLine = 0;
	let nextNewLine = 0;

	for (const line of diffText.split(/\r?\n/)) {
		if (line.startsWith("diff --git ")) {
			const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
			const nextPath = match?.[2];
			current = nextPath
				? (fileDiffs.get(nextPath) ?? {
						path: nextPath,
						added: [],
						removed: [],
						addedLines: [],
						removedLines: [],
					})
				: undefined;
			if (current) {
				fileDiffs.set(current.path, current);
			}
			inHunk = false;
			nextOldLine = 0;
			nextNewLine = 0;
			continue;
		}

		if (line.startsWith("@@")) {
			const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
			nextOldLine = Number(match?.[1] ?? 0);
			nextNewLine = Number(match?.[2] ?? 0);
			inHunk = true;
			continue;
		}

		if (
			!current ||
			!inHunk ||
			line.startsWith("\\ No newline at end of file")
		) {
			continue;
		}

		if (line.startsWith("+") && !line.startsWith("+++")) {
			const text = line.slice(1);
			current.added.push(text);
			current.addedLines.push({ text, line: nextNewLine });
			nextNewLine += 1;
		} else if (line.startsWith("-") && !line.startsWith("---")) {
			const text = line.slice(1);
			current.removed.push(text);
			current.removedLines.push({ text, line: nextOldLine });
			nextOldLine += 1;
		} else if (line.startsWith(" ")) {
			nextOldLine += 1;
			nextNewLine += 1;
		}
	}

	return fileDiffs;
}
