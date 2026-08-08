# <Plan title>

## Goal and background

State the intended observable result, why it matters, and the evidence-backed current mechanism. Link the governing Todo or request when one exists; do not invent a Plan ID or runtime state.

## Scope and non-goals

State the ownership boundary, user-visible behavior, data or interfaces that change, and explicit exclusions. Distinguish a deliberate non-goal from deferred required work.

## Current mechanism and constraints

- Entry points and current owner:
- Data/state/event flow:
- Invariants and architecture boundaries:
- Repository conventions and required checks:
- External/version constraints:
- Confirmed user decisions:

Separate verified facts from assumptions. Mark any assumption that would change the design if false.

## Chosen direction

Explain the smallest coherent design, where each responsibility will live, and why it fits existing ownership. Record rejected alternatives only when they expose a real tradeoff. State what this direction deliberately does not build.

## Ordered implementation

For each step include:

1. **Deliverable:** observable result of this step.
2. **Location and owner:** relevant files/symbols and the responsibility being changed.
3. **Concrete change:** types, control flow, state, errors, tests, docs, or cleanup.
4. **Prerequisite / produced interface:** what must exist before and what later steps consume.
5. **Failure and edge paths:** only those material to this boundary.
6. **Decisive verification:** command or inspection, expected signal, and what it does not prove.

## Dependencies and parallel boundaries

State ordering constraints and only genuinely independent work. Shared mutable state, the same interface, overlapping files, or one step consuming another step's output makes work sequential unless an explicit seam removes that dependency.

## Acceptance and validation

| Acceptance condition | Evidence / command | Expected result | Failure or edge case |
| --- | --- | --- | --- |
| <decidable outcome> | <fresh check> | <observable signal> | <case that could falsify it> |

Include repository-required typecheck, unit, integration, architecture, and build lanes only when relevant; do not claim behavioral proof from typecheck alone.

## Risks and decisions

Record likelihood/impact, control, rollback or recovery boundary, and the user decision required. If no decision is required, say why evidence already determines the direction.

## Completion report requirements

Name the artifacts, behavior changes, Plan deviations, verification results, skipped checks, and residual risks the executor must report. Completion means every acceptance row is supported or an explicit unresolved item is returned to the user; file presence or implementation intent is not enough.
