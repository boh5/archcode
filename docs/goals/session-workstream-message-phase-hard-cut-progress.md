# Session Workstream Message Phase Hard-Cut Progress

Source goal:
`docs/goals/session-workstream-message-phase-hard-cut-plan-goal.md`

Status: Complete. Implementation, verification, and final independent review
all passed.

## Locked implementation decisions

- One logical Execution remains authoritative; each canonical UserMessage starts
  one Web-only Work Segment.
- `SessionStep.id` is the unique provider-attempt identity. The numeric `step`
  remains the logical cursor.
- Model-step Assistant messages own `stepId` and normalized output phase.
  Assistant output and Reasoning parts own only provider block identity.
- Only trusted, non-empty `finishReason: "stop"` output from the final
  no-continuation attempt may become `final_answer`.
- Process-local provider retry creates a new attempt. Process restart
  terminalizes the old Execution as interrupted and never retries it in place.
- The old Session schema is intentionally unsupported; no migration, fallback,
  dual read/write, feature flag, or tombstone test will be added.

## Work log

### 2026-07-28 — Start

- Re-read the reviewed plan-goal and confirmed the current worktree contains
  only the untracked goal document.
- Established parallel work lanes for Protocol/Runtime, Web projection, and
  SessionPart consumer coverage.

### 2026-07-28 — First-principles audit corrections

- Found that provider-attempt identity must also reach durable Tool Batches.
  Keeping only numeric `step` would make a failed attempt and its retry
  ambiguous. Implementation therefore requires `SessionToolBatch.stepId` and a
  required `assistantMessageId`; numeric `step` remains only a cursor.
- Found that optional `stepId/outputPhase` fields on the current generic message
  schema would still accept the old Assistant `TextPart` shape. The hard cut
  therefore requires a role/source-discriminated persisted message schema:
  canonical user messages own user text; model-step Assistant messages require
  attempt identity/phase and own Assistant output.
- Confirmed that process restart must close the old Execution as interrupted.
  Restart repair cannot create a same-Execution provider retry. Preserving the
  existing lifecycle boundary, Store load may repair incomplete block
  projection, but SessionExecutionManager startup reconciliation remains the
  sole writer of the interrupted `execution-end`.
- Expanded the consumer audit to include model/full-history projection,
  synchronous delegation, background output, compression protection, durable
  retry detection, restart repair, Navigation, and CompressionBlock rendering.
  Title generation, message conflict projection, and memory extraction remain
  intentionally user-text-only.
- Updated active concept/Web architecture docs and marked the earlier logical
  Execution goal's superseded Web-display clauses without changing its
  historical progress.

### 2026-07-28 — Parallel implementation

- Web now projects `inputMessage? + ordered workItems + finalResponse`, with no
  input batching, `outputMessages`, or Execution-wide Reasoning placeholder.
  Each UserMessage gets a Segment; commentary/Reasoning/tools preserve order;
  final output is phase-owned; token-only Reasoning is per attempt.
- Protocol/Runtime now use unique provider-attempt IDs, strict provider block
  IDs, normalized step usage, strict model-step Assistant messages,
  message-level output phase, and exact Tool Batch attempt/message identity.
- QueryLoop uses provider start/delta/end boundaries and separates in-process
  retries into new attempts. Final candidate identity propagates through
  ConfiguredAgent to SessionExecutionManager.
- Runtime validates `finalOutputStepId` against steps/messages before mutation.
  Only trusted non-empty `stop` output is eligible.
- Migrated model projection, delegation final output, background output,
  compression protection, compact, memory/title user-text boundaries, Web
  Navigation, CompressionBlock, and SSE fixtures.

### 2026-07-28 — Independent review fixes

- Kept retry numbering/backoff at QueryLoop scope so fresh attempt IDs do not
  reset recovery limits.
- Preserved provider block order through redaction buffering, pruned empty
  anchors from UI/counts, and rejected duplicate, late, unknown, blank, or
  secret-bearing provider block IDs before Store/SSE persistence.
- Tightened final authority: the selected attempt must be the last attempt,
  completed with `stop`, and all its output blocks must be trusted. Cold-load
  schema validation now reuses the same rule and rejects final output on a
  nonterminal Execution.
- Made abort/restart/late-event handling discard partial attempts exactly,
  without moving the current Assistant pointer or settling a reused Tool call
  against an older attempt.
- Migrated the remaining full-runtime text-stream fixture to the strict
  start/delta/end contract; no compatibility path was introduced.

## Verification

- Web typecheck passed.
- Web tests passed: 549 unit and 90 interaction tests.
- Protocol tests passed: 136/136.
- Consumer tests passed: 197 tests / 491 assertions.
- Protocol/store/query/Manager new hard-cut contract tests passed in their
  owning implementation lane.
- Strict Store/persistence/Tool Batch fixture migration passed: 252 tests, with
  no compatibility wrapper, Proxy, or fallback.
- `bun run typecheck`, `bun run test`, `bun run build`, and `git diff --check`
  exited `0`. The final serial full run completed all 8 workspace tasks,
  including 136 Agent Core integration tests, 79 architecture tests, 256 Server
  tests, 90 Web interaction tests, and every Protocol test.
- Production residue searches found no old `outputMessages`, adjacent input
  batching, Assistant `TextPart` persistence, implicit stream-block start,
  legacy phase inference, or Execution-wide Reasoning-token aggregation.

### Browser QA

- The three old reproduction Sessions were all confirmed to contain the
  intentionally unsupported Assistant `TextPart` shape. The original directory
  was preserved unchanged at
  `sessions.pre-message-phase-hard-cut-20260728T2008`, and a fresh strict Session
  was created as `89c0a4f7-260e-4e5b-b820-2bde58ccff66`.
- Fresh production-build QA rendered the reported sequence inside Work as
  commentary → `git_status` → commentary → `file_read` → commentary →
  `file_read`; the final response appeared once below Work.
- Refresh/cold projection preserved that order. Separate canonical user inputs
  produced separate disclosures and navigation markers.
- A second fresh strict Store Session,
  `6166e002-14a8-4d74-a6ef-4eb2ee595ca1`, manually verified two independently
  expandable real Reasoning blocks around commentary plus token-only items
  `137` and `56`; no `193` aggregate appeared.
- Reload/cold load preserved the same structure, the final response appeared
  exactly once below Work, and no blank attempt rendered.
- AskUser suspend/resume, tool failure, and Todo completion all preserved Work
  ordering and a single final response.
- At 390 × 844, document and body `scrollWidth` both equalled `clientWidth`
  (`390`); no horizontal overflow or browser console warning/error appeared.

## Review

- A fresh independent `sol(max)` reviewer drove multiple fix/review cycles.
- All reported blocking/high issues have been fixed and independently
  rechecked.
- Final verdict: **PASS** for AC-01 through AC-08, with no remaining
  blocking/high or medium/low findings.
