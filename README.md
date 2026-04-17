# agent-instruction-lint

Deterministic tooling for linting AGENTS/controller markdown without requiring a live LLM.

## Goal

Build a static analyzer that can run on save, in CI, or on a cron schedule to detect:
- duplicated authority and precedence ownership
- bootstrap/read-order overlap and loop risks
- parent/child AGENTS redundancy
- canonical phrase drift
- citation coverage gaps for behavioral instruction changes
- broken evidence and rationale links

## Initial focus

Use Gort as the reference implementation for citation-backed instruction changes, then generalize those rules to other AGENTS/controller docs.

See [`docs/rule-contract.md`](./docs/rule-contract.md) for the deterministic rule contract, including the behavioral-change boundary, Gort-style citation requirements, local scope-comparison rules, and explicit bootstrap-edge rules.

See [`docs/gort-reference-findings.md`](./docs/gort-reference-findings.md) for the deeper targeted investigation of Gort as the first reference corpus.

See [`docs/web-reference-findings.md`](./docs/web-reference-findings.md) for the external research that hardened the contract around instruction-loading models, structured scoped headings, exact-normalized redundancy checks, and explicit graph edges.

A draft config schema now lives at [`agent-instruction-lint.schema.json`](./agent-instruction-lint.schema.json).

See [`docs/setup-and-ci-examples.md`](./docs/setup-and-ci-examples.md) for a practical adoption guide with a sample config, local invocation patterns, and GitHub Actions snippets.

## Usage

Run the linter against a repository config:

```bash
npm run lint -- --repo-root /path/to/repo
```

To build an installable CLI tarball locally:

```bash
npm run build
npm pack
```

You can smoke-install that tarball into a fresh temp project with:

```bash
tmpdir="$(mktemp -d)"
cd "$tmpdir"
npm init -y >/dev/null
npm install /path/to/agent-instruction-lint-0.1.0.tgz
./node_modules/.bin/agent-instruction-lint --help
```

The packaged binary entrypoint is `agent-instruction-lint`.

Text output includes location, rule id, evidence, and suggestion for each finding.
JSON output is available for CI and scripted use:

```bash
npm run lint -- --repo-root /path/to/repo --format json
```

Optional flags:
- `--config <path>` to use a non-default config path relative to `--repo-root`
- `--diff-file <path>` to lint against a supplied unified diff instead of the default combined staged+unstaged+untracked git diff
- `--version` to print the packaged CLI version

A more complete setup/config/CI example now lives in [`docs/setup-and-ci-examples.md`](./docs/setup-and-ci-examples.md).

Exit codes:
- `0` = no findings
- `1` = findings emitted
- `2` = CLI/config/runtime error

When config loading fails, the CLI reports explicit path-based errors for missing config files, invalid JSON, or schema validation failures. Missing `--diff-file` targets are reported the same way.

A GitHub Actions workflow now lives at `.github/workflows/ci.yml` and runs typecheck, tests, build, built-CLI smoke, and `npm pack` on pushes/PRs.

## Current contract shape

The project currently assumes:
- instruction loading is tool-specific and must be declared in config rather than guessed
- topology conflicts are checked from the claim line plus immediate local context and nearby headings
- structured headings such as `Model: ...`, `Tool: ...`, `Provider: ...`, and `Surface: ...` are first-class local scope markers
- broad-vs-scoped claims are treated as potentially overlapping unless a local precedence/supplement rule resolves them
- nested-controller redundancy is exact-normalized, boundary-sensitive, and non-semantic in v1, including suppression for disjoint explicit local scopes
- parsed Markdown code examples do not create active claims or bootstrap graph edges in v1
- bootstrap/read-order graph edges come from explicit Markdown-style file references, not fuzzy prose mentions
- added citation-log entries validate local evidence links offline so missing artifact paths and broken Markdown heading fragments are caught deterministically, including reference-style Markdown links/images, percent-encoded local paths, malformed percent-encoding fallback, local links with ignorable query strings, and explicit local filesystem paths such as `/tmp/...`, `~/...`, and `file:///tmp/...`
- diff-driven findings report changed-line numbers when unified diff hunk positions make that possible, and exact literal-match rules can also emit columns
- bootstrap cycles and overlaps respect explicit local scope markers rather than merging disjoint provider/model/tool surfaces, while still treating broad and explicitly scoped chains as potentially overlapping in v1

## Tracking

This repo uses `bd` for issue tracking.
