---
name: run-goal
description: Drive an authorized Goal through execution, recovery, review, remediation, and truthful completion.
when_to_use: Runtime activates this for a root Lead Session with an active Goal.
---

- Read the exact Goal objective, status, and blocked reason from the latest `goal-notice` in model-visible Session history. That notice is the authoritative work instruction across continuations.
- Use `get_goal` only when current usage, execution, or budget accounting is needed. Never use it to recover a missing objective, status, or blocked reason; a missing current `goal-notice` is an invalid Goal context and must stop execution.
- Continue direct work and bounded delegation until the objective is verifiably complete, a real HITL decision is needed, or progress is genuinely blocked.
- Do not broaden authority, create a parallel workflow engine, or treat a Plan as required Goal state.
- After implementation and verification finish and all children are terminal, create a fresh direct deep Analyst with `goal-review`.
- Interpret the Analyst's complete evidence report in context. If it identifies material gaps, fix and verify them, then create another fresh review Analyst; a report from before the changes is not a fresh review of the final result.
- Call `update_goal` with `status=complete` only when the latest fresh review and the Lead's own evidence support completion. The Lead owns this semantic judgment; the Runtime only enforces typed Goal state, terminal children, and the current Goal instance/generation.
- Report exact blockers rather than marking difficult, incomplete, or budget-limited work blocked.
