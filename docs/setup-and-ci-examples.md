# Setup, config, and CI integration examples

This guide shows how to adopt `agent-instruction-lint` in a fresh repository using the current CLI surface.

## 1. Install dependencies

From this repository itself:

```bash
npm ci
```

If you are copying the tool into another repo or workspace, make sure the runtime can execute:
- `npm run lint -- --repo-root /path/to/repo`
- `npm run typecheck`
- `npm test`

## 2. Add a minimal config

Create `agent-instruction-lint.json` at the target repository root.

Minimal example:

```json
{
  "$schema": "./agent-instruction-lint.schema.json",
  "roles": {
    "rootControllers": ["AGENTS.md"],
    "scopedControllers": ["**/AGENTS.md"],
    "supportingDocs": ["README.md", "docs/**/*.md"]
  },
  "citation": {
    "protected": ["AGENTS.md", "gort.md", "states/*.md"],
    "log": "gort.citations.md",
    "entryDocs": ["AGENTS.md", "README.md"],
    "requiredMarkers": {
      "localEvidence": ["### Local evidence"],
      "updatedFiles": ["Updated files"],
      "rationale": ["Why this evidence supports"]
    }
  },
  "phrases": {
    "canonical": [
      {
        "value": "KLAATU BERADA NIKTO",
        "recognizedVariants": ["Klatu Berata Nicto"],
        "forbiddenEmittedForms": ["Gort mode"]
      }
    ]
  }
}
```

Notes:
- keep file roles explicit; this tool does not guess universal AGENTS semantics
- use globs only where the repository layout is genuinely regular
- keep citation `protected` paths narrow and intentional in the first pass

## 3. Run locally against the working tree

Default behavior lints against the combined:
- unstaged git diff
- staged git diff
- untracked files

```bash
npm run lint -- --repo-root /path/to/repo
```

JSON output for scripts:

```bash
npm run lint -- --repo-root /path/to/repo --format json
```

## 4. Run against an explicit patch file

Use `--diff-file` when a CI job, precomputed patch, or review workflow already has a unified diff:

```bash
npm run lint -- --repo-root /path/to/repo --diff-file /tmp/changes.patch
```

This bypasses the default git-diff discovery path.

## 5. Example GitHub Actions job

Minimal workflow snippet:

```yaml
name: agent-instruction-lint

on:
  pull_request:
  push:
    branches: [develop, main]

jobs:
  lint-agent-instructions:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Typecheck
        run: npm run typecheck

      - name: Test
        run: npm test

      - name: Lint agent instruction docs
        run: npm run lint -- --repo-root .
```

## 6. Example PR-only explicit patch flow

If you want the linter to run only on the PR patch instead of all local git changes:

```yaml
      - name: Build PR patch
        run: |
          git diff --no-ext-diff --unified=0 origin/${{ github.base_ref }}...HEAD > changes.patch

      - name: Lint agent instruction docs from patch
        run: npm run lint -- --repo-root . --diff-file changes.patch
```

## 7. Failure behavior to expect

The CLI uses these exit codes:
- `0` = no findings
- `1` = findings emitted
- `2` = config/runtime/CLI error

Path-based operator errors are explicit. Examples:
- `Config file not found: /repo/agent-instruction-lint.json`
- `Invalid JSON in config at /repo/agent-instruction-lint.json: ...`
- `Diff file not found: /tmp/changes.patch`

## 8. Recommended adoption order

For a fresh repository, start here:
1. `LINK001`
2. `CITE001` and `CITE005`
3. `CITE002` and `CITE003`
4. `PHRASE001`
5. topology/bootstrap rules

That keeps early adoption focused on deterministic, explainable findings before wider controller-topology enforcement.
