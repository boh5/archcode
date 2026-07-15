# Project Todos MVP Progress

## Status

- Started: 2026-07-15
- Completed: 2026-07-15
- Current phase: complete
- Goal: `docs/goals/project-todos-mvp-goal.md`

## Acceptance Matrix

| AC | Status | Evidence |
|---|---|---|
| AC-01 ProjectTodo domain | PASS | Strict schema, one state machine, CAS revisions, atomic persistence, archive/restore, Done reopen and inactivity-gated Return to Ready |
| AC-02 Shaper Agent | PASS | Formal required eighth Agent; exact allowlist, guarded Bash, manual-only Memory and no model fallback |
| AC-03 Discussion write-back | PASS | Recoverable singleton Shaper Session, deterministic first execution, bound-session-only update tool and browser-confirmed write-back |
| AC-04 Default Todos UX | PASS | Project defaults to Todos; four board groups plus separate Rejected/Archived views; Dashboard and existing sidebar surfaces preserved |
| AC-05 Three Activation paths | PASS | Independent Engineer source Sessions, immutable snapshots, exact resource binding and recoverable Session/Goal/Automation starts |
| AC-06 Architecture and final verification | PASS | Boundary and deletion-owner tests, hard-cut audit, browser path, independent Reviewer and all final commands pass |

## Log

### 2026-07-15 — Kickoff

- Confirmed the Goal document is the only pre-existing untracked workspace change.
- Split implementation into parallel ProjectTodo backend, Shaper Agent, and Web/UX workstreams; root owns shared protocol/runtime integration and final verification.
- Locked the implementation to a hard cut: no ProjectTodo/SessionTodo reuse, no old aliases, no compatibility adapters, and no fallback Shaper model.
- Corrected the design before implementation so cross-file Session creation is recoverable rather than falsely transactional, Activation binds an exact resource ID, Return to Ready checks authoritative inactivity, and Todo-owned Session references participate in deletion preflight.
- Extended Session deletion ownership with the hard-cut `project_todo` owner type and an injected Todo reference query; the Session store remains free of reverse Todo metadata. Focused lifecycle coverage passes 4/4.
- First-principles correction: `todoRevision` alone cannot reconstruct the activated title/body across a failed first execution followed by Todo edits. The Activation now persists only the immutable title/body snapshot needed for idempotent recovery; this avoids a revision-history subsystem while preserving the promised fixed execution input.
- Completed the Project-owned runtime composition: Todo changes publish `resource.changed`, Discussion/Activation use idempotent root Session and deterministic execution capabilities, Goal/Automation provenance is read from their authoritative stores, and post-commit resource binding is best-effort so a binding outage cannot cause duplicate resource creation.
- Corrected the HTTP contract so `Return to Ready` requires `expectedRevision`; omitting or sending an unknown body is rejected rather than bypassing optimistic concurrency.
- Existing registered Projects now recover Todo checkpoints in Runtime's canonical startup reconciliation alongside Goal/HITL/tool-batch recovery; no second server-side reconciliation loop remains.
- Runtime-managed Automation and Todo Session starts now share one event-aware executor injection. Todo Discussion/Activation checks both the active deterministic execution and the persisted execution record before starting, so live SSE forwarding is preserved without duplicate first runs.
- Removed the resolved single-flight cache after each Session ensure. Concurrent calls still share one operation, while a later retry re-enters the idempotent path if execution failed asynchronously before its durable record; real authorization tests now cover non-Shaper, child, unbound, cross-Project and stale-revision calls.
- Tightened Activation idempotency to the original activation revision only; a fresh same-kind start, Done item or archived item now conflicts instead of silently reopening an old source.
- Return-to-Ready now requires an unarchived In Progress Todo and holds the existing idle Session-family transition lease across provenance recovery and Todo clearing. This closes the locally solvable Session start race without introducing a cross-domain Goal/Automation transaction.

### 2026-07-15 — Final validation and closeout

- Moved runtime recovery behind installation of the Server's SSE-aware managed Session forwarder. Cold start now performs `install forwarder -> recover Session continuations -> recover Todos -> start schedulers`; the Runtime privately selects the authorized start capability, no fallback path exists, and repeated recovery remains idempotent.
- Normalized Todo HTTP failures to their specific top-level `PROJECT_TODO_*` error codes rather than hiding domain conflicts behind a generic response.
- Completed the board interaction contract: collapsed cards show association and a state-matched primary action; all mutations invalidate list/detail state on both success and failure; Discussion also refreshes Sessions; reconnect actively refreshes mounted Todo queries.
- Fixed a pre-existing Dashboard test that both raced under full-repo load and could not prove its claim because React Query swallowed a mocked fetch error. It now records request paths, waits for the real Dashboard data sources, and directly asserts that no global HITL endpoint was requested.
- Browser-tested the complete path in an isolated Project: default Todos navigation, Idea capture, Shaper confirmation and persisted write-back, Ready, independent Session/Goal/Automation activations, exact backlinks and preparation state, Return to Ready, separate Rejected/Archived views, and the preserved Project Dashboard.
- Independent Reviewer audited AC-01 through AC-06 against code, tests, searches and browser evidence and returned `DONE` with no blockers.

### 2026-07-15 — Review hardening

- Removed the mutable Project slug from the workspace-scoped ProjectTodo contract and persistence; close/re-add ordering can no longer hide Todos.
- Preserved Activation navigation after the Todo card moves to In Progress, and made newly created Ideas visible from Rejected/Archived views.
- Moved remote Sessions-list refresh to the post-creation `execution-start` event, avoiding the checkpoint-time race.
- Added exact regressions for slug reassignment, card unmount navigation, non-Board creation and the Todo-to-Session SSE sequence.

### 2026-07-15 — Manual QA hardening

- Re-ran the product path with a real configured model, not mocked tool calls. The first run exposed that cancelling while a tool input was still streaming could persist an omitted `input` field and make the strict Session snapshot unloadable. Tool inputs are now canonicalized to JSON-safe `null` at reducer, event-log, recovery and batch-persistence boundaries; the stopped Session cold-loads after a full server restart.
- Real provider behavior also showed that optional rejection fields and union branches are unsafe for the Shaper decision tool: the provider filled rejection data while keeping an Idea. `project_todo_update` now exposes one flat required decision action (`keep_current`, `mark_idea`, `mark_ready`, or `reject`) plus rationale, with no `anyOf`; only `reject` maps rationale to the domain rejection reason.
- Verified live Shaper behavior for content-only `keep_current`, explicit Ready, and explicit Reject with a persisted reason. None of those paths started implementation.
- Verified two live browser clients receive Todo create/status updates without reload and that concurrent edits produce one successful write plus one visible revision conflict.
- Completed all three Activation paths from independent Ready Todos. Session opened an ordinary Engineer Session with an immutable snapshot; Goal and Automation retained their existing clarification/confirmation flows, created exact resources, and rebound them to the Todo. Return to Ready rejected running/active resources and succeeded after Goal cancellation or Automation pause.
- A real `ask_user` continuation exposed an SSE subscription race between durable tool batches: the first execution was already `waiting_for_human`, so archiving the answered batch briefly looked terminal while the resumed execution was still running. Event forwarding now also requires the latest execution to be non-running before release; the regression waits for the actual asynchronous release check.
- Restarting while `ask_user` was pending exposed the complementary cold-start path. Persisted tool results now resolve only the latest unfinished matching tool part after transient message focus is cleared, while a reused `toolCallId` still creates an independent later call. Runtime construction no longer starts Sessions: cold Goal/HITL/tool-batch continuations and Goal-claim starts all route through the installed managed SSE-aware forwarder. The Runtime supplies a private authorized start closure, so callers cannot forge an internal execution origin to bypass ordinary Session checks.
- Repeated the cold-restart browser path after the capability-boundary refactor: a pre-restart pending question resumed, the Shaper updated the bound Todo from revision 9 to 10, and an already-open second Todos page received the new body without reload. Both browser pages reported zero console errors.
- Rechecked archive/restore, Rejected restore, Done/Reopen, Dashboard preservation, Project-open default navigation, backlinks, SSE recovery, refresh persistence and cold-start persistence.

## Verification

- Related independent review set: 75 pass, 0 fail.
- Dashboard regression: 20 repeated runs pass; complete Web suite passes 505 unit tests and 47 interaction tests.
- `bun run typecheck`: pass, 5/5 workspace tasks.
- `bun run test`: pass, 8/8 workspace tasks.
- `bun run build`: pass, including Web production build, manifest generation and binary compilation.
- `git diff --check`: pass.
- Manual QA regression set: real Shaper provider decisions, Stop/restart recovery, same-process and cross-restart HITL continuation, dual-client SSE and CAS conflict, all three Activation bindings, lifecycle views and inactivity-gated Return to Ready pass.
- Hard-cut search: no production ProjectTodo/SessionTodo reuse, `closed` status, Backlog/WorkItem alias, Shaper model fallback, compatibility read/write path or duplicate Todo state machine.
- Browser environment and all temporary listeners on ports 5173, 4096 and 18099 were stopped after validation.
