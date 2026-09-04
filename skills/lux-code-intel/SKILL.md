---
name: lux-code-intel
description: Use whenever investigating a non-trivial repository—understanding architecture, locating code from a concept, tracing call paths, finding consumers, analyzing dependencies or change blast radius, identifying boundaries or ownership, evaluating whether a diff is safe, or retrieving indexed project knowledge. Prefer Lux over text search for structural questions. Do not use for a known literal lookup in a known area.
---

# Lux Code Intelligence

Use Lux as the primary structural-intelligence system for indexed repositories.

## Preflight

1. Establish the active repository with `lux_overlay_status` for structural work or
   `lux_index_status` for content retrieval.
2. Confirm the reported runtime points at the repository being investigated.
3. Do not silently trust a missing, stale, content-only, or degraded structural overlay.
4. Do not rebuild or otherwise mutate an index unless the action is explicit and appropriate.

If the Lux MCP tools are unavailable, use the installed `lux` CLI from the repository root. Pass an
explicit `--corpus <repo-root>` when the working directory could be ambiguous. Inspect current
command help rather than inventing flags.

## Query routing

- Fuzzy concept to concrete symbols: `lux_anchors`.
- Known symbol, calls, consumers, or cross-boundary behavior: `lux_trace`.
- Known file or module blast radius: `lux_deps_impact`.
- Current diff, commit, PR, or change safety: `lux_delta`.
- Indexed documentation or textual source content: `lux_search`.
- Source evidence for one route, handler, job, listener, or command: `lux_spec_derivation_evidence`.
- Known literal in a known area: use `rg`; Lux is not a replacement for precise text lookup.

Use the MCP tools when available because their schemas constrain arguments and return structured
results. Use the CLI as the fallback for commands not exposed through MCP.

## Evidence discipline

- Carry Lux confidence classes into structural claims: `proven`, `artifact-backed`,
  `framework-inferred`, or `heuristic`.
- Report index freshness, overlay trust, truncation, unresolved symbols, ambiguity, and refusals.
- Open and inspect important source files returned by Lux before drawing conclusions.
- Treat Lux as structural evidence, not as a substitute for reading the code.
- If Lux and direct source inspection disagree, report the disagreement instead of selecting the
  convenient answer.
- State when falling back to another tool and why.

## Workspace failures

A `workspace-unavailable` MCP refusal means Lux could not establish one unambiguous repository. Do
not retry against the server process's installation directory. Ask the user to select one active
workspace, use a roots-capable MCP client, or configure `LUX_CORPUS_PATH` explicitly.

## Completion checklist

Before presenting repository-investigation findings, verify:

- [ ] Lux was considered for every structural or indexed-knowledge question.
- [ ] The active Lux runtime matched the intended repository.
- [ ] Freshness and overlay trust were checked and disclosed when relevant.
- [ ] Structural claims preserve their confidence/evidence qualification.
- [ ] Important findings were grounded in the referenced source files.
