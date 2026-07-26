# Session Goal Model-Context Notice Progress

## Status

- Goal implementation started.
- Authoritative plan: `docs/goals/session-goal-model-context-notice-hard-cut-plan-goal.md`.
- Worktree baseline: `main` at `d4717b17`; pre-existing documentation changes are out of scope and must be preserved.

## Execution Log

### 2026-07-26

- Confirmed the plan hard-cuts dynamic Goal Prompt injection in favor of durable GoalNotice messages.
- Confirmed accepted failure boundary: materialization persistence failures fail closed and recover through Runtime restart; no same-process hot recovery.
- Confirmed current-contract hard cut: a persisted Goal without a matching pending or materialized notice is invalid and receives no migration or fallback.
- Partitioned implementation into Goal/Protocol, Query/Prompt/compression, and Web/Skill/documentation workstreams.
- Completed the Web/Skill workstream:
  - Web explicitly removes `goal-notice` parts before conversation/workstream rendering, including compression original-range views.
  - `run-goal` now treats the latest notice as objective/status/blocked-reason authority; `get_goal` is accounting-only.
  - Title generation and memory extraction ignore internal Goal notices as user input.
  - Updated the active `AGENTS.md` contract and left historical plans plus unrelated dirty documentation untouched.
- Completed the Goal/Protocol workstream:
  - Added strict GoalNotice, Reminder delivery/source, blocked-reason bound, and current-contract invariant.
  - Goal semantic mutations now produce canonical state, SSE state event, and pending model notice atomically.
  - Materialization is ordered, high-water bounded, idempotent, and stores a provenance-free internal user-role message.
  - `create_goal` returns a compact operation receipt.
  - Tightened the invariant after integration review: Goal reminders and messages now form a complete Root Lead-only one-to-one chain; half-materialized states fail closed instead of being repaired.
  - Aligned Protocol UUID guards with strict persistence schemas and corrected the plan's initially under-specified absent-Goal invariant.
- Completed the Query/Prompt/compression workstream:
  - Removed Goal from Prompt runtime/current-context/overlay contracts.
  - Added fail-closed pre/post compact materialization phases.
  - Moved durable Step start after model-context preparation, prompt projection, Hooks, and tool resolution.
  - Added safe GoalNotice projection plus hard-compact/DCP carry-forward from persisted messages only.
  - Preparation errors remain durable without fabricating a Step.
- Closed the remaining semantic read bypass:
  - `get_goal` now returns only optional token budget plus token/execution accounting.
  - Objective, status, blocked reason, identity, generation, and semantic timestamps are available to the model only through GoalNotice.
- Added direct AC-01 through AC-05 mechanism tests for Prompt stability, the semantic notice matrix, high-water ordering, persistence failure plus restart, compaction carry-forward, provenance isolation, statistics, and strict Store load.
- During full integration verification, found an existing Runtime shutdown race: a queued Automation start could remain between admission and active execution after shutdown returned.
  - Added a one-way ExecutionManager shutdown admission and pending-start barrier.
  - Runtime shutdown now stops Automation schedulers, drains pending starts, cancels active work, and only then disposes remaining resources.
  - No retry, sleep, error swallowing, or Goal persistence fallback was added.

## Verification

- Web/Skill focused tests: 92 passed.
- Web typecheck: passed.
- Goal/Protocol focused and Store tests: passed.
- Agent Core typecheck: passed in both core workstreams.
- Goal acceptance expansion: 127 focused tests passed; Query Loop rerun: 21 passed.
- Runtime shutdown regression: ExecutionManager 102 passed; Automation integration 1 passed.
- Full repository typecheck: 5/5 workspaces passed.
- Full repository test graph: 8/8 tasks passed, including Agent Core unit/integration/architecture, Web, Server, Protocol, and Utils.
- Production build: passed, including Web assets and compiled binary pipeline.
- `git diff --check` and exact legacy-overlay scan: passed.

## Review

- Domain, acceptance, and integration audits found and drove the fixes recorded above.
- Fresh independent `sol(xhigh)` final review returned `VERDICT: APPROVED` with no blocking or high-severity findings.
