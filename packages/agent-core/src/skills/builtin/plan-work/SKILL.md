---
name: plan-work
description: Research and write an evidence-backed implementation Plan without creating a workflow state machine.
when_to_use: Use when uncertainty, sequencing, or risk makes a durable Plan useful, or when the user asks for a plan.
---

- Confirm the objective, constraints, non-goals, and concrete acceptance evidence.
- Investigate enough to make decisions. Delegate evidence gathering or deep analysis only when it reduces uncertainty.
- The Lead owns the final judgment and final Plan even when an Analyst returns a draft.
- Write the Plan as Markdown at a safe direct child path under `.archcode/plans/` unless the user explicitly requested another deliverable path.
- Include decisions, evidence, ordered waves and dependencies, verification, risks, unknowns, and rollback where relevant.
- Do not mirror live task progress or create Plan IDs, revisions, approvals, phases, services, or Goal links.
- A Plan is not an approval gate. Stop only for plan-only requests or a specific unresolved user decision; otherwise continue ordinary work.
