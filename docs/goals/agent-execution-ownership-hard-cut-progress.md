# Agent Execution Ownership Hard-Cut Progress

## Status

`DONE` — All AC-01 through AC-06 implementation, hard-cut audit, verification, and independent architecture review completed on 2026-07-15. The acceptance contract remains exclusively in `agent-execution-ownership-hard-cut-goal.md`; this file records execution evidence and decisions only.

## Workstreams

| Workstream | Owner | Model | Status |
| --- | --- | --- | --- |
| Execution lifecycle, admission, concurrency | execution worker | sol (high) | complete |
| Child identity, Skills, depth, `resume_session` | identity worker | sol (medium) | complete |
| Slash Command Server/Web hard cut | command worker | luna (high) | complete |
| Hooks, AGENTS.md refresh, integration | root | primary | complete |
| Final architecture review and full verification | root + reviewer | sol (medium) | complete |

## Decisions

- `delegate` creates only; `resume_session` resumes only. They share the existing child execution service and ExecutionManager.
- `SessionExecutionManager` owns live Execution lifecycle; `SessionStoreManager` retains restart hydration repair.
- Runtime authorization depth comes only from the persisted parent chain. Child-link depth remains display-only.
- No legacy compatibility parser, read-time default, migration, alias, deprecated wrapper, or fallback is retained.

## Activity Log

- 2026-07-15: Goal activated, worktree confirmed clean except Goal documents, and parallel workstreams assigned.
- 2026-07-15: Removed the standalone Server command route and Web command mutation. Slash input now enters the ordinary Session message path.
- 2026-07-15: Removed the unused `transcriptSave` Hook policy and changed `ConfiguredAgent` to refresh `AGENTS.md` for every Execution.
- 2026-07-15: Persisted `activeSkillNames` as strict Session identity, split `resume_session` from create-only `delegate`, and changed active Skill content to resolve on every Execution.
- 2026-07-15: Architecture correction identified during implementation: authoritative depth resolution must walk only the current Session's ancestor chain, not scan the whole family tree; the latter couples admission to unrelated siblings and scales with family size.
- 2026-07-15: Web fixtures were updated for the strict identity field; Web typecheck and 63 focused tests pass.
- 2026-07-15: Parent-chain depth correction completed with cycle/root/missing-parent validation. Identity/delegation/resume workstream passes 172 focused tests and Protocol typecheck.
- 2026-07-15: Mid-implementation architecture audit found and removed three hard-cut residues: Server raw execution forwarding, Web description-to-title fallback, and old delegate `prompt` rendering. Child-link title is now a required non-empty contract.
- 2026-07-15: Delegate/resume Web contract passes Web typecheck and 150 focused tests; Server typecheck passes after switching forwarding tests to checked async entry points.
- 2026-07-15: `SessionExecutionManager` became the sole live lifecycle/admission/concurrency owner; QueryLoop now returns status only, and the Agent manager was reduced to a rebuildable cache. Unused cache accessors and all raw execution/command paths were deleted.
- 2026-07-15: Resume review found missing max-depth, concurrency, timeout, abort-cascade, canonical-title, cross-root, and claim-failure checks. Resume now reapplies the same persisted identity and parent policy as child creation without adding another manager or state machine.
- 2026-07-15: Final review found two evidence gaps rather than production defects: weak source guards and missing Todo/cold-identity scenarios. The guards now fail closed on unclassified production `.run()` calls and lifecycle event construction; real multi-round Todo and four-level warm/rebuild/restart identity scenarios were added.
- 2026-07-15: A stale Server test fixture still exposed removed `startSessionExecution`; it was deleted rather than adapted. Final residue search has no production fallback, legacy command path, child-link depth authorization, or Manager-external Agent run.
- 2026-07-15: Repository-level `test` and `build` were rerun independently after a parallel validation attempt produced transient test timing failures. The exact acceptance commands pass without retries or relaxed assertions.
- 2026-07-15: Post-review durability audit found that `flushSession()` only waits for queued snapshots while `execution-start` did not queue one. `execution-start` now triggers persistence, and a disk-level regression test proves the running record is durable before Agent execution proceeds.
- 2026-07-15: Manual black-box persistence QA used a real temporary workspace and Session file: the accepted Execution was durably `running`, crash-style reload reconciled it to `interrupted`, normal completion reused the same id and single record, and a clean reload preserved `completed`.
- 2026-07-15: Browser QA found that command `system-notice` messages were stored as user messages but rendered as empty user bubbles. The Web renderer now displays notice-only user messages directly, with a component regression test.
- 2026-07-15: Browser QA also found that a leading `/compact` notice caused title generation to inspect the wrong first user record and return permanently. Title generation now selects the first non-empty textual user message; a regression test covers command-before-message Sessions.

## Verification

- Targeted execution/cache/boundary suite: 107 passed, 0 failed.
- Post-review Session Store + ExecutionManager regression suite: 143 passed, 0 failed.
- Post-review manual QA: durable start, crash reconciliation, normal completion, and clean restart all passed against the real Session JSON path.
- Browser QA: idle `/compact` visibly returned its system notice; ordinary message execution exposed running/idle states; `delegate` created `QA 子 Agent`; `resume_session` reused that exact child Session and preserved title/identity/history across refresh; `/skill use codemap` executed `skill_read` and the model continuation under one Execution id; command-before-message title generation persisted and survived refresh.
- Browser-found regressions: 32 focused title-generation/Web rendering tests passed, followed by all-workspace typecheck and `git diff --check`.
- Agent Core: 2,836 unit tests, 137 integration tests, and 99 architecture tests passed; the unit lane also passed five repeated runs (14,180 total) while investigating the transient parallel-validation result.
- `bun run typecheck`: 5/5 workspaces passed.
- `bun run test`: 8/8 Turborepo tasks passed.
- `bun run build`: passed; Web build and 308-asset manifest generation completed.
- `git diff --check`: passed. Hard-cut residue searches passed with only the Manager lifecycle writer and Store reducer/hydration readers remaining.
- Independent Reviewer mapped AC-01 through AC-06 to implementation, tests, searches, and command results; no blocker, second lifecycle owner, fallback, or overdesigned abstraction remains.
