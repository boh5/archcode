---
name: execute-plan
description: Execute the existing Plan for Todo Start Work in an ordinary Lead Session, then let the user decide whether to create a Goal before implementation.
license: MIT
metadata:
  archcode/source: "Superpowers executing-plans concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

## Load and authorize

1. Read the Plan at the exact path supplied by the Start Work request before taking any implementation action. Do not search for or substitute another Plan.
2. Compare it with the current repository state. Confirm that its goal, scope, ordered steps, dependencies, interfaces, acceptance criteria, validation, risks, and unresolved decisions are still executable.
3. Stop before implementation when a critical instruction is ambiguous, an assumption is stale, a required dependency is missing, the Plan conflicts with current code or user intent, or the evidence cannot decide a material product choice. Explain the concrete gap and ask one focused question; do not guess through it.
4. Draft a Goal objective from the Plan's goal and observable acceptance criteria. Do not put the Plan path, content, summary, hash, version, or other Plan linkage into Goal state.
5. Use `ask_user` to explicitly ask whether to create that Goal. Create it with only the agreed objective when the user clearly agrees; if the user declines, continue as an ordinary Lead Session. Do not infer consent or delay this choice until after implementation starts.

## Execute in reviewable increments

For a compact checkpoint card at each Plan boundary, read [references/execution-checkpoints.md](references/execution-checkpoints.md).

1. Convert the ordered Plan into the current execution sequence. Respect prerequisites and use `orchestrate-work` for any bounded delegation; parallelize only Plan steps that remain independent in the current repository.
2. For each deliverable, inspect the baseline, make the smallest coherent change, and run the specified narrow verification. Read the full result before advancing.
3. At each dependency boundary, reconcile child work and recheck interfaces, callers, shared state, and the current diff. A child report or an isolated passing test does not establish integrated correctness.
4. If implementation reveals a minor local detail that preserves the Plan's objective and scope, record the deviation in the final report and continue. If it changes architecture, scope, acceptance, dependency order, safety, or user-visible behavior, stop and obtain a decision before proceeding.
5. If verification fails, diagnose the failure instead of marking the step complete. Stop and ask when repeated attempts do not produce new evidence, an external prerequisite is required, or the Plan must be reconsidered.

## Completion gate

After implementation:

1. Re-read the Plan and check every acceptance criterion and non-goal against the final attributable changes.
2. Run fresh, proportionate verification for the integrated result, including repository-required broader checks. Do not infer build success from lint, behavioral correctness from typecheck, or overall completion from one passing subsystem.
3. Inspect complete output and exit status. Claim only what that evidence proves; identify skipped or unavailable checks and their impact.
4. If a Goal was created, finish only through `run-goal`, including terminal children, independent fresh `goal-review`, remediation, and `update_goal`. Do not create a second Review flow for the Plan.
5. Otherwise, report the delivered outcome, material Plan deviations, files or behavior changed, exact verification results, and residual risk as an ordinary Lead Session.

Treat the Plan as ordinary Markdown, not execution state. Do not add a Plan service, status, version, lock, snapshot, watcher, Goal link, or completion mirror. During an active Goal, discuss Plan changes only when the user explicitly reports or requests them in this Lead Session; the established Goal objective and acceptance criteria continue unless the user separately changes the Goal. Never claim automatic Plan detection, synchronization, or restart.
