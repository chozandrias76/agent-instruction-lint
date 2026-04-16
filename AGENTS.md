# Agent Instructions

This repository exists to build deterministic, non-LLM tooling for AGENTS/controller markdown.

## Scope

- Build static checks for instruction-topology problems such as duplicated authority, precedence overlap, bootstrap/read-order cycles, and nested AGENTS redundancy.
- Enforce citation-backed behavioral changes for instruction files, modeled after Gort's citation workflow.

## Workflow

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Start with `bd prime --full` for workflow context when needed.
- Keep repository instructions concise; prefer companion rationale/citation logs over bloated inline policy prose.
- Significant behavioral changes to AGENTS/controller docs should include supporting citation-log updates or equivalent provenance notes.

## Guardrails

- Never use `git push` from this workspace unless the user explicitly asks for it.
- Prefer `bd` comments for handoff/progress evidence.
- Keep this file short; project-specific rationale should live outside this file.
