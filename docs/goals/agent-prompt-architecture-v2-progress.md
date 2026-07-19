# Agent Prompt Architecture V2 Progress

## Execution

- Goal: `docs/goals/agent-prompt-architecture-v2-plan-goal.md`
- Branch: `codex/agent-prompt-architecture-v2`
- Worktree: `/Users/bo/.codex/worktrees/b7e2/archcode`
- Started: 2026-07-18

## Current Status

- Plan Goal copied into the isolated worktree.
- Plan review completed through fix/review cycles; final result: `APPROVED`.
- Implementation started from `main` at `ca5ffaf` and is complete in this worktree.
- Prompt/compiler, delegation/result contract, Execution ownership, Goal review, Web projection, Prompt trace, and deterministic eval surfaces are implemented.
- Worktree dependencies installed with Bun 1.3.13. The sandboxed attempt could not create worktree symlinks; the same frozen-lockfile install succeeded with worktree filesystem permission.
- Final independent implementation review: `APPROVED`; AC-01 through AC-08 all pass.

## Workstreams

- Prompt contract/compiler and eight role contracts: implemented.
- Delegation contract and canonical child result: implemented; targeted contract/tool tests pass.
- Execution ownership and Goal Reviewer handoff: implemented; final runtime-focused suite passes 306 tests.
- Unified cross-model Prompt and deterministic live-eval command: implemented.
- Full verification after the first review fixes: passed. Independent second review: `APPROVED`.

## Locked Decisions

- Hard cut only: no legacy Prompt builder, old delegate fields, persisted-child migration, free-text result fallback, or provider-specific full Prompt variants.
- Eight Agent roles remain; Prompt, Skill, runtime, and Tool Contract ownership stay separate.
- Real-model live eval is a later release gate, not this Goal's `DONE` condition.

## 2026-07-19 Simplification Revision

- Removed the required model `capabilities` configuration and Settings controls as an overdesigned user-facing boundary.
- Removed Model Overlay compilation; all models now receive the same Prompt contracts.
- Replaced model-dependent structured-result correction with one universal rule: one correction attempt, then `CHILD_RESULT_REQUIRED`.
- Kept provider/model differences confined to API call options and immutable Execution model binding.
- Verification: `bun run typecheck`, the complete `bun run test`, and `bun run build` all passed; the production-source hard-cut search found no retired capability field or Prompt overlay input.
- Browser QA with an isolated valid config passed: Models settings rendered without the three retired controls, a model-name edit saved through `PUT /api/config`, the saved state was acknowledged, and the browser console had no errors.
- The real user config was not modified. Startup correctly rejects it because two configured models still contain the retired `capabilities` object; those objects must be deleted before the local server can start on the new hard-cut schema.

## 2026-07-19 Simplification Review Cycle

- Independent `sol(xhigh)` review initially returned `NOT_APPROVED`: correction failures were counted only inside the current physical Execution, so a HITL `tool_batch` continuation with a new Execution id could incorrectly reset the one-correction quota. It also found two stale Goal acceptance statements referring to the removed model capability profile.
- Fixed the quota around the logical execution lineage: a `tool_batch` continuation inherits failures through its preceding continuation chain, while an explicit non-continuation `resume_session` Execution starts a fresh quota.
- Added ordinary child, Goal Reviewer, explicit-resume reset, and cross-model identical-Prompt assertions; corrected the locked decisions and AC-01 wording.
- Post-fix validation: 28 focused tests passed, uncached five-workspace typecheck passed, the complete eight-task test graph passed, production build passed, and `git diff --check` passed.
- Second independent `sol(xhigh)` review returned `APPROVED`; it confirmed both findings are closed and found no new blocker.

## Verification

- Delegation/submit/delegate targeted suite: 14 passed, 0 failed after the root-level contract tightening.
- Prompt/compiler workstream targeted suites: 98 passed; query-loop-inclusive suite: 169 passed.
- Capability protocol/server/web/Settings targeted suites: 62 passed.
- Final Execution/ownership/Goal review targeted suite: 306 passed, 0 failed, 1102 assertions across 15 files.
- `bun run typecheck`: passed across all five workspaces.
- `bun run test`: passed across all five workspaces, including agent-core unit, integration, and architecture lanes.
- `bun run build`: passed; Web production assets and the embedded server manifest were generated successfully.
- `git diff --check`: passed.
- Hard-cut search found no production old Prompt builder, `promptProfileId`, fixed 2-4/Explore fan-out, free-text child-result fallback, provider/model Prompt fork, or old delegate input path. The only `2-4` textual matches were UUID substrings in a Web interaction fixture.
- First independent `sol(max)` implementation review: `NOT_APPROVED`. It found five concrete gaps; all five are fixed and covered by negative tests before the second review.
- Second independent `sol(max)` review: `APPROVED`; its high-risk suite passed 309 tests with 1260 assertions, and it found no new high- or medium-risk defect.

## Architecture Corrections

- `ChildResult` must map every durable acceptance criterion id to `passed | failed | unverified` plus evidence refs. Generic evidence without this mapping cannot support deterministic parent acceptance. This tightens the approved contract without adding a second result path.
- A `completed` ChildResult now requires at least one evidence ref for every passed criterion; an empty evidence mapping cannot satisfy deterministic acceptance.
- `DelegationContract.agent_type` is limited to the five actual child roles (`plan`, `build`, `reviewer`, `explore`, `librarian`) at the model-visible schema boundary instead of accepting arbitrary strings and failing later.
- Canonical child receipts are persisted only as `child-result` events and projected during hydration. This preserves one authority source while still hard-failing legacy child Sessions that lack V2 delegation identity.
- A first acceptance-gap audit rejected the initial implementation as not done. It found stale Web delegate DTO parsing, missing Skill-load error traces, phase-insensitive Goal Lead transitions, post-create admission checks, task/execution status conflation, and an unenforced best-effort result correction limit. Those gaps were fixed before full validation; the earlier targeted green tests were not treated as Goal acceptance.
- `AGENTS.md` is itself injected Project Instructions, so stale architecture descriptions are a behavioral bug rather than cosmetic documentation. Its old builder, persona, delegation, memory injection, and model configuration descriptions were updated to the V2/runtime facts.
- Full test execution exposed stale fixtures that targeted the removed contract: non-UUID Session ids, child Sessions without V2 delegation identity, and old delegate/background/resume schema assertions. These were hard-cut to the new contract instead of adding runtime compatibility.
- Environment rendering retains concise Git/non-Git operating guidance, and Skill metadata keeps `allowed_tools` visible while explicitly remaining guidance-only; both help models understand capabilities without granting authority.
- Existing-child activation now has one shared admission path for direct, Queue, tool-batch, and resume. It revalidates the exact parent, target, depth, Goal phase, Skill identity, dependency status, and durable contract before activation; failed admission releases only a newly created Agent cache.
- Runtime Envelope now includes the exact parent Agent. Goal-phase delegate targets come from the same Goal delegation policy, and lint accepts only a phase-aware subset of the Role contract. All 27 exact legal child/root combinations plus the full child parent-role matrix are tested.
- `depends_on` now requires both Execution `completed` and ChildResult task `completed`; `partial`, `blocked`, and `failed` receipts cannot unlock downstream work.
- Goal Reviewer `finalize_review` and ordinary `submit_child_result` share one canonical structured-result correction gate. Every model receives one correction attempt; a repeated invalid result fails with `CHILD_RESULT_REQUIRED`.
- Child creation/link/start rollback now removes newly activated Agent caches without disposing a pre-existing warm Agent.
