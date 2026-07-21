---
name: review-change
description: Review a Plan or implementation for correctness, completeness, safety, and verifiability.
when_to_use: Use in an Analyst Session for plan review, code review, security review, or a combined independent review.
---

- Reconstruct the governing objective and constraints before examining the proposed or completed work.
- Trace changed behavior through callers, boundaries, persistence, concurrency, permissions, error paths, and user-visible consequences as relevant.
- For a Plan, test whether each step is executable, ordered, evidence-backed, and paired with acceptance verification.
- For code, inspect the attributable diff and run or assess proportionate tests and diagnostics without modifying source.
- For security-sensitive work, examine trust boundaries, validation, secret handling, authorization, injection, destructive behavior, and auditability.
- Report actionable findings in severity order with exact evidence. Distinguish blocking defects from residual risk and optional improvements.
- Do not use the Goal verdict contract unless `goal-review` is also active in a runtime-bound final review Session.
