# HITL Tool-Batch Hard-Cut Progress

## Status

- Current: complete; independent Reviewer verdict is `DONE`
- Goal: `docs/goals/hitl-tool-batch-hard-cut-goal.md`
- Compatibility policy: hard cut; no migration, fallback, alias, dual read/write, or retained legacy path

## Acceptance evidence

| AC | State | Evidence |
|---|---|---|
| AC-01 Domain/storage hard cut | Complete | `ProjectHitlQueue` strictly owns the sole `.archcode/hitl-queue.json`; old owner stores, aggregation, Goal gates/adapters, Session HITL journal/pause/resume modules and old sources are deleted. Strict-schema and removed-name architecture tests pass. |
| AC-02 Dependency boundaries | Complete | HITL Core, `SessionToolBatchScheduler`, and `GoalBudgetHandler` have narrow independent responsibilities; Runtime uses an explicit two-owner `switch`. `hitl-boundaries.test.ts` locks imports and dispatcher shape. |
| AC-03 Tool batch semantics | Complete | Scheduler tests cover parallel siblings, serial barriers, multiple blockers, per-call recovery, queued-call continuation, exactly one LLM continuation, and inspection termination. Production query execution uses `partitionToolCalls`; `durableHitlMode` is absent. |
| AC-04 Persistence/recovery | Complete | Canonical Session state persists batch/call/input/result/attempt/HITL linkage. Tests cover blocker write ordering, crash gaps, answered restart, completed no-replay, read-only orphan retry/failure, and effectful orphan inspection. |
| AC-05 Answer/Session execution | Complete | Queue tests cover immutable/idempotent answers, conflict, at-least-once delivery and three-attempt inspection. Session batches reuse ordinary execution ownership; stop/delete cancel only referenced records. Dedicated resume state and errors are deleted. |
| AC-06 API/events/Web/Goal | Complete | Server exposes project snapshot/list plus fixed `/:hitlId/respond|cancel`; old question/permission endpoints are absent. One global-SSE-backed Web store drives Question, Permission, and Budget forms. Goal budget approve/reject tests pass. |
| AC-07 Verification/audit | Complete | Required scenarios, browser verification, literal audits, full test/build and formatting checks all pass; independent Reviewer gave AC-01 through AC-07 and overall `DONE` with no blocking findings. |

## Verification

- `bun run typecheck`: pass, 5/5 workspaces.
- `bun run test`: pass, 8/8 Turborepo tasks. Agent Core lanes: unit 2804, integration 137, architecture 89; Protocol 98; Web unit 484 plus interaction 47.
- `bun run build`: pass; Web production build, 308-asset manifest, and compiled binary pipeline completed.
- `git diff --check`: pass.
- Production removed-symbol audit: zero matches for every AC-07 legacy name.
- Target-module compatibility audit: zero matches for fallback, compatibility, migration, alias, or dual-read/write branches.
- Old `/api/questions` and `/api/permissions` production paths: zero matches; tests assert they remain unavailable.
- Listener cleanup: agent-started listeners were removed; the user-started local dev service used for final browser QA was intentionally left running.
- Independent Reviewer: overall `DONE`; additionally reran 29 Agent Core HITL/architecture tests and 73 Server/Web surface tests with zero failures.

## Browser acceptance

Verified in an isolated temporary project through the real Server and Vite UI:

- Question: submitting `Tokyo` immediately removed the card and completed the exact `ask_user` call with that answer.
- Permission: `Allow once` immediately removed the card and resumed only the exact `file_read` call with `approve_once`.
- Budget: approval immediately removed the card and updated the exact Goal budget approval point idempotently.
- All queue entries became `resolved`; refresh and an actual Server restart/SSE reconnect produced no duplicate cards.

Expected provider connection failures in this isolated run occurred only after the persisted decisions, because the test used a dummy provider; they did not affect HITL acceptance.

## Architectural result

The final shape has three cohesive owners only: the project queue owns human decisions, the Session scheduler owns tool-batch execution, and the Goal handler owns budget application. Runtime performs routing and lifecycle wiring without introducing a registry, workflow abstraction, second projection, or compatibility layer.
