---
name: safe-refactor
description: Refactor code while preserving behavior through scoped changes and verification when restructuring, renaming, extracting, moving, simplifying, or consolidating code.
license: MIT
metadata:
  archcode/source: "MIT refactoring and TDD concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

# Safe Refactor

A refactor changes structure without changing observable behavior. Optimize for clearer ownership and lower complexity, not fewer lines or a more fashionable pattern.

For dependency-boundary and verification decisions, read [references/boundary-verification.md](references/boundary-verification.md).

## Confirm the boundary

Before editing, state:

- the structural problem being removed;
- the behavior that must remain identical, including outputs, errors, side effects, ordering, persistence, and public types;
- the files or subsystem in scope and what is explicitly out of scope;
- the evidence that will detect a behavior change.

If the requested result changes behavior or public semantics, treat that part as a behavior change rather than hiding it inside the refactor.

## Understand before changing

1. Read the implementation, callers, tests, neighboring conventions, and relevant project instructions.
2. Trace exported symbols, API boundaries, data shapes, error paths, lifecycle hooks, and side effects. Use LSP references when available and appropriate; otherwise combine text, AST, and call-site searches.
3. Establish a clean behavioral baseline with existing tests or a focused characterization test. A characterization test should capture intended behavior, not freeze an accidental implementation detail.
4. Explain why the current structure exists. Preserve constraints that are still real; remove indirection only when it no longer provides ownership, substitution, testability, or isolation value.

Do not proceed while you cannot distinguish preserved behavior from the proposed structural change.

## Design the transformation

- Choose the smallest coherent seam that achieves the requested structural result completely.
- Keep responsibilities together and dependencies directed toward the component that owns the contract.
- Avoid drive-by cleanup, speculative abstractions, compatibility wrappers, and unrelated renames.
- Plan symbol moves and deletions together with all callers, imports, exports, tests, configuration, and documentation that depend on them.
- Prefer explicit, project-native code over compressed or clever replacements.

## Execute incrementally

1. Change one coherent structural step at a time while keeping the tree understandable.
2. Update all dependents for that step; do not leave dual paths, temporary fallbacks, or dead compatibility layers in the final result.
3. Run the cheapest relevant feedback after each risky step: references or diagnostics when supported, otherwise targeted typecheck, build, or tests.
4. If a step breaks behavior or makes the design harder to explain, revert or repair that step before continuing. Do not stack further changes on a broken intermediate state.
5. Delete obsolete code only after callers and behavior have moved and the replacement is verified.

Tests may be added to expose an uncovered contract. Do not weaken assertions or rewrite expected behavior merely to make the refactor pass.

## Verify the result

1. Inspect the final diff for accidental behavior changes, duplicated paths, stale exports, unresolved imports, weakened errors, or unrelated churn.
2. Re-run the focused checks that proved the baseline, then widen to the affected package or repository checks in proportion to risk.
3. Confirm every caller now uses the intended structure and the removed structure is no longer referenced.
4. Compare the result with project conventions and the original goal: the new design should be easier to understand, change, or test for a concrete reason.

Stop and report when the preserved behavior is ambiguous, required coverage cannot be established, a public contract must change, or verification exposes a failure outside the authorized scope.

Finish with the structural change, contracts preserved, obsolete paths removed, verification run, and any residual risk.
