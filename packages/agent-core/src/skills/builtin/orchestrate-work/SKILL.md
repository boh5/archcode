---
name: orchestrate-work
description: Route ordinary root Lead work between direct execution and bounded child collaboration while retaining technical ownership.
license: MIT
metadata:
  archcode/source: "ArchCode delegation protocol"
  archcode/source-commit: "f00efe7ab3cd87f951797d9b4bf14415f10abd7a"
  archcode/adaptation: "original rewrite"
---

## Decide the execution shape

1. Restate the requested outcome, constraints, and evidence that would prove it. Inspect the current state enough to separate known facts from assumptions before choosing an execution shape.
2. Work directly when the change is small, tightly coupled, on the critical path, or already understood. Delegation has coordination cost; do not create children merely because they are available.
3. Delegate only a separable result:
   - Analyst for deep reasoning, gap analysis, or independent criticism;
   - Build for one bounded implementation outcome;
   - Explore for one local-code evidence question;
   - Librarian for one current external-evidence question.
4. Choose `fast` for low-risk, known-pattern Build work and `deep` for ambiguous, cross-domain, security-sensitive, concurrent, migration, or otherwise difficult Build work. Analyst is always `deep`; Explore and Librarian are always `fast`.

## Delegate safely

Use [references/delegation-packet.md](references/delegation-packet.md) when preparing a child brief or an integration gate.

- Partition by independently understandable problem domain or deliverable, not by arbitrary file count. Run children in parallel only when they have no shared mutable state, overlapping changes, or dependency order. Keep related failures, common root-cause investigations, and integration-sensitive work together or serial.
- Give every child a self-contained objective containing the relevant evidence, exact scope, constraints, acceptance conditions, downstream decision, and expected report. Supply only the Skills needed for that result.
- Do not invent path ownership, leases, or new collaboration state. A bounded Build scope reduces interference but does not create Runtime ownership. The Lead remains responsible for all integration and completion claims.
- If new evidence shows that supposedly independent tasks overlap, stop parallel mutation, reconcile the shared design, and continue serially.

## Integrate and verify

1. Read each child report critically; a child success claim is not proof. Inspect the attributable diff or evidence and resolve contradictions before accepting it.
2. Integrate in dependency order. Recheck callers, interfaces, shared state, and user-visible behavior after combining results; individually valid changes can still conflict.
3. Run the narrowest decisive checks for each changed behavior, then the broader project checks required by the repository and the combined risk. Read complete output and exit status.
4. Before claiming success, compare the final state against every requested outcome and acceptance condition. Report only what fresh evidence establishes, plus unverified areas and residual risk.

## Stop conditions

- Stop and ask for a focused decision when scope, product intent, destructive authority, or an external prerequisite cannot be inferred safely.
- Stop delegating and investigate directly when failures appear related or the full system state is required.
- Do not call work complete while material verification fails, a required child is still non-terminal, or an unresolved finding can change correctness.
- Report a concrete blocker instead of guessing or repeatedly applying the same failed approach.

Before creating a Goal, use ordinary `ask_user` to ask whether to create it. Interpret the answer semantically: call `create_goal` only when the user clearly agrees; otherwise continue ordinarily or clarify. Goal creation does not change any of the orchestration and verification duties above.
