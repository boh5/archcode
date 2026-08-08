# Review lenses and finding quality

Choose only the lenses the change actually crosses.

## Plan lens

- Does every step name an owner/location, concrete change, prerequisite, produced interface, and decisive check?
- Are acceptance conditions observable and mapped to evidence, including a falsifying edge case?
- Are migration, cleanup, rollback, documentation, and operational steps included only when required?
- Does the ordering match dependencies, and are claimed parallel boundaries genuinely independent?
- Does the Plan introduce a service, state machine, compatibility path, or abstraction without a demonstrated need?

## Code lens

- Trace changed behavior from entry through validation, owner, side effect/persistence, error mapping, and consumer.
- Check direct and transitive callers, public types, restart/retry/cancellation, partial failure, and cleanup as relevant.
- Confirm the fix acts on the causal mechanism and removes obsolete paths when a hard cut was required.
- Read the regression test: would it fail on the old defect, and does it exercise the production path rather than a duplicate implementation?

## Security lens

Name the protected asset, attacker-controlled input, trust boundary, enforcement owner, and concrete exploit path. Check canonicalization order, symlinks/path traversal, authorization timing, secret exposure, command construction, external effects, and fail-open behavior only when present in scope. A generic “could be insecure” concern is not a finding.

An actionable finding states the violated invariant, exact evidence, concrete failure scenario, impact, and smallest adequate correction or missing proof. If the objective, baseline, attributable surface, or necessary read-only evidence is missing, report `unable to conclude` with the smallest next step instead of guessing.

```text
Major — Source precedence can cross the workspace boundary
Invariant: project resources must remain below the project Skill root.
Evidence: resolver accepts the lexical path before checking an ancestor symlink.
Scenario: .archcode/skills points outside; reading demo loads external content as project.
Correction: validate the trusted-root ancestry before discovery and add a regression.
```

By contrast, “rename this helper”, “add comments”, or “use my preferred abstraction” is Advisory at most unless it produces a concrete correctness, maintenance, or acceptance failure. If another layer blocks the alleged path, omit the finding and cite that prevention in the review notes.

`Unable to conclude` should name the missing contract or evidence, why it is necessary, and the smallest safe action that would make the review decidable. It is not a euphemism for approval.
