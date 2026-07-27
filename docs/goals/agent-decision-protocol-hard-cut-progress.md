# Agent Decision Protocol Hard-Cut Progress

## Status

- Started: 2026-07-27
- State: Complete
- Plan: `docs/goals/agent-decision-protocol-hard-cut-plan-goal.md`

## Scope

- [x] Remove fixed Ask User recommendation presentation.
- [x] Simplify Automation confirmation to Lead-owned semantic judgment.
- [x] Remove Goal creation budget text parsing and initial service budget input.
- [x] Remove Goal Review verdict/provenance Runtime protocol.
- [x] Preserve only current typed boundaries, atomic Goal generation fencing, HITL transport, and active-child lifecycle safety.
- [x] Remove stale current-contract documentation without fallback, migration, or tombstone tests.

## Execution Log

### 2026-07-27 — Start

- Re-read the approved plan and current worktree before implementation.
- Confirmed the worktree initially contained only the untracked plan document.
- Split implementation into independent Ask User/Automation, Goal Review, Goal budget, and read-only inventory workstreams.

### 2026-07-27 — First-principles boundary

- Kept `ask_user` HITL transport, redaction, persistence, and suspend/resume; only model-facing presentation rules and domain semantic claims are being removed.
- Kept Goal `expectedInstanceId` / `expectedGeneration` completion fencing and the existing active-child lifecycle safety fact.
- Rejected replacement classifiers, receipts, approval tokens, recommendation fields, Review state, compatibility readers, migrations, and tombstone tests.
- Read-only inventory confirmed `AGENTS.md` and `docs/agents/multi-agent-design.md` are current-contract documents that must change; historical independent-review verdict records are evidence, not production contracts.

### 2026-07-27 — Implementation

- `ask_user` requires a clear recommendation to appear first, but no longer prescribes a fixed suffix, language, or label. The existing question/options/free-text transport and bounds remain unchanged.
- Automation creation now asks for a complete proposal response and leaves accept/revise/decline interpretation to Lead. Todo activation only activates the shared Automation Skill.
- `create_goal` and `SessionGoalService.create()` now accept objective-only creation. Budget-like text remains objective text; the existing API/UI budget control remains the only budget mutation path.
- Deleted Goal Review binding types, persistence, execution admission/resume rules, verdict parsing, Reviewer Session lookup, write-freshness scanning, and `review-provenance.ts`.
- `update_goal({ status: "complete", reason })` now uses the current active Goal instance/generation and the existing family active-child check. Analyst Review remains a Skill-guided work method interpreted by Lead.
- Updated current architecture documents and classified older plans whose fixed Review contracts are historical. No compatibility reader, migration, fallback, replacement protocol, or tombstone test was added.
- Removed exact-wording assertions that would have replaced the deleted protocol with a new test-owned wording contract.

## Verification Evidence

- Ask User / Automation subtask: 50 focused tests passed; Agent Core typecheck passed.
- Goal hard-cut subtask: Agent Core typecheck passed; 2,691 unit tests and 126 integration tests passed, including targeted store, execution, prompt, and full-runtime flows.
- Exact searches found no old production identifier, parser, binding, fixed Goal/Automation/Ask User wording, fallback, compatibility path, migration, or replacement protocol in current code and active contract documents.
- `bun run typecheck`: 5/5 packages passed.
- Agent Core: 2,691 unit, 126 integration, and 77 architecture tests passed.
- `bun run test`: 8/8 Turborepo tasks passed.
- `bun run build`: passed, including production Web assets and temporary production entrypoint generation.
- `git diff --check`: passed.

## Independent Review

- Independent `gpt-5.6-sol(max)` review found no blocking/high production-code issue.
- Its only High finding was that this progress document still reported pending verification/review. Two Low cleanup findings identified a tombstone-like `old_callback_field` test fixture and `Confirmed display name` schema wording.
- All three findings were fixed.
- Independent `gpt-5.6-sol(max)` re-review found no remaining blocking, high, medium, or low finding and confirmed that no new protocol, compatibility path, wording contract, or acceptance gap was introduced.
