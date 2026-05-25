---
name: review-work
description: Review completed work against goals, correctness, safety, and verification.
when_to_use: Use after completing any significant implementation, before committing, or when explicitly asked to review, verify, or check work.
---

- Compare the final diff against the original request: every stated requirement must have a corresponding change.
- Verify no unrelated files were modified; if they were, justify each or revert.
- Check for type errors, lint warnings, and diagnostic issues introduced by the changes.
- Confirm existing tests still pass and new behavior has adequate test coverage.
- Look for security risks: hardcoded secrets, unvalidated inputs, privilege escalation paths.
- Assess error handling: are new error paths reachable, and do they produce actionable messages?
- Run the most relevant build or test command and report the actual output, not assumptions.
- Report concrete pass/fail findings with file paths and line references when possible.
- Flag any remaining TODO items, incomplete edge cases, or follow-up work discovered during review.