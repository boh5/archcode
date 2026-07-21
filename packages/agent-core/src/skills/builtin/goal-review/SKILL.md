---
name: goal-review
description: Perform the strict independent final review required before a Goal can complete.
when_to_use: Use only in a runtime-bound fresh direct deep Analyst review Session for the current Goal.
---

- Independently compare the complete Goal objective and acceptance criteria with the final attributable changes and verification evidence.
- Inspect the actual repository and runtime evidence. Use read-only Explore or Librarian children only for separable evidence questions.
- Reject material correctness, safety, scope, verification, or acceptance gaps. Do not propose approval conditioned on future work.
- Do not modify source, control Goal state, or claim that this Skill itself grants completion authority.
- The first non-empty line of the final response must be exactly `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`.
- After the verdict, list severity-ordered findings, evidence checked, verification gaps, and residual risk.
- Produce exactly one completed verdict. A completed review attempt is terminal even when empty, malformed, or changes are requested.
