# <Plan title>

## Goal, evidence, and scope

- **Result and why:** <observable result and reason>
- **Verified mechanism:** <only facts that determine the design>
- **In scope / owners:** <changed responsibilities and interfaces>
- **Non-goals:** <explicit exclusions or deliberately unbuilt machinery>

Do not reproduce the request, Todo, research log, or source excerpts. Separate a
verified fact from any assumption that would change the design if false.

## Design and constraints

State the smallest coherent direction, state flow, architecture invariants,
confirmed decisions, and stopping rule. Each fact belongs here or in one step,
not both. Record a rejected alternative only when it exposes a material tradeoff.
For multi-issue work, keep this to a few compact bullets or paragraphs and let
the matrices carry issue-specific detail.

## Ordered implementation

| Step | Owner / location | Change and produced interface | Dependency / material failure control | Decisive check |
| --- | --- | --- | --- | --- |
| S1 | <file, symbol, owner> | <concrete behavior or contract> | <prerequisite and edge control> | <command or observable signal> |

Use the fewest coherent rows. Keep tightly coupled changes in one row and split
only at a real dependency or review boundary. Use one row per issue when IDs are
given, keep every cell to one sentence or compact clause, and do not repeat a row
as prose.

## Dependencies and parallel boundaries

List only cross-step ordering and genuinely independent work by step ID. Shared
state, interfaces, files, fixtures, or validation resources imply sequential work
unless the Plan names a real seam.

## Acceptance and validation

| ID | Starting state and action | Pass / fail boundary | Decisive evidence |
| --- | --- | --- | --- |
| A1 | <observable setup and action> | <exact result; falsifying edge> | <fresh test, command, or inspection> |

Group repository-wide typecheck, unit, integration, architecture, and build
commands once after the behavioral rows. Do not claim behavioral proof from
typecheck or file presence alone. Use step/acceptance IDs instead of restating
implementation details, exclusions, or controls.

## Risks, decisions, and completion report

- **Risk / control:** <likelihood or impact, prevention, rollback boundary>
- **Decision or assumption:** <only unresolved material choice; say why none remain>
- **Completion report:** <changed artifacts, deviations, skipped checks, results,
  and residual risk that the executor must report>

Replace every angle-bracket field. Leave no TODO, TBD, unresolved product choice,
full Todo restatement, large source excerpt, or speculative code block.

When the governing request specifies a document budget, allocate it before
drafting. If exact counting is unavailable, target at most one third of that budget.
Perform one no-write compression review before the final write: every
fact has one home, and IDs carry cross-references. The 12,000-Unicode-character
figure, when recorded, is evidence for the current incident fixture only; it is
not a universal Plan limit or a runtime rejection rule.

The owning Lead or Discussion performs one final atomic write to the one Plan
path after discovery and convergence. Delegated research may supply evidence,
but it must not create competing Plan files or write the final Plan in parallel.
That final write is the last Plan-related Tool action; do not validate an
oversized draft after writing it.
