# Web research findings for deterministic instruction linting

This note records the highest-signal external findings that changed the contract shape for `agent-instruction-lint`.

The purpose is not to outsource the design. The purpose is to reduce avoidable assumptions before implementation starts.

## Sources consulted

- OpenAI Codex AGENTS docs
- Zeph instruction-file docs
- Mux instruction-file docs
- Microsoft Agent-Pex
- Microsoft PromptPex
- SIGPLAN blog: *Prompts are Programs*
- `remark-lint` custom-rule docs
- `markdownlint` custom-rule docs
- `remark-validate-links`
- `xrefcheck`
- `contextlint`

## Findings that affect the contract

### 1. Instruction loading is tool-specific

Different systems load instruction files differently:

- **Codex** uses a root→cwd chain, supports `AGENTS.override.md`, and allows fallback filenames.
- **Zeph** has provider-specific discovery plus universal `zeph.md`, dedupes canonical paths, and enforces project-root boundaries.
- **Mux** layers global/workspace instructions and supports scoped `Model:` and `Tool:` sections with first-match-wins behavior.

Implication:

- the linter must not assume one universal `AGENTS.md` precedence model
- precedence/discovery behavior should be **declared in config**
- ambiguous/contradictory precedence should be linted against the configured model

### 2. Prompts/instructions can be treated as specifications

Agent-Pex and PromptPex both treat prompts/system instructions as sources of checkable rules. The SIGPLAN "Prompts are Programs" piece argues for prompt artifacts being handled more like software artifacts.

Implication:

- controller/instruction Markdown is a legitimate static-analysis target
- rule ids, explicit contracts, and evidence-backed change policies are justified
- future eval-companion rules are reasonable
- v1 should still remain deterministic and non-LLM

### 3. Parser-backed findings are the right implementation shape

`remark-lint`, `markdownlint`, and related tooling all reinforce the same engineering pattern:

- parse Markdown into structure
- produce precise line/range/context diagnostics
- keep rules explicit and composable

Implication:

- avoid a regex-only architecture
- favor parser-backed findings with exact locations
- when heading context matters, prefer parsed heading structure over line-oriented heading regexes when practical
- use active heading ancestry for the claim location rather than naively inheriting sibling heading markers
- ignore examples inside parsed Markdown code blocks when extracting active claims, scope context, or graph edges

A useful nuance from `markdownlint` MD024 is that duplicate-content checks often need explicit boundary controls such as sibling-only or different-nesting allowances.

Implication:

- duplicate controller/redundancy checks should stay scope-aware
- v1 should prefer exact normalized matching with local boundary rules rather than broad semantic duplicate detection

### 4. Local link validation should stay offline-first

`remark-validate-links`, `xrefcheck`, and `contextlint` all reinforce offline local resolution for repo docs.

Implication:

- `LINK001` should be implemented with local path/anchor resolution first
- `CITE004`-style local evidence validation can use the same offline working-tree resolution model for repo artifacts
- do not scope-creep into network-bound URL health for v1

### 5. Structured Markdown linting already has a strong precedent

`contextlint` is especially close in spirit:

- deterministic
- config-first
- rule-based
- CI-friendly
- cross-file integrity focused
- graph validation for circular references and structural document health

Implication:

- the repo should lean into a rule registry, JSON-friendly findings, and scoped file globs
- bootstrap/read-order rules are well justified when they operate on explicit graph edges rather than semantic guesses

## Contract changes justified by the web research

- add explicit `instructionModel` config
- keep roles explicit in config
- narrow `CITE005` to citation-contract entry docs, not every protected leaf file
- validate `CITE004` local evidence links offline against the working tree
- make `CITE002`/`CITE005` file-reference matching mechanical (Markdown links, inline code spans, bare `.md` path tokens) rather than substring-based
- make `CITE003` marker groups configurable
- make `PHRASE001` exact allowlist/denylist based
- keep parser-backed `LINK`/`CITE`/`PHRASE`/topology rules in the first slice
- treat structured scoped headings such as `Model:` / `Tool:` as first-class local scope markers for topology conflicts
- keep topology overlap checks local: claim line + immediate context + nearby headings
- keep redundancy detection exact-normalized rather than semantic, with scope/boundary narrowing before any future fuzzier matching
- treat duplicate/redundancy checks as boundary-sensitive in the same spirit as markdownlint's sibling/different-nesting nuance
- keep bootstrap graph edges tied to explicit Markdown-style file references rather than fuzzy prose mentions
- prefer parser-backed extraction for inline Markdown links/code spans when practical, with bare path-token matching as a narrower fallback
- ignore duplicate/authority/bootstrap markers that appear only inside parsed Markdown code examples in v1

## What the web research does **not** justify for v1

- universal built-in AGENTS precedence assumptions
- fuzzy semantic phrase matching
- LLM-based classification of whether prose is behavioral
- semantic quality scoring of citations
- runtime watcher/hot-reload validation
- semantic scope inference beyond explicit local markers/headings
- semantic paraphrase detection for nested-controller redundancy
- bootstrap graph edges derived from non-resolvable prose mentions
- duplicate/redundancy rules that ignore explicit scope or parent-boundary context
- claims or graph edges derived only from parsed Markdown code examples

## Execution takeaway

The first implementation slice is still the same general direction, but it should start from the hardened contract:

1. config + schema
2. `LINK001`
3. `CITE001`
4. narrowed `CITE005`
5. `CITE002`
6. flexible-marker `CITE003`
7. exact/normalized topology and bootstrap rules with explicit scope markers and explicit graph edges
