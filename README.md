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

## Tracking

This repo uses `bd` for issue tracking.
