# Session Logical Execution Hard-Cut Progress

> Goal: implement `session-logical-execution-hard-cut-plan-goal.md`
> Baseline: `main@dc84dad3`
> Status: complete; AC-01 through AC-08 accepted by fresh independent review

## Working Rules

- Progress and implementation evidence are recorded here; the plan-goal remains the acceptance contract.
- This is a hard cut: no migration, compatibility path, fallback, dual read/write, feature flag, or tombstone test.
- Existing unrelated `.DS_Store` files are out of scope and remain untouched.
- Architecture ownership stays with the existing Protocol/Store, `SessionExecutionManager`, `SessionToolBatchScheduler`, Goal service, and Web projection boundaries. No coordinator or second lifecycle system will be added.

## Progress

### 2026-07-28 — Baseline and work split

- Confirmed implementation baseline is `main@dc84dad3`; the worktree already contains the new Session snapshot and navigation commits, so no merge is required.
- Confirmed only the approved plan-goal and this progress file are in scope before implementation.
- Split implementation into non-overlapping Protocol/Store, Execution/HITL/child, and Web Segment workstreams, with root integration for accounting, recovery, documentation, and final verification.

### 2026-07-28 — Cross-layer contracts locked

- Locked synchronous child handling to one internal Registry outcome, `child_deferred`. A suspended child produces no Raw/Finalized result; the original parent call is finalized only after the exact child Execution becomes terminal.
- Kept `child_launch` and `child_dependency` inside the existing Tool Batch call. The descriptor preallocates child Session/Execution IDs, the Scheduler persists the intent before Manager launch, and recovery uses those exact IDs.
- Replaced activation-based Goal accounting with deterministic run and logical-terminal settlement keys. Execution records hold unapplied settlements; the current Goal instance holds only an embedded receipt list.
- Identified and corrected child Goal attribution: child Sessions have no local Goal, so Manager captures the root Goal instance explicitly in the lifecycle settlement payload.
- Web focused tests for ordered Segment construction, navigation markers, and duration partition are passing while cross-layer type adaptation continues.
- Completed the Protocol/Store hard cut without a second lifecycle owner: strict transition validation, exact-duplicate no-op, durable runs/suspensions/settlements, fail-closed invalid append, and load without lifecycle repair are owned by the existing Protocol and Store boundaries.
- Completed a first production-architecture audit of the execution integration. Continuation admission remains a callback into the existing Runtime reconciliation path, and synchronous-child completion remains a Scheduler operation on the original Tool Batch; no coordinator, migration layer, or compatibility adapter was added.
- Closed the Web invalid-lifecycle gap at the existing Protocol validation boundary. Exact replay consumes the SSE cursor without mutating the projection; an invalid transition consumes nothing and asks the existing Session query for an authoritative snapshot. No Web lifecycle state machine or recovery service was introduced.
- Corrected the live-family projection without adding states: the existing `waiting_for_human` and `resuming` activities are non-idle in Sidebar, Dashboard, Inspector, Diff polling, and Composer. Suspended work retains Stop and Queue controls.
- Integration testing corrected two first-principles mistakes: Goal continuation is a new logical Execution rather than a suspension resume, and terminal synchronous-child output settles the original parent Tool Batch correlation exactly once.
- Closed partial-HITL delivery inside the original Tool Batch. Read-only responses can settle while the logical Execution remains suspended; approved effectful permission work is deferred until the final blocker resumes the same Execution, and redelivery repairs a read-only response interrupted after its durable running mark.

### 2026-07-28 — Runtime and recovery closure

- Removed the detached answered-HITL execution path. A durable answer now waits for the exact live run boundary, updates the original Tool Batch call, and resumes only through `SessionExecutionManager` with the same `executionId`.
- Made startup recovery fail closed and ordered it around the existing owners: replay settlements, repair/reconcile lifecycle, deliver answered HITL, then reconcile resumable work. Missing HITL links are repaired by the Scheduler's narrow batch helper.
- Closed answer-versus-Stop without a new lock: Stop admission wins, accepted human responses are never overwritten by cancellation, cancellation rereads the canonical batch, and suspended records terminalize their original Execution.
- Kept active duration and child timeout canonical to persisted run spans. Recovery time and human wait do not consume either budget.
- Added the Goal family settlement guard so an unapplied descendant receipt blocks Goal removal until replay applies it.
- Converged child links from cold recovery and suspended Stop. Waiting has no terminal reminder; terminal status and reminder are written once for the exact `childExecutionId`.
- Added archived answered-HITL redelivery coverage: the same response is accepted as an idempotent receipt without re-executing or duplicating a tool result.

### 2026-07-28 — Web projection closure

- Ordered Work Segments remain a Web-only projection. Canonical user-message batches create markers; HITL answers and resume runs do not create domain records or navigation markers.
- `execution-resumed` updates the active run binding in the live Web projection; invalid lifecycle events leave local state unchanged and request the authoritative Session snapshot.
- Waiting, resuming, stopping, per-Segment Work duration, final output placement, navigation, and suspended Stop behavior are covered by the full Web unit and interaction suites.

### 2026-07-28 — Architecture audit

- Independent architecture/minimality audit found no remaining Blocking/High issue after the review-fix cycle.
- Ownership remains Protocol/Store → Execution Manager → Tool Batch Scheduler/Runtime delivery → Web projection. No coordinator, journal, workflow engine, migration, compatibility layer, or fallback was introduced.
- The architecture contract now audits construction of all five lifecycle events and allows only `SessionExecutionManager`; stale Session Input/reducer/store exemptions were removed.
- Authoritative Session snapshots require and directly apply all five runtime fields. The only non-snapshot writes are the existing child-link metadata preload and model-selection PATCH, each exposed through a narrow store method rather than a compatibility inference path.

### 2026-07-28 — Browser and final verification

- Exercised a real Session through Vite/Hono: one steer arrived after 62 completed tool calls and remained on the same persisted `executionId`; the Web projected the earlier work and the steer as two ordered Work Segments.
- Reload preserved persisted array order. The navigation rail exposed one `Message N` marker per canonical user message and jumped to the selected message. Each visible disclosure remained a neutral `Worked for` Work segment rather than claiming to be an Execution.
- Exercised direct `ask_user` through `Needs you` and answer delivery. The same logical Execution completed with two persisted runs, one marker, one Work Segment, and one final answer.
- Exercised a synchronous Analyst child that suspended on its own `ask_user`. The parent displayed `Waiting on child`; answering produced the exact persisted `child_dependency -> resume_pending -> resumed` sequence on the same Execution and the final browser view remained one Work Segment.
- Exercised Stop while the parent was suspended on that child. QA found one terminal cleanup omission: a failed call retained `childDependency` and failed strict reload. `cancelSessionToolBatch` now applies the existing terminal-call rule and clears that correlation; the focused reload regression and a second real parent/child Stop both pass with no browser alert.
- Desktop and 390×844 checks had no horizontal overflow. No new browser warning/error appeared after the temporal cadence fix.
- Fixed the browser-only relative-time cadence oscillation found during QA. The shared primitive now prevents a stale replacement cadence snapshot from flipping state while still accepting the initial subscription refresh; the focused regression and full Web suite pass.
- Old incompatible local Session data was moved out of the runtime tree to `/private/tmp/archcode-hard-cut-backup-20260728/` for this hard-cut QA. No production migration or fallback was added.

### 2026-07-28 — Independent review-fix closure

- Made `execution-resumed.runOrdinal` exact and rejected stale replay, while preserving same-run LLM retry attempts and rejecting only cross-run step-cursor reuse. A real save, memory clear, and strict reload regression proves the retry shape.
- Preserved the total `maxSteps` cursor across Todo continuation and resume without fabricating a phantom terminal step.
- Added one required per-call `checkpointAt` at the existing Tool Batch boundary. Recovery duration now uses real call checkpoints, never restart time or broad batch metadata.
- Closed startup/Stop crash gaps: orphan active batches archive before terminalization, attempted effectful cancellation records an unknown result, force Stop persists batch cleanup and Goal settlements before returning, and exact child links are reconstructed from canonical dependency identity.
- Goal replacement/clear now refuses an unapplied settlement anywhere in the current Session family. Model/runtime callbacks are required capabilities rather than optional fallbacks.
- Pending Tool Batch continuation intersects persisted tool/Skill capabilities with current authority; model changes cannot expand the original call.
- Work Segment stabilization now compares visible assistant output, tied Execution timestamps preserve persisted source order, and final/assistant output remains visible outside the Work disclosure.
- `resume_session` child links use the child Execution's own active-duration snapshot from running through HITL waiting; suspended time stays frozen.
- Added direct AC-02 liveness evidence without production changes: a three-level synchronous dependency resumes only the deepest ready grandchild through suspended ancestors, and a capacity-blocked resume is retried automatically by the existing slot-release callback.
- Added the direct AC-03 two-blocker matrix in one Tool Batch: reverse-order response, exact duplicate no-op, conflicting response rejection without canonical mutation, and exactly-once final settlement.
- Seven test fixtures that represented a Tool Batch without its owning Step were corrected to current-format facts. The production schema was not relaxed.
- Seven checkpoint-era QA Sessions were moved recoverably to `/private/tmp/archcode-hard-cut-qa-pre-checkpoint-20260728/`; the current runtime Session directory is empty and strict.

### 2026-07-28 — Fresh final review closure

- A fresh `sol(max)` review found four bounded gaps and no need for an architectural rewrite. All fixes stayed with existing owners.
- Release callbacks are required and awaited. Resource counts are released first, then the existing Runtime project reconcile path resumes Queue or `resume_pending`; its existing capped retry handles transient failures without a new scheduler or durable wake concept.
- Canonical user text now requires the exact `executionId + runOrdinal + modelAudit` provenance triple, and the audit must match that run's binding.
- Manager terminalization settles or archives any active Tool Batch before `execution-end`; cold reconciliation also closes a terminal Execution's leftover active batch. Direct regressions cover a real `hitlQueue.create` failure and subsequent Execution admission.
- Restored compact direct Rail evidence for Segment threshold, one marker per canonical input, current state, jump, keyboard, tooltip, and long-list ResizeObserver stabilization.
- Updated one title-generation persistence fixture to construct a current-format E/run/audit message; no compatibility or schema fallback was added.
- The fresh reviewer independently reran the final snapshot and reported no Blocking/High findings. AC-01 through AC-08 are all `DONE`.

## Verification Ledger

| Gate | Status | Evidence |
| --- | --- | --- |
| Protocol/Store directed tests | pass | Full Protocol suite: 115 passed; strict lifecycle and Store-directed coverage pass |
| Execution/HITL/child directed tests | pass | Manager, Scheduler, Runtime, Stop, reload, recovery, strict retry persistence, deepest-first dependency, slot-release retry, and reverse-order blocker coverage pass; latest Manager 109 and Scheduler 21 passed |
| Web Segment/navigation directed tests | pass | Full Web suite: 520 unit + 86 interaction = 606 passed |
| `bun run typecheck` | pass | 5/5 workspaces successful |
| `bun run test` | pass | Turbo: 8/8 tasks successful |
| `bun run build` | pass | Typecheck 5/5; Vite production build (2,720 modules); 308 assets embedded |
| Browser desktop + 390px QA | pass | Real steer ordering; direct HITL; child wait/resume; suspended Stop; same-E runs/segments; refresh; marker jump; 390px no overflow; zero final console errors |
| Literal/legacy audit | pass | No production checkpoint/continuation helper names, no `tool_batch` Execution origin, no legacy steer splitter |
| Architecture/minimality audit | pass | Existing owners only; no added coordinator/state machine/fallback |
| Fresh final `sol(xhigh|max)` review | pass | No Blocking/High; AC-01 through AC-08 all `DONE` |

## Remaining Verification

- None.
