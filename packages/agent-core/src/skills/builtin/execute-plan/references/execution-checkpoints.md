# Execution checkpoint card

Use one card per dependency boundary, not one per trivial edit.

```markdown
### Checkpoint: <deliverable>
- Plan obligation:
- Preconditions verified:
- Files/symbols and owner:
- Observable change:
- Invariants/non-goals preserved:
- Narrow verification and expected signal:
- Result: supported / partial / failed
- Diff or interface impact on later steps:
- Decision: continue / remediate / revise Plan / ask user
```

Before beginning, verify that the prerequisite and referenced code still exist, the intended owner remains correct, and the step does not depend on an unresolved product choice. Name the failure that the narrow verification must detect; “run tests” is not a decisive expectation.

After implementation, inspect the attributable diff and complete verification output. Re-read callers, types, persisted shapes, or event order at the changed seam. If the produced interface differs from the Plan, update the remaining execution sequence only when the difference is local and objective-preserving; otherwise stop for a Plan or user decision.

At integration boundaries, read the current diff and recheck callers, shared state, and produced interfaces. A child report and an isolated passing test are leads, not integrated proof.

Do not advance when a test passed for the wrong path, an expected assertion was never exercised, generated output is missing, or a later step now relies on an interface that was not produced. Record the smallest remediation and repeat the same checkpoint with fresh evidence.
