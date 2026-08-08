---
name: run-goal
description: Drive an authorized Goal through execution, recovery, review, remediation, and truthful completion in a root Lead Session with an active Goal.
license: MIT
metadata:
  archcode/source: "ArchCode Goal lifecycle"
  archcode/source-commit: "f00efe7ab3cd87f951797d9b4bf14415f10abd7a"
  archcode/adaptation: "original rewrite"
---

## Reconstruct the authoritative target

1. Read the exact objective, status, and blocked reason from the latest `goal-notice` in model-visible Session history. The notice is authoritative across continuations.
2. Stop if the current notice is missing or internally unusable; `get_goal` is accounting-only and must not be used to reconstruct semantic Goal state. Use it only when current usage, execution count, elapsed execution time, or token budget is needed.
3. Translate the objective into an internal acceptance map: required outcomes, constraints, observable evidence, likely failure modes, and explicit non-goals. Do not add new Goal state or silently broaden the user's authority.

Keep a compact working ledger in the current reasoning or ordinary work artifacts: one row per obligation with current evidence, `supported` / `partial` / `failed` / `unknown`, and the next decisive action. This is execution bookkeeping, not persisted Goal state, and it must be rebuilt when later evidence invalidates a row.

## Execute and control risk

- Choose direct work or bounded delegation through the ordinary Lead topology. Use Analyst for difficult reasoning or review, Build for bounded implementation, Explore for local evidence, and Librarian for external evidence; no child owns Goal completion.
- Order work by dependency and observable delivery boundary. Parallelize only independent tasks with no shared mutable state, overlapping edits, or sequential contract. Integrate and verify each boundary before advancing.
- At each checkpoint, compare actual state with the acceptance map. Run the narrowest decisive check for the changed behavior, then broader repository checks in proportion to integration risk. Treat stale output, partial output, and child claims as leads rather than proof.
- Record material Plan deviations and failed verification when they occur. Do not reconstruct a clean success narrative at the end or let a later broad pass erase an unresolved narrow failure.
- When evidence invalidates the approach, revise the implementation path without changing the Goal objective. Ask the user when the objective, scope, external authority, destructive action, or an unavailable prerequisite requires a decision.
- Do not create a parallel workflow engine or require a Plan as Goal state. A Plan may guide execution, but it has no Goal linkage or automatic synchronization.

## Stop and blocked decisions

Continue until the objective is verifiably satisfied, a real HITL decision is required, or progress is genuinely blocked.

- Do not mark blocked because work is hard, incomplete, slow, budget-limited, or needs another evidence-producing attempt.
- Mark blocked only when a concrete external condition prevents meaningful progress and safe in-scope alternatives are exhausted. State the exact condition, evidence, impact, and what would unblock it.
- If a child is suspended or non-terminal, resolve, resume, cancel as authorized, or wait as appropriate; do not proceed to Goal completion.

## Verification and independent final review

1. Re-read the Goal objective and acceptance map after implementation. For every completion claim, identify a decisive command, inspection, or artifact; run it fresh and read the complete result and exit status.
2. If verification fails or leaves a material requirement unproven, remediate and rerun the relevant checks. Report the actual incomplete state instead of implying success.
3. After implementation and Lead verification finish and every child in the Session family is terminal, create a fresh direct deep Analyst with `goal-review`. Give it the full objective, attributable final changes, evidence, known limitations, and questions without suggesting the desired verdict.
4. Interpret the Analyst's complete report rather than a label. Fix every material gap, rerun proportionate verification, and create another fresh review Analyst after changes; a report produced before remediation is not a review of the final result.
5. Call `update_goal` with `status=complete` only when the latest fresh review and the Lead's own fresh evidence support every material acceptance condition. The Lead owns this semantic judgment; the Runtime enforces typed Goal state, terminal children, and the current Goal instance and generation.

## Final report

Lead with the achieved outcome or exact blocker. Report the objective checked, material changes, fresh verification commands or inspections and results, independent review conclusion and remediation, skipped or unavailable checks, and residual risk. Never claim completion from confidence, prior runs, a clean diff alone, or a child report.
