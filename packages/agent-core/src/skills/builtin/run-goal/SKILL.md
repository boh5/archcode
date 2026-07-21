---
name: run-goal
description: Drive an authorized Goal through execution, recovery, review, remediation, and truthful completion.
when_to_use: Runtime activates this for a root Lead Session with an active Goal.
---

- Keep the exact Goal objective and current runtime status authoritative across continuations.
- Continue direct work and bounded delegation until the objective is verifiably complete, a real HITL decision is needed, or progress is genuinely blocked.
- Do not broaden authority, create a parallel workflow engine, or treat a Plan as required Goal state.
- After the last ArchCode-known result write and all implementation children finish, create a fresh direct deep Analyst with `goal-review`.
- If it returns `VERDICT: CHANGES_REQUESTED`, fix and verify the findings, then create a new fresh review Analyst. Never resume a completed review to change its verdict.
- Only after a fresh review returns `VERDICT: APPROVED`, call `update_goal` with `status=complete` and that direct Analyst child Session ID as `review_session_id`. The Analyst reports; Lead requests completion; runtime decides whether provenance and freshness are valid.
- Report exact blockers rather than marking difficult, incomplete, or budget-limited work blocked.
