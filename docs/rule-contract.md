# Deterministic rule contract for AGENTS/controller linting

This document defines the initial static rule contract for `agent-instruction-lint`.

The linter is intentionally **deterministic** and **non-LLM**. It operates on Markdown files, explicit repository config, local links, and git diffs. It does **not** infer intent from prose beyond explicit, checkable heuristics.

## Design goals

- Catch instruction-topology bugs before they reach runtime.
- Enforce a narrow, explainable rule set with stable outputs.
- Model citation-backed behavioral changes after Gort's workflow.
- Keep instruction-loading semantics explicit instead of assuming one universal `AGENTS.md` model.
- Prefer explicit false-negative boundaries over fuzzy false positives.

## Repository contract

A repository may declare one or more of these document roles in config:

- **root controller**: canonical instruction file for a repo or controller pack
- **scoped controller**: narrower instruction file for a subtree, mode, state, or specialized context
- **maintainer guide**: write/edit workflow guidance for controller maintainers
- **consumer guide**: read-only or consumer-facing usage guidance
- **citation log**: evidence log that justifies behavioral edits to protected controller files
- **eval companion**: scenario or regression guidance used to validate behavior changes
- **supporting docs**: README/rationale/index files linked from the surfaces above

The linter should treat file roles as **explicit configuration**, not guessed semantics.

## Instruction-loading model

Instruction discovery and precedence are tool-specific. The linter must not assume one universal `AGENTS.md` behavior.

A repository may therefore declare an **instruction model** in config, including:

- discovery root behavior
- whether parent→child chaining is expected
- whether override filenames are supported
- allowed fallback filenames
- whether scoped sections such as model/tool-specific headings exist

First-pass implementation does **not** need to fully lint every discovery model. But the contract must be designed around a declared model rather than a baked-in assumption.

## Deterministic inputs

The first implementation pass should only rely on:

1. repository file paths
2. Markdown headings, lists, links, and inline code spans
3. explicit rule phrases and normative keywords
4. declared roles / discovery / citation configuration
5. git diff hunks for changed files
6. existence/readability of linked local evidence paths
7. unified-diff hunk line numbers when findings come from changed lines

## Deterministic outputs

Each finding must include:

- stable rule id, e.g. `TOPO001`
- severity: `error`, `warning`, or `note`
- file path
- line range when available
- short message
- deterministic evidence snippet or target path
- suggested fix text when a mechanical fix is possible

Implementation should prefer **parser-backed findings** with line/range/context where practical.
When a rule is diff-driven, use unified-diff hunk positions to report changed-line numbers where practical. If the deterministic matcher can locate an exact in-line span, emit a column as well.
Findings should also be emitted in a stable review order, preferring file path first and then line/column when available before rule/evidence tie-breakers.

No finding may depend on model judgment, semantic similarity, or LLM summarization.

## Behavioral-change boundary

The linter must distinguish **behavioral** controller changes from editorial changes.

A changed line is treated as **behavioral** when it is in a configured protected controller file and any of the following hold:

- it contains a normative keyword such as `must`, `must not`, `never`, `always`, `only`, `required`, `forbidden`, `canonical`, `exact`, `hard block`, or `do not`
- it appears inside a heading or bullet that declares procedure, precedence, routing, bootstrap order, approval policy, stop conditions, or output format
- it changes a literal command, literal required phrase, state label, or ordered step sequence
- it changes a link to the canonical citation/evidence target for protected files

A changed line is treated as **non-behavioral** by default when it only changes spelling, punctuation, formatting, wrapping, or purely descriptive prose outside protected rule regions.

This bias is intentional: uncertain cases should default to "not proven behavioral" until a new deterministic heuristic is added.

## Citation-backed change contract

Modeled after Gort, the linter should support a repository configuration that declares:

- protected controller files
- the citation log path
- the entry docs that define or enforce the citation contract
- allowed structural markers for new citation entries
- optional companion rationale/eval files

When enabled, the following rules apply.

### `CITE001` — protected behavioral edits require citation-log updates

If a git diff contains a behavioral change in any protected controller file, the same diff must also modify the configured citation log.

Failure condition:
- behavioral controller diff exists
- citation log file is unchanged

### `CITE002` — citation entries must name updated protected files

A changed citation-log entry must include local links or explicit file mentions for every protected controller file changed in the diff.
In v1, treat these references mechanically via parser-backed Markdown links, inline code spans, and bare `.md` path tokens; substring lookalikes such as `gort.md.bak` do not count.
Ignorable query/fragment suffixes on qualifying local `.md` references should not prevent these references from counting.
Markdown image embeds should not satisfy this rule by themselves.

Failure condition:
- protected file changed
- citation log changed
- no matching file reference for that protected file appears in the added citation entry block

### `CITE003` — citation entries must include required evidence structure

Each new citation entry must contain these structural parts:

- a date/title heading
- a configured local-evidence marker such as `Local evidence`
- an updated-files marker such as `Updated files`
- at least one configured rationale marker, such as:
  - `Why this evidence supports ...`
  - `Why these sources support ...`

A repository may also configure optional markers, such as `Primary supporting sources`.

Failure condition:
- citation log changed
- added entry block lacks one or more required structural marker groups

In v1, identify added citation-entry blocks from newly added entry headings (for example `## 2026-04-16 — ...` or an equivalent setext H2) rather than arbitrary added preamble text before the first new entry.

### `CITE004` — local evidence links must resolve

All added local artifact links in citation entries must resolve to an existing path, unless the repository config explicitly allows external-only evidence for that rule family.

Failure condition:
- added local file link does not exist at lint time
- added local Markdown evidence link points at a heading fragment that does not exist

First-pass implementation may validate this offline against the repository working tree using parser-backed Markdown link extraction from newly added citation-entry blocks.
That parser-backed extraction should include both inline and reference-style Markdown links/images.
For local evidence in v1, allow normal relative repo paths as well as explicit local filesystem paths such as `/tmp/...`, `~/...`, and `file:///tmp/...`.
Percent-encoded local path segments such as `./docs/My%20Guide.md` should resolve to the corresponding filesystem path in v1.
Ignorable local query strings such as `./docs/reference.md?raw=1#section` should not prevent normal file/fragment resolution in v1.

### `CITE005` — citation-contract entry docs must point at the citation log

Each configured **citation-contract entry doc** should contain a local link or explicit rule pointing to the repository's citation log.
As with `CITE002`, treat qualifying references mechanically via resolvable Markdown links, inline code spans, and bare `.md` path tokens rather than substring matches.
Markdown image embeds should not satisfy this rule by themselves.

Typical entry docs include:

- the root controller
- maintainer/write guidance
- root README or equivalent entry doc

This rule should **not** assume every protected leaf file must link directly to the citation log.

Failure condition:
- a configured citation-contract entry doc lacks a citation-log reference

## Instruction-topology contract

### `TOPO001` — duplicate authority declarations in overlapping scope

Flag two controller files when both claim canonical/root authority for the same scope without an explicit precedence relation.

Deterministic evidence:
- same declared scope or nested scope overlap
- both contain authority markers such as `canonical`, `authoritative`, `root`, or `entrypoint`
- no explicit override/supplement relationship is declared on the claim line or its immediate local context
- markers found only inside parsed Markdown code blocks do not count as active claims in v1
- nearby precedence/supplement language inside parsed Markdown code blocks does not resolve an active claim in v1

### `TOPO002` — conflicting precedence statements

Flag when two linked controller files define incompatible precedence rules for the same scope, such as both saying they win on conflict.

First-pass scope comparison should be mechanical and local:
- use the claim line plus immediate local context
- include nearby Markdown headings when present, using parsed Markdown heading structure rather than ATX-only line regexes when practical
- when heading ancestry matters, use the active parsed heading stack for the claim location rather than naively taking the last few headings from sibling sections
- treat explicit provider/startup-surface markers such as `Codex`, `Zeph`, `Mux`, `OpenAI`, or `Claude` as separate scopes
- treat structured scoped headings such as `Model: ...`, `Tool: ...`, `Provider: ...`, or `Surface: ...` as first-class local scope markers
- do not flag when both claims have explicit but disjoint scope markers
- if neither claim has explicit scope markers, treat them as potentially overlapping in v1
- if one claim is broad and the other is explicitly scoped, treat them as potentially overlapping in v1 unless a local precedence/supplement rule resolves the relation

### `TOPO003` — nested controller redundancy

Flag when a nested/scoped controller repeats the same exact normalized normative line from a root/ancestor controller.

This duplicate check is boundary-sensitive: explicit parent/scope context matters, similar to sibling-vs-different-nesting distinctions in mature Markdown duplicate-heading rules.
Disjoint explicit local scopes should not produce a duplicate finding in v1 even when the normalized normative line text matches exactly.

First-pass normalization should be mechanical:
- lowercase
- strip Markdown heading/list prefixes
- strip inline-code backticks
- collapse punctuation to spaces
- trim/collapse whitespace

Only compare candidate normative/procedural lines outside parsed Markdown code blocks.
Future refinement, if needed, should narrow by explicit controller family/parent context before introducing any fuzzier matching.
Do not use semantic embeddings or fuzzy similarity thresholds in v1.

### `BOOT001` — bootstrap/read-order cycle

Flag an explicit read/follow/load chain that can cycle back to an earlier controller file without a stated terminal condition.

As with bootstrap-entrypoint conflicts, cycle detection should respect explicit local startup-surface/scope markers; edges that exist only across disjoint explicit scopes should not form a cycle in v1.
If one edge is broad and another is explicitly scoped, treat them as potentially overlapping in v1 unless a local rule narrows the scope.

First-pass edge extraction should prefer explicit file references in this order:
1. parser-backed Markdown hyperlinks/reference links (not images)
2. parser-backed inline code spans
3. bare `.md` path tokens, including deterministic local query/fragment suffixes when present

These explicit references may include relative paths such as `../gort.md`.
References that appear only inside parsed Markdown code blocks do not create graph edges in v1.
Plain prose mentions without a resolvable Markdown-style file reference should not create graph edges in v1.

### `BOOT002` — ambiguous bootstrap entrypoint

Flag when more than one file claims to be the first required read for the same startup surface and no local precedence rule resolves the ambiguity.

As with `TOPO002`, compare startup-surface markers from the claim line and nearby heading context before flagging; disjoint explicit surfaces should not conflict in v1. Structured headings such as `Model: ...`, `Tool: ...`, `Provider: ...`, and `Surface: ...` are first-class local scope markers here as well, and parsed heading context should include non-ATX forms such as setext headings when practical.

## Phrase contract

### `PHRASE001` — canonical phrase drift

For configured canonical phrases, flag additions or replacements that violate an explicit phrase policy.

The policy should be allowlist/denylist based, for example:

- **canonical emitted form**: the exact phrase required in docs/examples/output templates
- **recognized compatibility forms**: exact variants allowed for recognition only
- **forbidden emitted forms**: exact variants that must not appear in emitted docs/examples when canonical output is required

This rule is **exact-string and allowlist/denylist based**, not fuzzy semantic matching.
In v1, treat forbidden emitted forms as literal phrase occurrences rather than substring lookalikes embedded inside larger slugs/tokens.

## Link contract

### `LINK001` — broken controller/rationale/evidence links

Flag local Markdown links from controllers, maintainer guides, citation logs, and related rationale docs that do not resolve.

First pass should prefer offline local resolution only, including inline or reference-style Markdown links/images and explicit local filesystem paths when the Markdown link targets `/tmp/...`, `~/...`, `file:///tmp/...`, another absolute local path, a percent-encoded local path such as `./docs/My%20Guide.md`, or a local path with an ignorable query string such as `./docs/reference.md?raw=1#section`.

## Protected-region heuristics

To keep the contract deterministic, repositories may optionally mark protected rule regions with one of:

- heading allowlists
- file-level protection
- HTML comments such as `<!-- lint:protected-rule-region -->`
- config-declared path globs

If no region markers exist, the first pass should use file-level protection for configured controller files.

## Initial config shape

A minimal config can live in `agent-instruction-lint.json`:

```json
{
  "$schema": "./agent-instruction-lint.schema.json",
  "instructionModel": {
    "name": "codex-like",
    "chainFromRootToCwd": true,
    "overrideFiles": ["AGENTS.override.md"],
    "baseFiles": ["AGENTS.md"],
    "fallbackFiles": []
  },
  "roles": {
    "rootControllers": ["gort.md"],
    "scopedControllers": ["states/*.md", "modes/*.md", "context-compaction.md"],
    "maintainerGuides": ["docs/editing-gort-write.md"],
    "consumerGuides": ["docs/using-gort-readonly.md"],
    "citationLogs": ["gort.citations.md"],
    "evalCompanions": ["EVALS.md"],
    "supportingDocs": ["README.md", "oversight-modes.md"]
  },
  "citation": {
    "protected": ["gort.md", "states/*.md", "modes/*.md", "context-compaction.md"],
    "log": "gort.citations.md",
    "entryDocs": ["gort.md", "README.md", "docs/editing-gort-write.md"],
    "requiredMarkers": {
      "localEvidence": ["Local evidence"],
      "updatedFiles": ["Updated files"],
      "rationale": [
        "Why this evidence supports",
        "Why these sources support"
      ]
    },
    "optionalMarkers": {
      "supportingSources": ["Primary supporting sources"]
    }
  },
  "phrases": {
    "canonical": [
      {
        "value": "KLAATU BERADA NIKTO",
        "recognizedVariants": ["Klatu Berata Nicto"],
        "forbiddenEmittedForms": [
          "Gort mode",
          "KLAATU BARATA NIKTO"
        ]
      }
    ]
  }
}
```

## Non-goals for the first pass

- no LLM classification of prose intent
- no semantic paraphrase detection beyond exact/normalized matching
- no automatic claim that a citation is high quality, only that the required structure exists
- no universal built-in AGENTS discovery assumptions across all tools
- no global workspace crawl by default; lint only configured paths or explicit targets
- no runtime or hot-reload validation of instruction-file watchers/loaders

## Recommended implementation order

1. `LINK001`
2. `CITE001` and `CITE005`
3. `CITE002` and `CITE003`
4. `PHRASE001`
5. `TOPO001` and `BOOT002`
6. `TOPO002`, `TOPO003`, and `BOOT001`

## Why this contract is narrow

This repository should earn precision before breadth. The goal is a small set of rules that can explain every result with file paths, line ranges, and plain deterministic evidence.
