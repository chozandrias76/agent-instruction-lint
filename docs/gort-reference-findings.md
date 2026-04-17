# Gort reference findings for deterministic lint design

This note captures the concrete, checkable patterns observed in `/home/choza/projects/gort` after a targeted investigation.

The goal is not to copy Gort wholesale. The goal is to identify which parts of Gort's maintainer workflow and controller topology can be linted **deterministically**.

## Why Gort is the right first reference

Gort already expresses several things this linter cares about in explicit Markdown rather than implicit team memory:

- canonical/root authority
- scoped companion files
- explicit bootstrap/read-order rules
- explicit boundary statements about execution root vs shared controller logic
- a structured citation log for behavioral changes
- a scenario-oriented eval document tied to concrete artifacts

That makes it a strong seed corpus for a deterministic linter.

## Files inspected

- `/home/choza/projects/gort/AGENTS.md`
- `/home/choza/projects/gort/README.md`
- `/home/choza/projects/gort/gort.md`
- `/home/choza/projects/gort/gort.citations.md`
- `/home/choza/projects/gort/EVALS.md`
- `/home/choza/projects/gort/context-compaction.md`
- `/home/choza/projects/gort/oversight-modes.md`
- `/home/choza/projects/gort/docs/editing-gort-write.md`
- `/home/choza/projects/gort/docs/using-gort-readonly.md`
- `/home/choza/projects/gort/states/berada.md`
- `/home/choza/projects/gort/states/klaatu.md`

## Observed file-role topology

Gort splits responsibilities across distinct file roles:

| Role | Gort example | Deterministic signal |
|---|---|---|
| repo-level guidance | `AGENTS.md` | repo scope, consumer-vs-maintainer split, boundary statements |
| canonical controller root | `gort.md` | says to start here; says root file wins on conflict |
| scoped executable controllers | `states/*.md`, `modes/*.md`, `context-compaction.md` | narrower state/mode procedures |
| maintainer workflow guide | `docs/editing-gort-write.md` | pre-edit proof gate, required evidence, citation updates |
| consumer/read-only guide | `docs/using-gort-readonly.md` | execution-root and entrypoint rules |
| citation log | `gort.citations.md` | dated evidence entries with repeated structure |
| eval/rationale companion | `EVALS.md` | scenario-based proof expectations |
| index/split note | `oversight-modes.md` | explains why behavior is split into dedicated files |

This is important for the linter because several rule families depend on file role, not just file name.

## Deterministic patterns already visible in Gort

### 1. Protected behavioral files are explicitly named

Gort repeatedly names the behavioral files that require higher scrutiny:

- `gort.md`
- `context-compaction.md`
- `states/*.md`
- sometimes `modes/*.md` in maintainer guidance

This supports a config-driven `protected` glob list rather than heuristic repository crawling.

### 2. Citation-backed edits are a real contract, not a loose suggestion

The pattern appears in multiple places:

- `gort.md` says edits to root/state/compaction behavior must add or update supporting citations.
- `README.md` says changes to protected prompt files must be backed by citations in `gort.citations.md`.
- `docs/editing-gort-write.md` says updating protected files requires updating `gort.citations.md`.
- `gort.citations.md` itself says not to change Gort without citations and evidence.

This strongly supports these deterministic rules:

- protected behavioral diff requires citation-log diff
- citation-contract entry docs should point to the citation contract
- citation log can be treated as a required companion file

### 3. Citation entries follow a mostly regular template

The recurring entry structure in `gort.citations.md` is:

1. dated heading
2. `### Local evidence`
3. bullet list of artifacts / trace notes
4. `- Updated files: ...`
5. either:
   - `### Primary supporting sources` plus cited links, then rationale text
   - or `### Why this evidence supports the repair` / similar rationale heading directly

The key deterministic markers appear often enough to lint:

- `Local evidence`
- `Updated files`
- `Primary supporting sources` (optional but common)
- `Why this evidence supports ...` (common rationale form)

What is **not** deterministic enough yet:

- judging whether evidence quality is actually good
- judging whether the cited external source truly supports the change

So the first pass should check structure and link presence, not epistemic quality.

### 4. Gort has explicit authority and precedence language

Observed authority/precedence markers include phrases such as:

- `canonical`
- `authoritative`
- `root`
- `entrypoint`
- `execution root`
- `This root file wins`
- `Start with ...`
- `Load exactly one mode file`

This supports a phrase-based topology parser that detects:

- multiple files claiming canonical/root authority
- unresolved bootstrap entrypoints
- conflicting precedence statements
- mutually exclusive mode loading requirements

### 5. Gort distinguishes execution-root authority from shared-controller authority

A repeated boundary in Gort is:

- consumer repo remains authoritative for execution/runtime state
- Gort repo is shared controller logic only
- reading Gort does not transfer Beads/worktree authority to the Gort repo

This matters because some topology problems are really **authority-scope** problems, not just duplicate wording.

Potential deterministic rule surface:

- flag files that simultaneously claim shared-controller status and execution-root authority for the same scope without an explicit split
- flag controller docs that say another repo remains authoritative while also instructing mutation of the shared-controller repo's runtime state

### 6. Bootstrap order is explicit enough to lint

Gort repeatedly encodes ordered startup requirements, including:

- first grounding read from authoritative active-repo `AGENTS.md`
- then read `gort.md`
- later load only the state/mode files required by the root contract
- exactly one mode file active at a time

This supports deterministic checks for:

- ambiguous first-read claims
- cycles in explicit `read` / `load` / `start with` chains
- contradictory "load exactly one" versus "always load both" instructions

For a safe first pass, those bootstrap edges should come from explicit Markdown-style file references rather than fuzzy prose alone.

### 7. Canonical phrase policy is explicit enough to lint

Gort uses a strong canonical-phrase pattern:

- recognition may accept compatibility variants
- docs/examples should still emit the canonical form

That is ideal for a deterministic linter because it can be config-backed and exact-string driven.

### 8. Gort separates behavior from runtime-boundary disclaimers

Gort repeatedly states that the repo is Markdown-only and should not patch Pi runtime code.

This suggests a later rule family around **boundary drift**, but that should probably be a later pass. It is easy to overreach here.

### 9. EVALS.md is a companion proof surface, not just nice-to-have prose

`docs/editing-gort-write.md` and `README.md` both point maintainers at `EVALS.md` for scenario-based validation.

This suggests a later deterministic rule family:

- protected behavioral repos may require a configured eval companion link from maintainer docs or root docs

But this should be later than citation/log/link rules.

## Marker lexicon worth encoding

These observed phrases are strong candidates for deterministic lexicons.

### Authority / precedence markers

- `canonical`
- `authoritative`
- `execution root`
- `root file`
- `entrypoint`
- `start with`
- `wins`
- `remains authoritative`
- `only as a fallback`

### Bootstrap / read-order markers

- `first grounding read`
- `second visible controller action`
- `read`
- `load`
- `start with`
- `after bootstrap`
- `before changing`
- `load exactly one mode file`

### Citation markers

- `Local evidence`
- `Updated files`
- `Primary supporting sources`
- `Why this evidence supports`
- `Do not change ... without citations`
- `supporting evidence`

### Canonical phrase markers

- `canonical`
- `recognition should be case-insensitive`
- `compatibility`
- `docs/examples should always use the canonical form`

## Recommended first-pass rules, now better grounded

After this investigation, the most justified first-pass rules still look like:

1. `LINK001` — broken local Markdown links in controllers/citation logs
2. `CITE001` — protected behavioral edits require citation-log update
3. `CITE005` — citation-contract entry docs must point to the citation contract
4. `CITE002` — citation entry names the updated protected files
5. `CITE003` — citation entry contains the required structure
6. `PHRASE001` — canonical phrase drift in user-facing docs/examples
7. `TOPO001` — duplicate authority claims in overlapping scope
8. `BOOT002` — ambiguous bootstrap entrypoint

These are the rules with the strongest observed support and the cleanest deterministic evidence model from the Gort corpus alone.

Later readonly hardening from broader tool documentation can justify expanding the topology slice to exact-normalized nested redundancy and explicit bootstrap graphing, but the Gort-first evidence already strongly supports the scope/authority/bootstrap core above.

## Rule candidates to defer until after the first vertical slice

These look valuable, but the investigation says they should wait:

- validate that an evidence artifact is sufficiently persuasive
- validate that external sources semantically justify the change
- validate real scenario coverage quality from `EVALS.md`
- infer file roles from prose alone without config support
- broad contradiction detection across long natural-language paragraphs
- generalized semantic paraphrase detection for nested-controller redundancy
- semantic scope inference beyond explicit local markers/headings
- bootstrap graph edges derived from non-resolvable prose mentions

## Concrete parser implications

The Gort investigation suggests the implementation should parse at least:

- headings
- bullet lists
- inline code spans
- local Markdown links
- changed file paths from git diff
- small phrase lexicons for authority/bootstrap/citation markers
- nearby local heading context for scope-aware claim comparison
- explicit Markdown-style file references for bootstrap/read-order edges
- parsed Markdown code-block boundaries so examples do not create active claims or graph edges

It does **not** yet require:

- semantic embeddings
- LLM classification
- full natural-language contradiction solving

## Practical implementation takeaway

Turn these findings into narrow deterministic slices, in this order:

- load config instead of inferring instruction-loading semantics from prose alone
- detect protected files and citation-contract boundaries
- classify changed lines with a deterministic behavioral heuristic
- require citation-log update when protected behavioral changes occur
- resolve links and citation markers in the changed citation entry block
- validate local evidence paths offline and match protected-file / citation-log references mechanically rather than by substring lookalikes
- compare authority/bootstrap claims using local context and nearby headings rather than whole-file heuristics
- build bootstrap/read-order edges only from explicit Markdown-style file references

That keeps the implementation grounded in the Gort reference corpus while leaving semantic contradiction solving and paraphrase detection out of scope for v1.
