# Dependency boundaries and verification

Before moving a seam, identify exported symbols, callers, data shapes, side effects, error paths, lifecycle hooks, configuration, and tests. Keep the contract owner on the dependency direction that already owns the policy; do not create wrappers merely to preserve an obsolete shape.

## Boundary inventory

| Concern | Baseline evidence | Must remain true | Verification |
| --- | --- | --- | --- |
| Public symbol/type | definitions and callers | same supported contract or explicit hard cut | typecheck + caller inspection |
| State/side effect | owner and event/order path | same observable mutation and ordering | focused behavior test |
| Error/permission | mapping and guard owner | same denial/failure semantics | negative-path test |
| Lifecycle | startup, retry, cancellation, cleanup | no leak, duplicate, or stale owner | integration inspection/test |
| Persistence/config | schema and readers/writers | compatible shape or complete migration | round-trip/restart test |

Establish the baseline before editing. A characterization test is useful only when it captures intentional behavior at the real boundary; do not freeze an accidental implementation detail merely because it exists.

Apply one coherent structural move: introduce the new owner or seam, move all callers that belong to that step, verify, then remove the obsolete path. When the requirement is a hard cut, do not leave wrappers, aliases, dual writes, fallback reads, or tests whose only purpose is preserving the deleted shape.

## Verification ladder

1. Reference/symbol search proves which callers were considered, not runtime correctness.
2. Diagnostics and typecheck prove static consistency, not behavior or build delivery.
3. Focused tests prove the changed invariant and material negative path.
4. Integration/architecture tests prove crossed process, persistence, package, or dependency boundaries.
5. Build or compiled smoke proves delivery when bundling/static assets are part of the seam.

Inspect the final diff for duplicated policy, reversed dependencies, temporary adapters, and unrelated cleanup. Compare the same behavioral inventory before and after; fewer files or passing types alone do not establish a safe refactor.
