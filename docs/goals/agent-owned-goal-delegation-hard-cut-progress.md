# Agent-Owned Goal And Delegation Hard-Cut Progress

Authoritative plan: `docs/goals/agent-owned-goal-delegation-hard-cut-plan-goal.md`

## Status

- State: complete; independent final re-review approved
- Started: 2026-07-20
- Baseline: clean worktree except the new untracked plan-goal document

## Work Log

### 2026-07-20 — Implementation start

- Locked the reviewed hard-cut plan as the sole acceptance contract.
- Split implementation into three parallel workstreams: delegation/child completion, Goal domain simplification, and Prompt/UI/server cleanup.
- Root integration owns execution-manager/runtime wiring, cross-workstream type fixes, full validation, and final independent review.
- Delegation workstream: `gpt-5.6-sol(high)` owns protocol/store/tools/SessionExecutionManager child termination hard cut.
- Goal workstream: `gpt-5.6-sol(high)` owns the minimal Goal schema/service and removal of review/evaluator modules.
- Prompt/UI workstream: `gpt-5.6-sol(medium)` owns all role contracts, prompt compiler, Web/dashboard projections, and `AGENTS.md` cleanup.

### 2026-07-20 — Goal domain and runtime simplification

- Goal workstream reduced `SessionGoalService` to create/edit/pause/resume/clear/budget/usage/block/complete and deleted the evaluator, review gate, review source monitor, coordinator, fingerprint, and their obsolete tests.
- Runtime integration removed Goal review/remediation callbacks and replaced the stateful coordinator with local idle/startup reconciliation based only on active Goal state, Session family activity, HITL/tool-batch/queue gates, and budget status.
- Startup and explicit user resume/budget controls use the same predicate with an explicit recovery override; ordinary failed root Executions do not enter a Goal-specific retry loop.

### 2026-07-20 — Agent-owned mandatory Review

- `update_goal(status=complete)` now requires `review_session_id` and validates one direct Reviewer child of the current root Engineer.
- Completion reads only that Reviewer Session's latest Execution, requires the Execution itself to be `completed`, and accepts only a canonical final output whose first non-empty line is exactly `VERDICT: APPROVED`.
- No approval result, receipt, claim, hash, or Reviewer state is copied into Goal state; a successful validation writes `complete` directly through `SessionGoalService`.
- Targeted Goal tool tests cover direct Reviewer identity, latest Execution binding, strict verdict parsing, stale approval rejection, and every non-qualifying outcome.

### 2026-07-20 — Delegation and surface hard cut

- Replaced `DelegationContract` with strict six-field `DelegationRequest`; removed contract hashes, dependency receipts, `new_evidence`, `submit_child_result`, structured-result correction, ChildResult receipts/events, and their persistence/UI paths.
- Added `finalOutputForExecution` as the only completed-child text reader used by synchronous delegate, background output, reminders, and Goal completion.
- Updated every delegated role, Prompt compiler, model-visible tool contract, Dashboard, Goal row, delegation cards, tool formatting, protocol projections, and `AGENTS.md` to the new architecture.

### 2026-07-20 — Live QA simplification

- A real browser Goal ran the full cycle: Reviewer `ebada269-08cb-46dd-bff9-424b9e7c5d48` returned `VERDICT: CHANGES_REQUESTED`; Engineer fixed the file; Reviewer `55707a98-69df-4c01-8cf8-72d1517cd893` returned `VERDICT: APPROVED`; Goal became complete and remained complete after reload with zero browser console warnings/errors.
- Live QA exposed one remaining ambiguity: model-visible `update_goal` mixed user control `action` variants with Agent-owned `status` variants. Hard-cut the tool to strict `status: "complete" | "blocked"`; edit/pause/resume/clear/budget remain direct API/UI controls.
- A second real browser Goal completed with one successful `update_goal` call and no schema error. The temporary QA project and files were removed afterward.

### 2026-07-20 — Independent review repair

- The first independent final review found two acceptance gaps: `waiting_for_human` background output could expose assistant text without an explicit non-final label, and the continuation gate matrix was under-tested.
- `background_output` now labels both running and waiting Sessions as non-final in its actual output and model-visible contract, with a regression test that includes waiting assistant text.
- Goal continuation remains one stateless Runtime function, not a service or workflow state machine. Table-driven tests now cover completed/max-steps, startup recovery, queue precedence, non-idle/HITL blocking, every inactive Goal status, prohibited root terminals, and concurrent admission. Execution-manager and architecture tests prove child terminals release the same root-family idle signal consumed by that function.
- The same independent `gpt-5.6-sol(max)` reviewer re-inspected the fixes and returned `VERDICT: APPROVED` with no remaining blocker.

## Acceptance Evidence

- **AC-01 complete:** ordinary assistant final text is the only child result; all terminal mappings, empty output, background output, resume, and stale-Execution cases are covered by delegation/final-output, execution-manager, delegate, and background-output tests. Removed result tools and receipt paths are absent from production.
- **AC-02 complete:** delegate accepts exactly six required fields; resume accepts exactly three required fields. Strict rejection tests cover every retired field; Build scope/depth/Skill/lease admission tests remain green.
- **AC-03 complete:** Goal persistence is the compact objective/status/budget/usage/timestamp record. Strict schema rejects all removed review/evaluator/remediation/source/retry fields; UI and Dashboard project only current fields.
- **AC-04 complete:** completion requires the current root Engineer plus one direct Reviewer whose latest completed Execution begins exactly with `VERDICT: APPROVED`. Missing, stale, malformed, running, indirect, wrong-root, wrong-role, and CHANGES_REQUESTED cases reject completion.
- **AC-05 complete:** Engineer owns review/fix/re-review; Reviewer returns normal Markdown and cannot modify Goal. Runtime creates neither Reviewer nor remediation work.
- **AC-06 complete:** one stateless reconciliation function handles root terminal, child terminal, and startup recovery; completed/max-steps, active/idle/HITL/tool-batch/queue/budget/status gates, startup override, concurrent admission, and prohibited-root no-retry behavior are directly tested. No evaluator, retry timer, or second scheduler remains.
- **AC-07 complete locally:** `bun run typecheck`, `bun run test`, `bun run build`, and `git diff --check` exit 0. Final `bun run test` reports all 8 Turbo tasks successful; Agent Core lanes report 2626 unit, 130 integration, and 93 architecture tests passing. The required production legacy-term search returns zero matches. Full browser review/fix/re-review/reload QA passed with zero console errors.
