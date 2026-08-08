# Todo shaping template

```markdown
## Outcome
Problem observed:
Intended user-visible result:

## Evidence
- Repository/runtime fact: <source>
- Existing behavior or constraint: <source>
- Assumption still needing evidence:

## Scope and non-goals
- Included owner/flow/interface:
- Explicitly excluded:

## Decisions
- Confirmed direction and rationale:
- Remaining product choice for the user:

## Dependencies and risks
- Prerequisite, external authority, migration, or sequencing risk:
- Control or decision required:

## Acceptance
- Given <starting state>, when <action/event>, then <observable result>.
- Failure/edge case: <decidable behavior>.
- Verification or inspection:
```

Keep repository facts separate from product choices. “The current API has no batch endpoint” can be established from code; “users should see partial success” is a product decision unless already specified.

Weak acceptance: “Improve error handling” or “works correctly.” Strong acceptance: “When the provider times out before any side effect, the Session remains retryable and the UI shows the mapped timeout state; the focused integration test observes both.” Do not require implementation details such as a particular class name unless that ownership is itself an accepted constraint.

Before Ready, check that the outcome is singular, scope is bounded, exclusions do not omit required work, every remaining choice is either answered or explicitly blocks execution, and the next Lead can identify decisive completion evidence.

Move to Ready only after the user confirms the direction and the next Lead can execute without guessing. This template never authorizes implementation.
