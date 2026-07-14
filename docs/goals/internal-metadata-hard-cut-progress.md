# Internal Metadata Hard-Cut Progress

## Status

- State: complete
- Goal: `docs/goals/internal-metadata-hard-cut-goal.md`
- Started: 2026-07-14
- Compatibility policy: hard cut; no migration, fallback, aliases, or dual read/write

## Work Log

### 2026-07-14 — Baseline and impact audit

- Confirmed the Goal defines AC-01 through AC-07 as the only completion contract.
- Started three parallel read-only audits covering core persistence/Goal, Protocol/Server, and Web/tool metadata.
- Confirmed the starting worktree contains the untracked Goal document and no implementation from this Goal yet.
- Baseline `bun run typecheck` passed for all five workspaces.
- Baseline `bun run test` passed all eight Turborepo tasks, including unit, integration, architecture, and Web interaction lanes.
- Final validation must run again after all parallel edits have converged; baseline results are not completion evidence.

### 2026-07-14 — Implementation split

- Core persistence lane owns Session/HITL/Compression schemas, event envelopes, checkpoint/journal terminology, and redundant directory/ripgrep/parity markers.
- Goal/Automation lane owns `projectSlug`, `GoalLifecycleService`, dead Goal stream contracts, and reason-free post-commit resource notifications.
- Web/tool/config lane owns strict ask_user and ToolDiff metadata, the unversioned layout key, AuditEvent, and fixed MCP/GitHub/config fields.
- Shared files such as `packages/protocol/src/types.ts` are edited by section ownership; final integration waits for all lanes before interpreting type or test failures.
- Architecture decision: Session envelopes retain cursor/order data but route only through a validated `payload.type`; no replacement marker is introduced.
- Architecture decision: Goal commit notification is a post-persistence side effect with failure isolation, not a transaction participant, retry system, or outbox.

### 2026-07-14 — First implementation checkpoint

- Goal/Automation production schemas now target versionless `projectSlug` contracts; the lifecycle service rename and reason-free resource notification path are in progress across callers and tests.
- Session/HITL/Compression production persistence is in the versionless cutover; durable HITL journal and Session blocker terminology are being separated without adapters.
- ask_user and ToolDiff producers/consumers now target strict current-only metadata; malformed or old-shaped metadata falls back to visible raw output.
- Fixed MCP transport, GitHub API base, config `$schema`, AuditEvent version, and the versioned workbench layout key are being removed across config, API, UI, and tests.
- Focused Web/tool/config tests reached 421/422 passing while concurrent HITL schema edits were incomplete; this is intermediate evidence only.

### 2026-07-14 — Web, tool metadata, and config slice complete

- ask_user, ToolDiff, layout storage, AuditEvent, MCP/GitHub/config fields, Settings, API, README, and their scoped tests are complete.
- Focused Web/tool/config/MCP/GitHub tests passed 303/303; config route/API/service passed 24/24; Settings interactions passed 27/27.
- Scoped `git diff --check` passed. Global typecheck remains deferred until the Goal and core persistence lanes finish shared types and fixtures.

### 2026-07-14 — Goal and Automation slice complete

- Goal and Automation now use strict versionless `projectSlug` schemas and APIs; old `projectId`, versions, runner names, aliases, and dead Goal stream projection contracts are removed.
- `GoalLifecycleService` preserves the existing state/cancellation/continuation ownership boundaries. Resource refresh is emitted once after each successful Goal commit, while title generation remains creation-only.
- Goal/Automation focused tests passed 51; related Server routes passed 40; Web Global SSE passed 38; Goal architecture tests passed 29.
- Server, Web, and Protocol typechecks passed for this slice. Agent Core typecheck remained temporarily blocked only by the still-active core persistence lane.
- Started reciprocal read-only reviews: the Goal lane reviews Web/tools/config, and the Web/tools/config lane reviews Goal/Automation.

### 2026-07-14 — Cross-review and first full-suite run

- Web/tools/config cross-review found no actionable issue and passed 357 focused tests.
- Goal/Automation cross-review found that `goal_manage` still bypassed `GoalLifecycleService`, while the lifecycle service exposed cancellation and state-forwarding methods with no production caller. These violate the locked ownership boundary and are being removed rather than wrapped.
- The same review requested stronger Runtime evidence for Goal resource notifications, asynchronous callback failure isolation, creation-only title generation, and the absence of every Session query invalidation.
- The first stable-tree `bun run typecheck` passed all five workspaces.
- The first stable-tree `bun run test` failed because unit tests read the real legacy `~/.archcode/projects/index.json`; an isolated HOME reduced the failures from 34 to 13, exposing stale versioned permission fixtures, one removed envelope assertion, and one re-registration test that relied on the deleted HITL slug migration.
- Resolution: make tests self-contained and update hard-cut expectations. Production compatibility, user-data deletion, and migration restoration are explicitly rejected.

### 2026-07-14 — Lifecycle boundary repair and full verification

- `goal_manage` now reads through `GoalStateManager` but delegates begin-review, finalization, and retry mutations exclusively to `GoalLifecycleService`; cancellation remains exclusively in `GoalCancellationService`.
- `GoalLifecycleService.beginReview()` owns the execution claim and runs the no-active-Build readiness callback inside that claim. A concurrency-order test proves a competing claim cannot enter before the guard and review commit finish.
- Removed unconsumed lifecycle forwarding APIs for cancellation, child-session attachment, and budget updates. Retry now verifies the prepared workspace and stable Goal Lead main Session identity before committing.
- Runtime tests prove every successful Goal durable commit emits exactly one reason-free Goal resource event, asynchronous notification failure cannot change the committed result, and title generation runs only for creation.
- The first full test failure was repaired through test isolation only: runtime-construction tests use temporary registries, permission tests use unique temporary state, and re-registration tests explicitly clear their temporary workspace data. No production migration or fallback was restored.
- Final stable-tree validation passed: `bun run typecheck` 5/5 workspaces; `bun run test` 8/8 Turborepo tasks, including 2900 Agent Core unit tests, 139 integration tests, 87 architecture tests, Web/Server/Protocol/Utils; `bun run build` generated 308 Web assets and the 78 MB binary; `git diff --check` passed.

### 2026-07-14 — Fresh-state smoke and strict event repair

- Used isolated fresh state at `/tmp/archcode-hardcut-smoke.KbQB0k`; no operator registry, workspace runtime data, browser storage, or source tree was deleted.
- Server smoke passed 79 tests for project registration, Session creation/message dispatch, HITL response/cancel, Goal routes, and Automation routes.
- Runtime smoke passed 49 tests for durable multi-question `ask_user` response/restart, Goal commit refresh, Automation creation provenance, scheduling, dispatch, and worktree execution.
- Web smoke passed 39 tests for Goal list/active/detail refresh without Session invalidation and Automation-only cache invalidation.
- Independent core review found a P1: the first `payload.type` guard recognized known types but did not validate their current structure. The final Protocol guard now exhaustively validates exact keys, required fields, enums, and nested current contracts for every Session event type while retaining zero runtime dependencies.
- Guard fixtures cover all 34 current Session payload types, reject an extra key for every type, and reject known-type missing/invalid/nested malformed objects. `SessionFileSchema` explicitly rejects `{type:"text-delta"}` and `{type:"text-start", legacy:true}` while accepting the current shape.
- The stricter external/persistence guard initially suppressed reducer-owned `InvalidTodoStateError` for typed in-process appends. Routing inside the store now uses the already-typed `event.type !== "shutdown"` distinction, preserving reducer invariants while unknown persisted/SSE input remains strictly validated.

### 2026-07-14 — Final architecture review

- Two independent reviewers checked the converged diff. They confirmed the Goal lifecycle/claim boundary, HITL journal/blocker/owner responsibilities, strict Web metadata parsing, Protocol zero-dependency boundary, and absence of compatibility machinery.
- Final review found one legitimate optional producer field missing from the exhaustive event guard: `LlmRetryEvent.nextRetryAt`. It is now accepted only for `llm-retry` and is covered through Protocol, Web SSE parsing, and Session persistence tests.
- Final review found the retired error code `SESSION_HITL_CHECKPOINT_INVALID` in the replay failure path. It is hard-cut to `SESSION_HITL_JOURNAL_INVALID`; production and tests contain no old checkpoint names.
- Both reviewers re-ran their focused checks and returned PASS with no remaining finding.
- One final full run had a single Dashboard test timeout after 557 Web tests passed. The exact file then passed 14/14, and a clean full rerun passed all 8/8 Turborepo tasks. This was treated as a transient timing failure only after reproduction evidence.
- Final `bun run build` passed after the review fixes, generated 308 assets, and rebuilt `dist/archcode`; final `git diff --check` and all deletion audits passed.

### 2026-07-14 — Post-review boundary fixes

- Restored the committed-Goal invariant: creation hooks may be synchronous or asynchronous, but activation now runs in `finally`, so a non-critical hook failure cannot leave a committed Goal without its stable Goal Lead Session.
- Added Protocol-owned exact guards for global `hitl.event` and `resource.changed` events. Web now rejects removed `payload.status` / `reason` fields, missing fields, inconsistent HITL identities, and malformed nested projections before state mutation.
- Verification passed: all five workspace typechecks, 59 focused Protocol/Web/Goal tests, and the full 8/8 Turborepo test graph including 2901 Agent Core unit, 139 integration, and 87 architecture tests.

## Acceptance Evidence

| Criterion | State | Evidence |
| --- | --- | --- |
| AC-01 Internal versions removed | verified | Production audit has zero `schemaVersion`, compression version constants, or `version: z.literal(...)`; strict negative fixtures reject removed fields |
| AC-02 Redundant markers removed | verified | Envelope/HITL routing uses validated current discriminants; directory/ripgrep/parity markers removed; replay/cursor tests pass |
| AC-03 Semantic naming hard cut | verified | Production audit has zero `projectId`, `GoalRunner`, checkpoint type/file names, or aliases; lifecycle architecture tests pass |
| AC-04 Compression/tool metadata preserved | verified | Compression reload/compact suite passes; ask_user and ToolDiff reject old, extra, and nested malformed metadata while keeping raw output visible |
| AC-05 Dead contracts/config fixed fields removed | verified | No `goal.state_change` or reasoned resource event; fixed MCP/GitHub/config fields absent; exact Goal commit notification tests pass |
| AC-06 Boundaries and critical flows preserved | verified | Full unit/integration/architecture suites pass; Protocol/Utils remain zero-runtime-dependency packages |
| AC-07 Full deletion and completion evidence | verified | Final independent reviews PASS; search audit, full commands, build artifact, and isolated fresh-state smoke all pass |

## Open Findings

- Resolved in scope: the existing Session HITL recovery path rewrote persisted owner project slugs. This is a format migration incompatible with the hard cut, so it and its compatibility test must be deleted; the legitimate cwd removal transaction remains.
- Resolved in scope: strict ask_user result validation also requires validating the current question/options input shape. Otherwise malformed input can hide the raw result despite valid answer metadata; the Web validator now treats the pair as one current contract.
- Resolved in scope: the first Goal notification wiring coupled title generation to the new all-commit callback, which would retry title LLM work on every untitled state change. Resource refresh remains all-commit, while title generation stays creation-only through a separate narrow existing lifecycle hook.
- Resolved: `goal_manage` uses `GoalLifecycleService` as the lifecycle command/claim boundary; cancellation cleanup remains in `GoalCancellationService`, and unconsumed forwarding methods are deleted.
- Resolved: unit tests no longer depend on the operator's registry or stale temporary permission files. The repair is test isolation, not a production compatibility path.
- Resolved: strict Session event validation is exhaustive at unknown persistence/SSE boundaries without changing typed reducer behavior or adding a schema dependency to Protocol.
- Resolved: exhaustive event validation includes the production `llm-retry.nextRetryAt` variant; the Web and persisted Session paths both accept it.
- Resolved: the last checkpoint-named error code is now journal-named; no retired checkpoint contract remains in production.
