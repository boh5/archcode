# Workflow Subtraction Tier 1+2 Plan

## TL;DR

> **Quick Summary**: Reduce ArchCode Workflow token cost and structural complexity with a focused clean-break refactor: compact high-volume workflow outputs, truncate artifact reads, deduplicate workflow prompts, and delete state-machine adapter layers without changing the existing three workflow type paths.
>
> **Deliverables**:
> - Compact workflow tool result formatting for high-volume state-returning tools.
> - `artifact_read` truncation/pagination support with explicit full-read escape hatch.
> - Deduplicated orchestrator workflow instructions and workflow intent gate prompt coverage.
> - Direct removal of standalone `critic-protocol.ts`; Orchestrator owns Critic-result interpretation instead of using a coded state-machine translation layer.
> - Existing `workflow_update_stage` remains the lifecycle mutation tool and must expose a generic terminal status/lastError path for reject, pause, and retry-exhausted outcomes without adding an 11th workflow tool.
> - Removal of `foreman-wave.ts` and `foreman-wave.test.ts` because current references show it is test-only scaffolding.
> - Existing `research_only`, `quick_fix`, and `full_feature` workflow type paths stay intact; this plan does not collapse them into one pipeline.
> - AGENTS.md workflow tool count correction from stale 6-tool wording to current 10 registered workflow tools.
>
> **Estimated Effort**: Large
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: T1 → T4/T5/T6 → T9 → T12 → F1-F4

---

## Context

### Original Request
User asked to evaluate whether Workflow has become too complex/token-expensive and to study OMO from `docs/links.md` for subtraction inspiration. After research and explanation, user confirmed: **“1 和 2 都应该做，帮我做个 plan”**.

### Interview Summary
**Key Discussions**:
- User wants Tier 1 and Tier 2 subtraction, not radical OMO rewrite.
- Tier 1 means token-cost reduction: compact workflow JSON outputs, truncate artifact reads, deduplicate prompt instructions.
- Tier 2 means structural simplification: remove thin state-machine wrappers and delete test-only Foreman wave module. The earlier single-pipeline idea is explicitly removed from scope.
- Metis/tool audit corrected one earlier overreach: **do not delete or merge any of the 10 workflow tools**. They are active and tested; AGENTS.md is stale.
- User clarified: **no compatibility, no fallback, no migration** for removed adapters/helpers. User then corrected the scope: do **not** collapse the existing three workflow types.
- User clarified: each independent implementation task should commit when appropriate, and the executing agent must dispatch independent tasks in parallel aggressively.
- Momus review identified a blocker: deleting `criticDecision` removes the only current tool path to call `stateManager.fail(...)`. Resolved by requiring `workflow_update_stage` to provide a generic, non-critic-specific lifecycle status update path for `failed`/`paused` plus `lastError` while still deleting the critic adapter.

**Research Findings**:
- OMO has no formal workflow state machine; it uses markdown plans + todos + lightweight state pointers.
- ArchCode workflow subsystem is approximately 7,740 lines including production and tests.
- Highest workflow token sources are full WorkflowState JSON returns, full artifact bodies, and duplicated workflow prompt instructions.
- `artifact_read.ts:87-93` currently returns both `content` and `body` in full.
- `workflow-read.ts:22-23`, `workflow-create.ts:61-67`, `workflow-record-completion.ts:30-36`, `workflow-complete.ts:52-54`, and `workflow-update-stage.ts:61-68,103-106` return full state/result JSON.
- `workflow-propose-interactions.ts:108-115` embeds full `state` in its output and should be compacted.
- `workflow-request-interactions.ts` already returns summaries, but should be checked for accidental full state expansion after helper changes.
- `critic-protocol.ts` is actively imported by `workflow-update-stage.ts:5-9`, but it is only a Critic-result-to-state-transition adapter. Under clean-break rules, delete it and remove `criticDecision` special handling from `workflow_update_stage`; Orchestrator should explicitly drive stage changes and terminal lifecycle updates through generic fields on the existing tool.
- `foreman-wave.ts` is referenced only by `foreman-wave.test.ts` and is safe to remove if grep remains clean.
- `workflow-types.ts` has the type/stage matrix: `research_only`, `quick_fix`, `full_feature` and their stage transitions/prerequisites. This matrix must be preserved.
- `prompt/sections/workflow-intent-gate.ts` duplicates many rules already present in `agents/definitions/orchestrator.ts`.

### Metis Review
**Identified Gaps** (addressed):
- Initial “merge/delete workflow tools” idea is unsafe because all 10 tools are active. **Resolved**: plan forbids merging/removing tools and adds AGENTS.md correction instead.
- `critic-protocol.ts` is production-used but conceptually redundant. **Resolved**: plan deletes it cleanly and rewrites Orchestrator/tool semantics so Critic decisions are handled by Orchestrator instructions, not a tool-level `criticDecision` adapter.
- Workflow type collapse was proposed earlier. **Resolved**: user corrected the scope; do not implement single-pipeline collapse and preserve the current three type paths.
- Removing `criticDecision` creates a terminal failure contract gap. **Resolved**: do not add a new tool; extend/reshape existing `workflow_update_stage` to handle generic `status: failed|paused` and `lastError`/reason updates, so Critic rejection and retry exhaustion remain expressible without a critic-specific adapter.
- Need measurable token wins. **Resolved**: plan adds tests for compact outputs and truncation metadata.

---

## Work Objectives

### Core Objective
Implement Tier 1+2 Workflow subtraction as a focused clean-break refactor while preserving workflow tool names, safety gates, and the existing three workflow type paths. The implementation should remove avoidable token volume first, then delete redundant adapter/helper layers without changing `research_only`, `quick_fix`, or `full_feature` as separate workflow types.

### Concrete Deliverables
- Compact workflow output formatter used by state-returning workflow tools.
- Artifact read truncation with configurable `maxChars` and `includeFullContent`/equivalent escape hatch.
- Prompt deduplication between orchestrator role prompt and workflow intent gate.
- Critic protocol deletion and removal of `criticDecision` adapter semantics from `workflow_update_stage`.
- Generic terminal lifecycle updates on `workflow_update_stage` for failed/paused outcomes and `lastError`.
- Deletion of test-only Foreman wave simulation module and its tests.
- Workflow type/guard preservation checks ensuring the three current workflow type paths are not changed by this plan.
- AGENTS.md workflow tool documentation correction.

### Definition of Done
- [ ] `bun run typecheck` passes.
- [ ] `bun run test` passes.
- [ ] Workflow tool tests cover compact output and artifact truncation behavior.
- [ ] Prompt builder tests verify deduplicated workflow instructions still include required gating rules.
- [ ] Critic-result handling is documented in Orchestrator prompt and no source file imports `critic-protocol.ts`.
- [ ] Critic rejection and retry-exhaustion have an executable path via existing `workflow_update_stage` generic terminal status fields, not `criticDecision`.
- [ ] No production or test imports remain for deleted `foreman-wave.ts`.
- [ ] AGENTS.md no longer claims only 6 workflow tools.

### Must Have
- Preserve all 10 workflow tool names and registrations.
- Preserve workflow UUID validation and active-workflow guards.
- Preserve user approval gate before `foreman_executing`.
- Preserve critic retry/max-retry behavior.
- Preserve ability to set workflow terminal failure/paused status and `lastError` through an existing workflow tool.
- Preserve `workflow_propose_interactions` vs `workflow_request_interactions` role boundary.
- Preserve `artifact_read` multi-file listing behavior.
- Preserve the existing workflow type/stage matrix: `research_only`, `quick_fix`, `full_feature`.

### Must NOT Have (Guardrails)
- Do NOT delete, merge, rename, or unregister any of the 10 workflow tools.
- Do NOT remove `artifact_write`, `workflow_task_check`, or interaction tools as part of this plan.
- Do NOT turn compact output into lossy state mutation; only tool-return formatting changes.
- Do NOT silently bypass user approval before Foreman.
- Do NOT break workflow SSE events.
- Do NOT add compatibility shims, fallback branches, migration code, or dual-path old/new workflow logic for removed adapters/helpers.
- Do NOT collapse `research_only`, `quick_fix`, and `full_feature` into one pipeline.
- Do NOT keep `criticDecision` as a `workflow_update_stage` special-case adapter.
- Do NOT add an 11th workflow tool just to replace `criticDecision`; use the existing `workflow_update_stage` tool contract.
- Do NOT rely on manual verification; every check must be command/tool executable.
- Do NOT introduce Node-specific APIs where Bun/native or existing project patterns suffice.

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** - ALL verification is agent-executed. No acceptance criterion may require a person to manually inspect UI or logs.

### Test Decision
- **Infrastructure exists**: YES
- **Automated tests**: TDD / tests-first where practical
- **Framework**: `bun:test`
- **Workflow**: For behavior changes, write/adjust failing tests first, implement minimal fix, then refactor.

### QA Policy
Every task MUST include agent-executed QA scenarios. Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Backend/library**: Use Bash with `bun test ...` and `bun run typecheck`.
- **Prompt/token checks**: Use targeted `bun test` assertions and text-length/substring assertions.
- **Code removal checks**: Use Grep/Glob plus `bun test` to verify no stale imports.

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Foundation + tests, can start immediately):
├── T1: Add compact workflow output formatter tests + helper design [quick]
├── T2: Add artifact_read truncation tests [quick]
├── T3: Add prompt deduplication regression tests [quick]
├── T4: Add clean-break critic/orchestrator lifecycle contract tests [quick]
├── T5: Add Foreman wave removal safety check [quick]
└── T6: Add workflow type/guard preservation tests [quick]

Wave 2 (Core implementation after Wave 1 tests):
├── T7: Implement compact workflow tool output formatter [unspecified-high]
├── T8: Implement artifact_read truncation/pagination [unspecified-high]
├── T9: Deduplicate workflow prompt instructions [unspecified-high]
├── T10: Delete critic protocol adapter and add generic lifecycle status contract [deep]
└── T11: Verify workflow type matrix remains intact [quick]

Wave 3 (Subtraction cleanup + docs after Wave 2):
├── T12: Delete foreman-wave module/test and stale exports [quick]
├── T13: Remove criticDecision schema/tests/imports after clean-break contract [quick]
└── T14: Update AGENTS.md workflow tool documentation to 10 tools [writing]

Wave 4 (Integration hardening):
├── T15: Run targeted workflow test suite and fix regressions [unspecified-high]
├── T16: Run full typecheck/test and capture token-output evidence [unspecified-high]
└── T17: Review diff for subtraction fidelity and no tool-registry creep [deep]

Wave FINAL (After ALL tasks — 4 parallel reviews):
├── F1: Plan compliance audit (oracle)
├── F2: Code quality review (unspecified-high)
├── F3: Real command-line QA (unspecified-high)
└── F4: Scope fidelity check (deep)
```

### Dependency Matrix

- **T1**: None → blocks T7, T15
- **T2**: None → blocks T8, T15
- **T3**: None → blocks T9, T15
- **T4**: None → blocks T10, T13, T15
- **T5**: None → blocks T12, T15
- **T6**: None → blocks T11, T15
- **T7**: T1 → blocks T15, T16
- **T8**: T2 → blocks T15, T16
- **T9**: T3 → blocks T15, T16
- **T10**: T4 → blocks T13, T15, T16
- **T11**: T6, T7-T10 → blocks T15, T16
- **T12**: T5 → blocks T15, T16
- **T13**: T10 → blocks T15, T16
- **T14**: None → blocks T17
- **T15**: T7-T13 → blocks T16, T17
- **T16**: T15 → blocks final verification
- **T17**: T14-T16 → blocks final verification

### Agent Dispatch Summary

- **Wave 1**: 6 quick agents for tests/characterization.
- **Wave 2**: 5 agents: T7/T8/T9 unspecified-high, T10 deep, T11 quick.
- **Wave 3**: 3 agents: T12/T13 quick, T14 writing.
- **Wave 4**: 3 agents: T15/T16 unspecified-high, T17 deep.
- **Final**: 4 review agents.

### Parallel Dispatch Requirements

- The executor MUST dispatch every independent task in a wave concurrently unless the dependency matrix blocks it.
- The executor MUST NOT serialize Wave 1 or Wave 2 “for safety”; safety comes from tests, scope boundaries, and final review, not under-utilization.
- Each task owns 1-3 files/concerns. If implementation discovers a task touches 4+ files for unrelated reasons, split it before coding.
- Each task with `Commit: YES` MUST commit independently after its task-level tests pass, unless the task explicitly groups with another task.

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.
> A task WITHOUT QA Scenarios is INCOMPLETE.

- [x] T1. Add compact workflow output formatter tests + helper design

  **What to do**:
  - Add failing tests in `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts` proving state-returning tools no longer emit full `requiredInteractions`, `resolvedInteractions`, `stageCompletions`, and artifact maps by default.
  - Define the expected compact output shape in tests before implementation: `workflowId`, `type`, `stage`, `status`, `artifactSummary`, `interactionSummary`, `nextAction`/message where useful.
  - Include a negative test ensuring `workflow_read` can still retrieve full state only if the chosen clean-break API explicitly supports full reads; otherwise update expectations to compact-only.

  **Must NOT do**:
  - Do not implement formatter in this task unless necessary to make test scaffolding compile.
  - Do not remove or rename any workflow tool.

  **Recommended Agent Profile**:
  - **Category**: `quick` — focused test/spec task in one test file.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `review-work` — final review only, not needed for test authoring.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T2-T6
  - **Blocks**: T7, T15
  - **Blocked By**: None

  **References**:
  - `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts:68` - Existing workflow tool registry/test harness.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-read.ts:22` - Current full-state return to replace.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-create.ts:61` - Current create tool full-state return.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-record-completion.ts:30` - Current completion metadata full-state return.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-complete.ts:52` - Current complete tool full-state return.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-propose-interactions.ts:108` - Current interaction proposal output embeds full state.

  **Acceptance Criteria**:
  - [ ] Tests fail before implementation because outputs are currently full JSON blobs.
  - [ ] Tests assert compact output does not contain large body fields or raw interaction arrays by default.

  **QA Scenarios**:
  ```
  Scenario: Compact output test fails before formatter exists
    Tool: Bash
    Preconditions: T1 tests added, implementation not yet complete
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts`
      2. Capture output to `.sisyphus/evidence/task-1-compact-tests-red.txt`
    Expected Result: New compact-output assertions fail against current full-state outputs
    Failure Indicators: Test command passes without implementation or fails for unrelated syntax/type errors
    Evidence: .sisyphus/evidence/task-1-compact-tests-red.txt

  Scenario: Tests target exact state-returning tools
    Tool: Bash
    Preconditions: T1 tests added
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t compact`
      2. Verify output names at least workflow_create/workflow_read/workflow_update_stage/workflow_record_completion/workflow_complete/workflow_propose_interactions cases
    Expected Result: Targeted tests execute and fail only because compact formatter is absent
    Failure Indicators: No matching tests run or failures reference unrelated test setup
    Evidence: .sisyphus/evidence/task-1-targeted-compact-tests.txt
  ```

  **Commit**: YES
  - Message: `test(workflow): characterize compact workflow outputs`
  - Files: `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts`
  - Pre-commit: `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t compact`

- [x] T2. Add `artifact_read` truncation tests

  **What to do**:
  - Add failing tests in `workflow-tools.test.ts` for `artifact_read` default bounded output.
  - Assert returned JSON includes truncation metadata: `truncated`, `bodyChars`, `returnedBodyChars`, and clear instruction/field for requesting full content or a larger `maxChars`.
  - Add negative test for invalid `maxChars` values if schema exposes `maxChars`.

  **Must NOT do**:
  - Do not remove multi-file list mode for `CRITIC_REPORT` / `EVIDENCE`.
  - Do not truncate path lists; only truncate artifact body/content payloads.

  **Recommended Agent Profile**:
  - **Category**: `quick` — test-focused change in existing tool test file.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `frontend-ui-ux` — no UI work.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1, T3-T6
  - **Blocks**: T8, T15
  - **Blocked By**: None

  **References**:
  - `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts:14` - Current input schema lacks truncation controls.
  - `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts:87` - Current formatter returns full `content` and `body`.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts:208` - Existing artifact read validation test pattern.

  **Acceptance Criteria**:
  - [ ] Default `artifact_read` test expects bounded body output.
  - [ ] Explicit full-content/larger-limit test defines the escape hatch.
  - [ ] Multi-file artifact list test remains unchanged.

  **QA Scenarios**:
  ```
  Scenario: Long artifact body is bounded by default
    Tool: Bash
    Preconditions: T2 tests added
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t artifact_read`
      2. Capture output to `.sisyphus/evidence/task-2-artifact-read-red.txt`
    Expected Result: New truncation test fails because current implementation returns full body
    Failure Indicators: Test passes before implementation or fails from unrelated fixture setup
    Evidence: .sisyphus/evidence/task-2-artifact-read-red.txt

  Scenario: Invalid truncation input is rejected
    Tool: Bash
    Preconditions: Schema test added for `maxChars` or equivalent field
    Steps:
      1. Run targeted artifact_read schema test
      2. Verify invalid value `maxChars: 0` or negative value produces schema/tool error
    Expected Result: Test captures expected validation behavior for invalid truncation controls
    Failure Indicators: Invalid input is silently accepted
    Evidence: .sisyphus/evidence/task-2-artifact-read-invalid-input.txt
  ```

  **Commit**: YES
  - Message: `test(workflow): characterize artifact read truncation`
  - Files: `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts`
  - Pre-commit: `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t artifact_read`

- [x] T3. Add prompt deduplication regression tests

  **What to do**:
  - Update/add tests in `packages/agent-core/src/prompt/builder.test.ts` that assert required workflow rules still appear once after dedupe.
  - Add length/duplication guard: prompt should not include duplicate full stage-flow blocks from both `orchestrator.ts` and `workflow-intent-gate.ts`.
  - Assert workflow prompt still includes: user approval before Foreman, workflow tools usage, interaction batching, artifact reference rules.

  **Must NOT do**:
  - Do not weaken the critical user approval gate.
  - Do not remove active workflow UUID rules from `active-workflow.ts`.

  **Recommended Agent Profile**:
  - **Category**: `quick` — prompt tests in a single test file.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `writing` — implementation uses test assertions, not prose authoring.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1, T2, T4-T6
  - **Blocks**: T9, T15
  - **Blocked By**: None

  **References**:
  - `packages/agent-core/src/prompt/builder.ts:28` - Injects workflow intent gate section.
  - `packages/agent-core/src/prompt/sections/workflow-intent-gate.ts:6` - Current long workflow MVP section.
  - `packages/agent-core/src/agents/definitions/orchestrator.ts:12` - Current long Orchestrator role prompt.
  - `packages/agent-core/src/prompt/builder.test.ts:40` - Current workflow instruction coverage.

  **Acceptance Criteria**:
  - [ ] Tests define exactly which workflow rules must remain after dedupe.
  - [ ] Tests fail if duplicated stage-flow blocks remain.

  **QA Scenarios**:
  ```
  Scenario: Prompt duplication regression test detects current overlap
    Tool: Bash
    Preconditions: T3 tests added
    Steps:
      1. Run `bun test packages/agent-core/src/prompt/builder.test.ts -t workflow`
      2. Capture output to `.sisyphus/evidence/task-3-prompt-dedupe-red.txt`
    Expected Result: New duplication/length assertion fails before prompt refactor
    Failure Indicators: Prompt test passes without dedupe or loses required gate assertions
    Evidence: .sisyphus/evidence/task-3-prompt-dedupe-red.txt

  Scenario: Critical gates remain asserted
    Tool: Bash
    Preconditions: T3 tests added
    Steps:
      1. Run targeted test for `ask_user` before Foreman and interaction batching strings
      2. Confirm assertions mention `workflow_request_interactions`, `artifact_read`, and `Foreman`
    Expected Result: Test explicitly protects workflow safety rules during dedupe
    Failure Indicators: Test only checks length and does not protect semantics
    Evidence: .sisyphus/evidence/task-3-critical-gates-asserted.txt
  ```

  **Commit**: YES
  - Message: `test(prompt): characterize workflow prompt dedupe`
  - Files: `packages/agent-core/src/prompt/builder.test.ts`
  - Pre-commit: `bun test packages/agent-core/src/prompt/builder.test.ts -t workflow`

- [x] T4. Add clean-break critic/orchestrator lifecycle contract tests

  **What to do**:
  - Replace direct `processCriticDecision` expectations with tests that assert the new contract: Critic produces review output; Orchestrator instructions handle approved/changes/rejected by explicit normal tool calls.
  - Add tests expecting `workflow_update_stage` schema no longer accepts or documents `criticDecision`.
  - Add tests defining the generic lifecycle status path on existing `workflow_update_stage`, e.g. terminal `status: "failed" | "paused"` plus `lastError`/reason for Critic rejection, user withholding approval, or retry exhaustion.
  - Add prompt test asserting Orchestrator, not tool adapter, owns Critic-result handling.

  **Must NOT do**:
  - Do not preserve `criticDecision` as hidden backwards compatibility.
  - Do not keep `critic-protocol.test.ts` as a required passing test after clean-break deletion.
  - Do not specify or test a new workflow failure tool; terminal lifecycle status must be expressed through the existing `workflow_update_stage` contract.

  **Recommended Agent Profile**:
  - **Category**: `quick` — test/contract definition.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `safe-refactor` — not available as loaded skill here; executor can still use LSP manually.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1-T3, T5, T6
  - **Blocks**: T10, T13, T15
  - **Blocked By**: None

  **References**:
  - `packages/agent-core/src/agents/workflow/critic-protocol.ts:28` - Adapter function to remove.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-update-stage.ts:27` - Current schema includes `criticDecision`; replace with generic lifecycle status fields.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-update-stage.ts:51` - Current special branch delegates to `processCriticDecision`.
  - `packages/agent-core/src/agents/definitions/orchestrator.ts:20` - Current prompt instructs use of `criticDecision` parameter.
  - `packages/agent-core/src/agents/workflow/critic-protocol.test.ts:19` - Current tests to delete/replace.

  **Acceptance Criteria**:
  - [ ] Tests fail while `criticDecision` remains in `workflow_update_stage` schema/description.
  - [ ] Tests assert Orchestrator prompt describes explicit handling of Critic outcomes without mentioning `criticDecision`.
  - [ ] Tests assert existing `workflow_update_stage` can mark a workflow failed/paused with `lastError` without using critic-specific fields.

  **QA Scenarios**:
  ```
  Scenario: criticDecision schema is rejected under clean-break contract
    Tool: Bash
    Preconditions: T4 tests added
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t criticDecision`
      2. Capture output to `.sisyphus/evidence/task-4-critic-schema-red.txt`
    Expected Result: Test fails before implementation because schema still accepts/documents `criticDecision`
    Failure Indicators: Test passes while `criticDecision` still exists
    Evidence: .sisyphus/evidence/task-4-critic-schema-red.txt

  Scenario: Orchestrator prompt owns Critic outcome handling
    Tool: Bash
    Preconditions: Prompt contract test added
    Steps:
      1. Run `bun test packages/agent-core/src/prompt/builder.test.ts -t Critic`
      2. Verify expected assertions mention Orchestrator handling approve/change/reject without `criticDecision`
    Expected Result: Prompt contract test fails until prompt is updated
    Failure Indicators: Test allows old `criticDecision` instruction to remain
    Evidence: .sisyphus/evidence/task-4-orchestrator-critic-contract.txt

  Scenario: Generic terminal lifecycle update is specified
    Tool: Bash
    Preconditions: Lifecycle contract test added
    Steps:
      1. Run targeted test for `workflow_update_stage` terminal failure/paused status inputs
      2. Verify test data uses `status: "failed"` and `lastError: "Critic rejected PRD: missing acceptance criteria"` or equivalent, not `criticDecision`
    Expected Result: Test fails before implementation because generic lifecycle fields do not exist yet
    Failure Indicators: Test proposes a new tool or still uses `criticDecision`
    Evidence: .sisyphus/evidence/task-4-terminal-lifecycle-contract.txt
  ```

  **Commit**: YES
  - Message: `test(workflow): define clean-break critic contract`
  - Files: `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts`, `packages/agent-core/src/prompt/builder.test.ts`
  - Pre-commit: targeted `bun test` commands above

- [x] T5. Add Foreman wave removal safety check

  **What to do**:
  - Add/record a grep-based test or QA script expectation that `foreman-wave.ts` is not imported outside its own test.
  - Ensure existing `tasks-format.ts` tests remain the source of truth for parsing/dependency wave logic.
  - Mark `foreman-wave.test.ts` for deletion in T12, not replacement.

  **Must NOT do**:
  - Do not delete `tasks-format.ts`; it remains useful and referenced by workflow tools.
  - Do not move Foreman behavior into another production helper.

  **Recommended Agent Profile**:
  - **Category**: `quick` — small safety characterization.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `git-master` — no git history needed.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1-T4, T6
  - **Blocks**: T12, T15
  - **Blocked By**: None

  **References**:
  - `packages/agent-core/src/agents/workflow/foreman-wave.ts:81` - Test-only simulation function.
  - `packages/agent-core/src/agents/workflow/foreman-wave.test.ts:43` - Tests that should be removed with helper.
  - `packages/agent-core/src/agents/workflow/tasks-format.ts:1` - Parser/dependency logic that must remain.

  **Acceptance Criteria**:
  - [ ] Evidence shows `foreman-wave` is referenced only by its own test before deletion.
  - [ ] Plan for deletion excludes `tasks-format.ts`.

  **QA Scenarios**:
  ```
  Scenario: Foreman wave is test-only before deletion
    Tool: Bash
    Preconditions: Repository unchanged except T5 evidence/check
    Steps:
      1. Run `rg "foreman-wave|simulateForemanWaveExecution|planForemanReadyWave" packages/agent-core/src`
      2. Save output to `.sisyphus/evidence/task-5-foreman-wave-usages.txt`
    Expected Result: Matches are limited to `foreman-wave.ts` and `foreman-wave.test.ts`
    Failure Indicators: Production files import `foreman-wave.ts`
    Evidence: .sisyphus/evidence/task-5-foreman-wave-usages.txt

  Scenario: TASKS parser tests remain independent
    Tool: Bash
    Preconditions: T5 check complete
    Steps:
      1. Run `bun test packages/agent-core/src/agents/workflow/tasks-format.test.ts`
      2. Save output to `.sisyphus/evidence/task-5-tasks-format-baseline.txt`
    Expected Result: TASKS parser tests pass independently of Foreman wave helper
    Failure Indicators: Parser coverage depends on `foreman-wave.test.ts`
    Evidence: .sisyphus/evidence/task-5-tasks-format-baseline.txt
  ```

  **Commit**: YES
  - Message: `test(workflow): confirm foreman wave helper is removable`
  - Files: evidence/check only or test metadata if executor creates one
  - Pre-commit: `bun test packages/agent-core/src/agents/workflow/tasks-format.test.ts`

- [x] T6. Add workflow type/guard preservation tests

  **What to do**:
  - Add or update tests in `guards.test.ts`, `state.test.ts`, and `workflow-integration.test.ts` proving this plan preserves the current `research_only`, `quick_fix`, and `full_feature` workflow type paths.
  - Ensure subtraction work does not alter stage transitions, prerequisites, completion policies, unresolved interaction blocking, or user approval gates for those three types.
  - Treat workflow type collapse as explicitly out of scope.

  **Must NOT do**:
  - Do not collapse the three workflow types into one pipeline.
  - Do not add a new workflow type or hidden alternate transition graph.

  **Recommended Agent Profile**:
  - **Category**: `quick` — tests first, but may touch 2-3 test files.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `ultrabrain` — this is a guardrail/test-preservation task, not a redesign.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 with T1-T5
  - **Blocks**: T15
  - **Blocked By**: None

  **References**:
  - `packages/agent-core/src/agents/workflow/workflow-types.ts:66` - Current 3-type registry to preserve.
  - `packages/agent-core/src/agents/workflow/guards.ts:1` - Current transition/completion guard logic.
  - `packages/agent-core/src/agents/workflow/guards.test.ts:276` - Existing transition-denial test area.
  - `packages/agent-core/src/agents/workflow/workflow-integration.test.ts:785` - Existing workflow transition/completion integration coverage.

  **Acceptance Criteria**:
  - [ ] Tests assert `research_only`, `quick_fix`, and `full_feature` remain distinct workflow type paths.
  - [ ] Tests assert current transition/prerequisite/completion policies remain intact.
  - [ ] Tests still protect user approval before Foreman/execution stage.

  **QA Scenarios**:
  ```
  Scenario: Existing type matrix remains protected
    Tool: Bash
    Preconditions: T6 tests added
    Steps:
      1. Run `bun test packages/agent-core/src/agents/workflow/guards.test.ts`
      2. Capture output to `.sisyphus/evidence/task-6-type-matrix-preserved.txt`
    Expected Result: Tests pass only if all three workflow types and their transitions remain distinct
    Failure Indicators: Any assertion expects a single workflow pipeline
    Evidence: .sisyphus/evidence/task-6-type-matrix-preserved.txt

  Scenario: Workflow type collapse is out of scope
    Tool: Bash
    Preconditions: T6 tests added
    Steps:
      1. Run targeted tests that inspect `WORKFLOW_TYPE_REGISTRY` or equivalent exported helpers
      2. Save output to `.sisyphus/evidence/task-6-no-type-collapse.txt`
    Expected Result: Tests fail if `research_only`, `quick_fix`, or `full_feature` is removed/collapsed
    Failure Indicators: Tests accept one pipeline or remove type-specific expectations
    Evidence: .sisyphus/evidence/task-6-no-type-collapse.txt
  ```

  **Commit**: YES
  - Message: `test(workflow): protect workflow type matrix`
  - Files: `packages/agent-core/src/agents/workflow/guards.test.ts`, `packages/agent-core/src/agents/workflow/state.test.ts`, `packages/agent-core/src/agents/workflow/workflow-integration.test.ts`
  - Pre-commit: targeted guard/state/integration tests

- [x] T7. Implement compact workflow tool output formatter

  **What to do**:
  - Create a shared compact formatter for workflow tool outputs, colocated under `packages/agent-core/src/tools/builtins/workflow/` unless an existing utility file is clearly better.
  - Update state-returning workflow tools to return compact summaries by default: `workflow_create`, `workflow_read`, `workflow_update_stage`, `workflow_record_completion`, `workflow_complete`, and `workflow_propose_interactions`.
  - Ensure compact output reports enough routing data for agents: workflow id, type/pipeline, stage, status, artifact counts/kinds, unresolved/resolved interaction counts, retry count, and concise message.
  - Keep all 10 workflow tools registered and named exactly as today.

  **Must NOT do**:
  - Do not mutate persisted workflow state shape in this task; only output formatting changes.
  - Do not include raw artifact bodies or full interaction arrays in compact default output.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — multi-tool refactor with shared helper and tests.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `ai-slop-remover` — not single-file cleanup.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 with T8-T10
  - **Blocks**: T15, T16
  - **Blocked By**: T1

  **References**:
  - `packages/agent-core/src/tools/builtins/workflow/workflow-read.ts:22` - Replace full-state stringify.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-create.ts:61` - Replace create output.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-update-stage.ts:68` - Replace critic/result output after T10 removes adapter.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-record-completion.ts:30` - Replace record-completion output.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-complete.ts:52` - Replace complete output.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-propose-interactions.ts:108` - Remove embedded full `state` field.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts:68` - Existing test harness.

  **Acceptance Criteria**:
  - [ ] T1 compact-output tests pass.
  - [ ] Full test output for compact cases shows no raw `requiredInteractions`/`resolvedInteractions` arrays by default.
  - [ ] All 10 workflow tool descriptors still register in `workflow-tools.test.ts`.

  **QA Scenarios**:
  ```
  Scenario: Compact workflow outputs pass targeted tests
    Tool: Bash
    Preconditions: T7 implementation complete
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t compact`
      2. Save output to `.sisyphus/evidence/task-7-compact-output-green.txt`
    Expected Result: Compact-output tests pass and default outputs are bounded summaries
    Failure Indicators: Full state JSON appears in default tool output or test fails
    Evidence: .sisyphus/evidence/task-7-compact-output-green.txt

  Scenario: Workflow tool registry remains unchanged
    Tool: Bash
    Preconditions: T7 implementation complete
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t "registerBuiltinTools includes all workflow tools"`
      2. Confirm all 10 expected tool names remain registered
    Expected Result: Registry test passes with 10 workflow tools
    Failure Indicators: Any workflow tool missing, renamed, or merged
    Evidence: .sisyphus/evidence/task-7-tool-registry-intact.txt
  ```

  **Commit**: YES
  - Message: `refactor(workflow): compact workflow tool results`
  - Files: workflow tool formatter/helper and touched workflow tool files/tests
  - Pre-commit: `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t compact`

- [x] T8. Implement `artifact_read` truncation/pagination

  **What to do**:
  - Extend `ArtifactReadInputSchema` with explicit truncation controls, e.g. `maxChars` and `includeFullContent`, using strict Zod validation.
  - Default single-artifact reads to bounded body/content output with truncation metadata.
  - Preserve multi-file list mode for `CRITIC_REPORT` and `EVIDENCE` without truncating path lists.
  - Make full content retrieval explicit and obvious to agents.

  **Must NOT do**:
  - Do not remove `frontmatter` metadata.
  - Do not truncate workflow artifact path lists.
  - Do not silently return partial content without `truncated: true` metadata.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — schema + formatter + tests.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `playwright` — no browser behavior.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 with T7, T9, T10
  - **Blocks**: T15, T16
  - **Blocked By**: T2

  **References**:
  - `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts:14` - Input schema to extend.
  - `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts:39` - Path read branch.
  - `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts:44` - Single-file kind read branch.
  - `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts:49` - Multi-file list branch to preserve.
  - `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts:87` - Formatter to replace.

  **Acceptance Criteria**:
  - [ ] T2 truncation tests pass.
  - [ ] Default read of a long artifact is bounded and reports exact full/returned lengths.
  - [ ] Explicit full read returns complete body/content.
  - [ ] Invalid truncation inputs fail schema validation.

  **QA Scenarios**:
  ```
  Scenario: Long artifact body is truncated with metadata
    Tool: Bash
    Preconditions: T8 implementation complete
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t artifact_read`
      2. Save output to `.sisyphus/evidence/task-8-artifact-read-green.txt`
    Expected Result: Truncation tests pass and output includes `truncated`, `bodyChars`, and returned length metadata
    Failure Indicators: Body is returned in full by default or metadata is missing
    Evidence: .sisyphus/evidence/task-8-artifact-read-green.txt

  Scenario: Full content escape hatch works
    Tool: Bash
    Preconditions: T8 implementation complete
    Steps:
      1. Run targeted test using `includeFullContent: true` or chosen equivalent
      2. Verify returned body equals original long artifact body
    Expected Result: Explicit full read returns complete content while default remains bounded
    Failure Indicators: Full read impossible or default read becomes unbounded
    Evidence: .sisyphus/evidence/task-8-artifact-full-read.txt
  ```

  **Commit**: YES
  - Message: `refactor(workflow): bound artifact read output`
  - Files: `packages/agent-core/src/tools/builtins/workflow/artifact-read.ts`, `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts`
  - Pre-commit: `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t artifact_read`

- [x] T9. Deduplicate workflow prompt instructions

  **What to do**:
  - Remove duplicated stage/tool prose between `orchestrator.ts` role prompt and `workflow-intent-gate.ts`.
  - Prefer one concise source of workflow procedure truth; leave `workflow-intent-gate.ts` as either a short gate/when-to-use section or remove it if tests prove role prompt covers everything.
  - Update prompt tests to reflect shorter, non-duplicative wording while preserving critical gates.
  - Remove old `criticDecision` prompt instructions as part of clean-break contract.

  **Must NOT do**:
  - Do not remove exact UUID active workflow rules from `active-workflow.ts`.
  - Do not remove explicit user approval before Foreman.
  - Do not mention `criticDecision` as a valid parameter after T10/T13.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — prompt behavior change with safety assertions.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `writing` — prompts are code constants with tests.

  **Parallelization**:
  - **Can Run In Parallel**: YES, coordinate with T10 on `criticDecision` wording.
  - **Parallel Group**: Wave 2 with T7, T8, T10
  - **Blocks**: T15, T16
  - **Blocked By**: T3

  **References**:
  - `packages/agent-core/src/agents/definitions/orchestrator.ts:12` - Main role prompt.
  - `packages/agent-core/src/prompt/sections/workflow-intent-gate.ts:6` - Duplicated workflow MVP section.
  - `packages/agent-core/src/prompt/builder.ts:28` - Prompt assembly point.
  - `packages/agent-core/src/prompt/builder.test.ts:40` - Existing workflow prompt tests.

  **Acceptance Criteria**:
  - [ ] T3 prompt dedupe tests pass.
  - [ ] Prompt no longer contains duplicate full stage-flow/procedure blocks.
  - [ ] Prompt includes clean-break Critic handling without `criticDecision`.

  **QA Scenarios**:
  ```
  Scenario: Workflow prompt dedupe tests pass
    Tool: Bash
    Preconditions: T9 implementation complete
    Steps:
      1. Run `bun test packages/agent-core/src/prompt/builder.test.ts -t workflow`
      2. Save output to `.sisyphus/evidence/task-9-prompt-dedupe-green.txt`
    Expected Result: Required workflow rules remain and duplication assertions pass
    Failure Indicators: Missing user approval gate or duplicate stage flow remains
    Evidence: .sisyphus/evidence/task-9-prompt-dedupe-green.txt

  Scenario: criticDecision prompt references are gone
    Tool: Bash
    Preconditions: T9 implementation complete
    Steps:
      1. Run `rg "criticDecision" packages/agent-core/src/agents/definitions packages/agent-core/src/prompt`
      2. Save output to `.sisyphus/evidence/task-9-no-criticdecision-prompt.txt`
    Expected Result: No prompt/definition references instruct agents to use `criticDecision`
    Failure Indicators: Any remaining `criticDecision` prompt instruction
    Evidence: .sisyphus/evidence/task-9-no-criticdecision-prompt.txt
  ```

  **Commit**: YES
  - Message: `refactor(prompt): dedupe workflow orchestration instructions`
  - Files: `packages/agent-core/src/agents/definitions/orchestrator.ts`, `packages/agent-core/src/prompt/sections/workflow-intent-gate.ts`, `packages/agent-core/src/prompt/builder.test.ts`
  - Pre-commit: `bun test packages/agent-core/src/prompt/builder.test.ts -t workflow`

- [x] T10. Delete critic protocol adapter and add generic lifecycle status contract

  **What to do**:
  - Remove `processCriticDecision` import and `criticDecision` execution branch from `workflow-update-stage.ts`.
  - Make `workflow_update_stage` handle normal stage transitions plus generic lifecycle terminal updates such as `status: failed|paused` and `lastError`/reason. This is not a critic-specific adapter; it is the existing workflow lifecycle mutation tool.
  - Use this generic path for Critic rejection, retry exhaustion, and user withholding execution approval.
  - Update Orchestrator prompt so approved/change/reject outcomes are handled as instructions, not as a magic tool parameter.
  - Remove `critic-protocol.ts` from workflow exports if exported.

  **Must NOT do**:
  - Do not reimplement `processCriticDecision` under a different name.
  - Do not keep `criticDecision` in schema, descriptions, tests, or prompts.
  - Do not add an 11th workflow tool for failure/paused status updates.
  - Do not weaken unresolved-interaction and user-approval guards.

  **Recommended Agent Profile**:
  - **Category**: `deep` — core state/tool contract refactor with prompt coordination.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `git-master` — commits happen after tests, but no history archaeology required.

  **Parallelization**:
  - **Can Run In Parallel**: YES with T7/T8, coordinate text conflicts with T9.
  - **Parallel Group**: Wave 2
  - **Blocks**: T13, T15, T16
  - **Blocked By**: T4

  **References**:
  - `packages/agent-core/src/tools/builtins/workflow/workflow-update-stage.ts:5` - Current import from `critic-protocol`.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-update-stage.ts:27` - Current schema field to remove.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-update-stage.ts:51` - Current special branch to delete.
  - `packages/agent-core/src/agents/workflow/state.ts` - State manager methods for status/lastError updates, including current failure handling used by critic protocol.
  - `packages/agent-core/src/agents/workflow/critic-protocol.ts:28` - Adapter to remove.
  - `packages/agent-core/src/agents/definitions/orchestrator.ts:20` - Current prompt flow to rewrite.

  **Acceptance Criteria**:
  - [ ] `workflow_update_stage` has no `criticDecision` schema field or branch.
  - [ ] `workflow_update_stage` supports generic terminal lifecycle status updates with `lastError`/reason.
  - [ ] Orchestrator prompt explains explicit Critic outcome handling.
  - [ ] Critic rejection and retry exhaustion are described as Orchestrator decisions that call the generic lifecycle path.
  - [ ] Tests from T4 pass.
  - [ ] `rg "processCriticDecision|criticDecision" packages/agent-core/src` shows no stale production references except intentional test names removed by T13.

  **QA Scenarios**:
  ```
  Scenario: criticDecision adapter is removed from workflow_update_stage
    Tool: Bash
    Preconditions: T10 implementation complete
    Steps:
      1. Run `rg "criticDecision|processCriticDecision" packages/agent-core/src/tools/builtins/workflow packages/agent-core/src/agents/definitions packages/agent-core/src/prompt`
      2. Save output to `.sisyphus/evidence/task-10-no-critic-adapter.txt`
    Expected Result: No references remain in workflow tools or prompts
    Failure Indicators: `workflow-update-stage.ts` still accepts `criticDecision`
    Evidence: .sisyphus/evidence/task-10-no-critic-adapter.txt

  Scenario: Workflow update-stage tests pass without special critic branch
    Tool: Bash
    Preconditions: T10 implementation complete
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t workflow_update_stage`
      2. Save output to `.sisyphus/evidence/task-10-update-stage-green.txt`
    Expected Result: Normal stage transition tests pass; criticDecision tests are removed/replaced
    Failure Indicators: Tests require `criticDecision` or fail transition guards unexpectedly
    Evidence: .sisyphus/evidence/task-10-update-stage-green.txt

  Scenario: Generic failure/paused lifecycle path works
    Tool: Bash
    Preconditions: T10 implementation complete
    Steps:
      1. Run targeted `workflow_update_stage` tests for `status: "failed"` with `lastError: "Critic rejected PRD: missing acceptance criteria"`
      2. Run targeted test for `status: "paused"` when user withholds Foreman approval
      3. Save output to `.sisyphus/evidence/task-10-generic-terminal-lifecycle.txt`
    Expected Result: Existing `workflow_update_stage` can set terminal/paused status and error reason without `criticDecision`
    Failure Indicators: No tool path exists for failure status, or implementation adds a new workflow tool
    Evidence: .sisyphus/evidence/task-10-generic-terminal-lifecycle.txt
  ```

  **Commit**: YES
  - Message: `refactor(workflow): remove critic decision adapter`
  - Files: `workflow-update-stage.ts`, Orchestrator/prompt files, related tests
  - Pre-commit: targeted workflow tool and prompt tests

- [x] T11. Verify workflow type matrix remains intact

  **What to do**:
  - Run the preservation tests from T6 after T7-T10 land.
  - Fix any accidental changes to `WORKFLOW_TYPE_REGISTRY`, stage transitions, prerequisites, or completion policies caused by token/output/prompt/critic adapter refactors.
  - Ensure `research_only`, `quick_fix`, and `full_feature` remain separate workflow type paths.
  - Treat this task as a scope guard: the correct implementation is usually “no workflow type code changes needed”; only fix regressions if earlier tasks accidentally touched the type matrix.

  **Must NOT do**:
  - Do not collapse, rename, or remove any existing workflow type.
  - Do not add a new workflow type or alternate transition graph.
  - Do not use this task to reintroduce compatibility/fallback code for removed adapters.

  **Recommended Agent Profile**:
  - **Category**: `quick` — targeted guardrail verification and small fixes only.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `ultrabrain` — no architecture redesign should happen here.

  **Parallelization**:
  - **Can Run In Parallel**: YES after T7-T10 complete; it is independent from T12-T14 cleanup.
  - **Parallel Group**: Wave 2 tail / Wave 3 parallel with T12-T14 if dependencies are satisfied
  - **Blocks**: T15, T16
  - **Blocked By**: T6, T7, T8, T9, T10

  **References**:
  - `packages/agent-core/src/agents/workflow/workflow-types.ts:66` - Current 3-type registry that must remain.
  - `packages/agent-core/src/agents/workflow/workflow-types.ts:147` - Helper accessors for type definitions.
  - `packages/agent-core/src/agents/workflow/guards.ts:1` - Guard logic that should keep type-specific transitions.
  - `packages/agent-core/src/agents/workflow/guards.test.ts:1` - Guard tests protecting transition behavior.
  - `packages/agent-core/src/agents/workflow/workflow-integration.test.ts:1` - Integration tests that should continue covering type-specific flows.

  **Acceptance Criteria**:
  - [ ] `research_only`, `quick_fix`, and `full_feature` remain present in production code and tests.
  - [ ] Type-specific transitions/prerequisites/completion policies remain covered by tests.
  - [ ] No plan implementation introduces a single-pipeline replacement.

  **QA Scenarios**:
  ```
  Scenario: Three workflow types remain present
    Tool: Bash
    Preconditions: T7-T10 complete
    Steps:
      1. Run `rg "research_only|quick_fix|full_feature" packages/agent-core/src/agents/workflow packages/agent-core/src/prompt`
      2. Save output to `.sisyphus/evidence/task-11-three-types-present.txt`
    Expected Result: All three workflow type names remain in expected workflow type/prompt/test contexts
    Failure Indicators: Any type is missing or references show a single-pipeline replacement
    Evidence: .sisyphus/evidence/task-11-three-types-present.txt

  Scenario: Type-specific guard tests pass
    Tool: Bash
    Preconditions: T7-T10 complete
    Steps:
      1. Run `bun test packages/agent-core/src/agents/workflow/guards.test.ts packages/agent-core/src/agents/workflow/workflow-integration.test.ts`
      2. Save output to `.sisyphus/evidence/task-11-type-guards-green.txt`
    Expected Result: Existing three-type guard/integration behavior passes
    Failure Indicators: Tests fail because types were collapsed or transitions changed accidentally
    Evidence: .sisyphus/evidence/task-11-type-guards-green.txt
  ```

  **Commit**: YES if fixes are needed; otherwise NO
  - Message: `test(workflow): protect workflow type matrix`
  - Files: `workflow-types.ts`, `guards.ts`, `guards.test.ts`, `workflow-integration.test.ts` only if regressions are found
  - Pre-commit: `bun test packages/agent-core/src/agents/workflow/guards.test.ts packages/agent-core/src/agents/workflow/workflow-integration.test.ts`

- [x] T12. Delete Foreman wave module/test and stale exports

  **What to do**:
  - Delete `packages/agent-core/src/agents/workflow/foreman-wave.ts`.
  - Delete `packages/agent-core/src/agents/workflow/foreman-wave.test.ts`.
  - Remove any stale exports/imports if discovered.
  - Keep `tasks-format.ts` and its tests intact.

  **Must NOT do**:
  - Do not recreate Foreman wave simulation elsewhere.
  - Do not delete TASKS.md parser/topological sort utilities.

  **Recommended Agent Profile**:
  - **Category**: `quick` — small deletion validated by grep/tests.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `ai-slop-remover` — deletion task, not cleanup.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 with T13, T14
  - **Blocks**: T15, T16
  - **Blocked By**: T5

  **References**:
  - `packages/agent-core/src/agents/workflow/foreman-wave.ts:1` - File to delete.
  - `packages/agent-core/src/agents/workflow/foreman-wave.test.ts:1` - Test file to delete.
  - `packages/agent-core/src/agents/workflow/tasks-format.ts:1` - Must remain.

  **Acceptance Criteria**:
  - [ ] `foreman-wave.ts` and `foreman-wave.test.ts` are deleted.
  - [ ] `rg "foreman-wave|simulateForemanWaveExecution|planForemanReadyWave" packages/agent-core/src` returns no matches.
  - [ ] `tasks-format.test.ts` still passes.

  **QA Scenarios**:
  ```
  Scenario: Foreman wave module has no references
    Tool: Bash
    Preconditions: T12 deletion complete
    Steps:
      1. Run `rg "foreman-wave|simulateForemanWaveExecution|planForemanReadyWave" packages/agent-core/src`
      2. Save output to `.sisyphus/evidence/task-12-no-foreman-wave.txt`
    Expected Result: No matches
    Failure Indicators: Any stale import/reference remains
    Evidence: .sisyphus/evidence/task-12-no-foreman-wave.txt

  Scenario: TASKS format parser remains covered
    Tool: Bash
    Preconditions: T12 deletion complete
    Steps:
      1. Run `bun test packages/agent-core/src/agents/workflow/tasks-format.test.ts`
      2. Save output to `.sisyphus/evidence/task-12-tasks-format-green.txt`
    Expected Result: TASKS parser tests pass
    Failure Indicators: Deletion broke parser tests
    Evidence: .sisyphus/evidence/task-12-tasks-format-green.txt
  ```

  **Commit**: YES
  - Message: `chore(workflow): remove foreman wave helper`
  - Files: deleted `foreman-wave.ts`, deleted `foreman-wave.test.ts`
  - Pre-commit: `bun test packages/agent-core/src/agents/workflow/tasks-format.test.ts`

- [x] T13. Remove `criticDecision` schema/tests/imports after clean-break contract

  **What to do**:
  - Delete `packages/agent-core/src/agents/workflow/critic-protocol.ts`.
  - Delete or fully replace `critic-protocol.test.ts` so no test imports `processCriticDecision`.
  - Remove stale imports from integration/error behavior tests and rewrite them to use the new Orchestrator/tool contract only where still relevant.
  - Ensure replacement tests cover terminal failure/paused behavior through `workflow_update_stage`, not through critic protocol.
  - Verify no `criticDecision` or `processCriticDecision` references remain anywhere in source/tests.

  **Must NOT do**:
  - Do not keep a compatibility test for old critic protocol.
  - Do not retain `criticDecision` in tool schemas as deprecated.

  **Recommended Agent Profile**:
  - **Category**: `quick` — cleanup after T10.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `safe-refactor` — use grep/LSP directly.

  **Parallelization**:
  - **Can Run In Parallel**: YES with T12/T14 once T10 is complete
  - **Parallel Group**: Wave 3
  - **Blocks**: T15, T16
  - **Blocked By**: T10

  **References**:
  - `packages/agent-core/src/agents/workflow/critic-protocol.ts:1` - File to delete.
  - `packages/agent-core/src/agents/workflow/critic-protocol.test.ts:1` - Old unit tests to remove/replace.
  - `packages/agent-core/src/agents/workflow/workflow-integration.test.ts:7` - Existing import to remove.
  - `packages/agent-core/src/agents/workflow/workflow-error-behavior.test.ts:6` - Existing import to remove.

  **Acceptance Criteria**:
  - [ ] `critic-protocol.ts` and old protocol tests are gone.
  - [ ] `rg "critic-protocol|processCriticDecision|criticDecision" packages/agent-core/src` returns no matches.
  - [ ] Terminal failure/paused tests remain covered through `workflow_update_stage`.
  - [ ] Updated workflow integration/error tests pass.

  **QA Scenarios**:
  ```
  Scenario: Critic protocol references are fully removed
    Tool: Bash
    Preconditions: T13 cleanup complete
    Steps:
      1. Run `rg "critic-protocol|processCriticDecision|criticDecision" packages/agent-core/src`
      2. Save output to `.sisyphus/evidence/task-13-no-critic-protocol.txt`
    Expected Result: No matches
    Failure Indicators: Any stale protocol import/schema/prompt/test remains
    Evidence: .sisyphus/evidence/task-13-no-critic-protocol.txt

  Scenario: Workflow integration tests pass after protocol deletion
    Tool: Bash
    Preconditions: T13 cleanup complete
    Steps:
      1. Run `bun test packages/agent-core/src/agents/workflow/workflow-integration.test.ts packages/agent-core/src/agents/workflow/workflow-error-behavior.test.ts`
      2. Save output to `.sisyphus/evidence/task-13-workflow-integration-green.txt`
    Expected Result: Integration/error tests pass without critic protocol imports
    Failure Indicators: Tests import deleted protocol or expect old adapter behavior
    Evidence: .sisyphus/evidence/task-13-workflow-integration-green.txt
  ```

  **Commit**: YES
  - Message: `chore(workflow): delete critic protocol adapter`
  - Files: deleted critic protocol files and updated tests/imports
  - Pre-commit: targeted integration/error tests and grep check

- [x] T14. Update AGENTS.md workflow tool documentation to 10 tools

  **What to do**:
  - Update root `AGENTS.md` Tool System section so workflow tool count matches current registration.
  - List all 10 workflow tools: `workflow_create`, `workflow_read`, `workflow_update_stage`, `workflow_complete`, `workflow_record_completion`, `workflow_propose_interactions`, `workflow_request_interactions`, `workflow_task_check`, `artifact_read`, `artifact_write`.
  - Update the architecture line describing `agents/workflow/` if deleted modules change the description.

  **Must NOT do**:
  - Do not document removed legacy workflow types as supported.
  - Do not imply only 6 workflow tools exist.

  **Recommended Agent Profile**:
  - **Category**: `writing` — documentation-only correction.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `customize-opencode` — this is project AGENTS.md, not opencode config.

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 3 with T12/T13
  - **Blocks**: T17
  - **Blocked By**: None

  **References**:
  - `AGENTS.md:90` - Current workflow directory description mentions removed modules.
  - `AGENTS.md:93` - Current builtin tool count says 6 workflow tools.
  - `packages/agent-core/src/tools/builtins/workflow/index.ts:1` - Actual 10 workflow tool exports.
  - `packages/agent-core/src/agents/definitions/orchestrator.ts:95` - Orchestrator allowed workflow tools.

  **Acceptance Criteria**:
  - [ ] AGENTS.md accurately lists 10 workflow tools.
  - [ ] AGENTS.md does not mention `critic-protocol` or `foreman-wave` after deletion.

  **QA Scenarios**:
  ```
  Scenario: Documentation lists all workflow tools
    Tool: Bash
    Preconditions: T14 documentation update complete
    Steps:
      1. Run `rg "workflow_create|workflow_request_interactions|artifact_write|6 workflow|10 workflow" AGENTS.md`
      2. Save output to `.sisyphus/evidence/task-14-agents-workflow-tools.txt`
    Expected Result: AGENTS.md includes all 10 tools and no stale “6 workflow” claim
    Failure Indicators: Missing tool names or stale count remains
    Evidence: .sisyphus/evidence/task-14-agents-workflow-tools.txt

  Scenario: Removed modules absent from documentation
    Tool: Bash
    Preconditions: T14 documentation update complete
    Steps:
      1. Run `rg "critic protocol|foreman wave|critic-protocol|foreman-wave" AGENTS.md`
      2. Save output to `.sisyphus/evidence/task-14-no-removed-modules-docs.txt`
    Expected Result: No stale module descriptions remain
    Failure Indicators: Documentation still describes deleted modules
    Evidence: .sisyphus/evidence/task-14-no-removed-modules-docs.txt
  ```

  **Commit**: YES
  - Message: `docs(workflow): correct workflow tool inventory`
  - Files: `AGENTS.md`
  - Pre-commit: documentation grep checks above

- [x] T15. Run targeted workflow test suite and fix regressions

  **What to do**:
  - Run all workflow-focused tests after T7-T13 land.
  - Fix only regressions caused by this subtraction plan.
  - Ensure tests now reflect clean-break behavior, not legacy compatibility.
  - Capture evidence for every targeted test command.

  **Must NOT do**:
  - Do not fix unrelated flaky tests outside Workflow/prompt areas.
  - Do not reintroduce compatibility paths to make old tests pass.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — integration/debug pass across workflow tests.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `review-work` — final verification wave handles review.

  **Parallelization**:
  - **Can Run In Parallel**: NO within wave; depends on Wave 2/3 outputs.
  - **Parallel Group**: Wave 4 with T16 only after local fixes are complete; T17 follows evidence.
  - **Blocks**: T16, T17
  - **Blocked By**: T7, T8, T9, T10, T12, T13

  **References**:
  - `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts:1` - Tool behavior tests.
  - `packages/agent-core/src/agents/workflow/workflow-integration.test.ts:1` - Workflow integration tests.
  - `packages/agent-core/src/agents/workflow/guards.test.ts:1` - Guard tests.
  - `packages/agent-core/src/agents/workflow/state.test.ts:1` - State tests.
  - `packages/agent-core/src/prompt/builder.test.ts:1` - Prompt tests.

  **Acceptance Criteria**:
  - [ ] Targeted workflow and prompt tests pass.
  - [ ] Any changed tests match clean-break requirements.
  - [ ] Evidence files capture command outputs.

  **QA Scenarios**:
  ```
  Scenario: Targeted workflow suite passes
    Tool: Bash
    Preconditions: T7-T13 complete
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts packages/agent-core/src/agents/workflow/workflow-integration.test.ts packages/agent-core/src/agents/workflow/guards.test.ts packages/agent-core/src/agents/workflow/state.test.ts packages/agent-core/src/prompt/builder.test.ts`
      2. Save output to `.sisyphus/evidence/task-15-targeted-workflow-suite.txt`
    Expected Result: Targeted suite passes
    Failure Indicators: Any failure caused by stale legacy workflow expectations or deleted modules
    Evidence: .sisyphus/evidence/task-15-targeted-workflow-suite.txt

  Scenario: Deleted-module grep checks pass
    Tool: Bash
    Preconditions: T12-T13 complete
    Steps:
      1. Run `rg "foreman-wave|critic-protocol|processCriticDecision|criticDecision" packages/agent-core/src`
      2. Save output to `.sisyphus/evidence/task-15-deleted-module-grep.txt`
    Expected Result: No matches
    Failure Indicators: Stale import, prompt instruction, or test reference remains
    Evidence: .sisyphus/evidence/task-15-deleted-module-grep.txt
  ```

  **Commit**: YES
  - Message: `test(workflow): harden subtraction integration`
  - Files: only regression fixes from targeted tests
  - Pre-commit: targeted workflow suite command above

- [x] T16. Run full typecheck/test and capture token-output evidence

  **What to do**:
  - Run repository-level validation in required order: `bun run typecheck` then `bun run test`.
  - Capture representative before/after-style evidence from current outputs showing workflow tool results and artifact reads are bounded. Since no compatibility baseline is required, evidence only needs current post-change sizes/fields.
  - Record any unrelated failures separately without fixing outside scope.

  **Must NOT do**:
  - Do not skip full validation.
  - Do not fix unrelated non-workflow failures unless they are directly caused by this plan.

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high` — broad validation and evidence collection.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `git-master` — commits already handled task-by-task.

  **Parallelization**:
  - **Can Run In Parallel**: NO; full validation after T15.
  - **Parallel Group**: Wave 4
  - **Blocks**: T17, final verification
  - **Blocked By**: T15

  **References**:
  - `AGENTS.md:33` - Project validation commands.
  - `package.json` - Root scripts if command behavior needs confirmation.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts:1` - Test fixtures can produce output-size evidence.

  **Acceptance Criteria**:
  - [ ] `bun run typecheck` passes.
  - [ ] `bun run test` passes or unrelated failures are documented with exact failing test names.
  - [ ] Evidence demonstrates compact workflow outputs and bounded artifact reads.

  **QA Scenarios**:
  ```
  Scenario: Full typecheck passes
    Tool: Bash
    Preconditions: T15 targeted suite passes
    Steps:
      1. Run `bun run typecheck`
      2. Save output to `.sisyphus/evidence/task-16-typecheck.txt`
    Expected Result: Typecheck exits 0
    Failure Indicators: Type errors in workflow/prompt/docs-related code
    Evidence: .sisyphus/evidence/task-16-typecheck.txt

  Scenario: Full test suite passes
    Tool: Bash
    Preconditions: Typecheck passes
    Steps:
      1. Run `bun run test`
      2. Save output to `.sisyphus/evidence/task-16-full-test.txt`
    Expected Result: Test suite exits 0, or unrelated failures are documented with evidence
    Failure Indicators: Workflow subtraction tests fail or deleted-module references remain
    Evidence: .sisyphus/evidence/task-16-full-test.txt
  ```

  **Commit**: YES
  - Message: `test(workflow): verify subtraction validation`
  - Files: evidence and any directly related validation fixes
  - Pre-commit: `bun run typecheck && bun run test`

- [x] T17. Review diff for subtraction fidelity and no tool-registry creep

  **What to do**:
  - Inspect final diff against this plan before final verification.
  - Confirm implementation removed complexity instead of replacing it with equivalent adapters.
  - Confirm all task commits exist or intentional grouping is documented.
  - Confirm no fallback/migration/compatibility code was added.
  - Confirm all independent tasks were dispatched according to wave parallelism; document any dependency-based exceptions.

  **Must NOT do**:
  - Do not accept extra abstractions that recreate the removed workflow state machine under new names.
  - Do not accept deleted/renamed workflow tools.

  **Recommended Agent Profile**:
  - **Category**: `deep` — cross-diff architectural review.
  - **Skills**: []
  - **Skills Evaluated but Omitted**: `review-work` — final F1-F4 still run after this task.

  **Parallelization**:
  - **Can Run In Parallel**: NO; requires T14 and T16 outputs.
  - **Parallel Group**: Wave 4 final task
  - **Blocks**: Final verification
  - **Blocked By**: T14, T16

  **References**:
  - `.sisyphus/plans/workflow-subtraction-tier1-2.md:79` - Must Have/guardrail section.
  - `packages/agent-core/src/tools/builtins/workflow/index.ts:1` - Workflow tool export inventory.
  - `packages/agent-core/src/agents/workflow/workflow-types.ts:1` - Existing three-type workflow model that must remain intact.
  - `packages/agent-core/src/tools/builtins/workflow/workflow-update-stage.ts:1` - No critic adapter after T10/T13.
  - `AGENTS.md:90` - Documentation updated after T14.

  **Acceptance Criteria**:
  - [ ] No tool registry creep: all 10 intended workflow tools remain, no extra replacement adapter tools added.
  - [ ] No `criticDecision`, `processCriticDecision`, `critic-protocol`, or `foreman-wave` references remain in workflow/prompt implementation files.
  - [ ] No newly added fallback/migration/compatibility code appears in the workflow-related diff for removed adapters/helpers.
  - [ ] Final diff matches clean-break subtraction scope.
  - [ ] Task commit/evidence status is summarized.

  **QA Scenarios**:
  ```
  Scenario: No deleted adapter references remain in workflow/prompt code
    Tool: Bash
    Preconditions: T16 validation complete
    Steps:
      1. Run `rg "criticDecision|processCriticDecision|critic-protocol|foreman-wave" packages/agent-core/src/agents/workflow packages/agent-core/src/tools/builtins/workflow packages/agent-core/src/agents/definitions packages/agent-core/src/prompt`
      2. Save output to `.sisyphus/evidence/task-17-no-deleted-adapter-refs.txt`
    Expected Result: No matches in workflow tools, workflow agents, prompt sections, or agent definitions
    Failure Indicators: Any stale deleted-adapter import, schema field, prompt instruction, or test reference remains
    Evidence: .sisyphus/evidence/task-17-no-deleted-adapter-refs.txt

  Scenario: No new compatibility shim in workflow diff
    Tool: Bash
    Preconditions: T16 validation complete
    Steps:
      1. Run `git diff -- packages/agent-core/src/agents/workflow packages/agent-core/src/tools/builtins/workflow packages/agent-core/src/agents/definitions packages/agent-core/src/prompt AGENTS.md`
      2. Inspect the captured diff for newly added `fallback`, `migration`, `compatibility`, or dual-path old/new workflow code related to removed adapters/helpers
      3. Save output to `.sisyphus/evidence/task-17-no-new-compat-shim-diff.txt`
    Expected Result: Diff contains no newly added compatibility shim/fallback/migration path for `critic-protocol`, `foreman-wave`, or `criticDecision`
    Failure Indicators: Added code keeps old adapter behavior under a fallback/compatibility branch
    Evidence: .sisyphus/evidence/task-17-no-new-compat-shim-diff.txt

  Scenario: Workflow tool inventory remains exactly 10
    Tool: Bash
    Preconditions: T16 validation complete
    Steps:
      1. Run `bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts -t "registerBuiltinTools includes all workflow tools"`
      2. Save output to `.sisyphus/evidence/task-17-tool-inventory.txt`
    Expected Result: Exactly the intended 10 workflow tools are registered
    Failure Indicators: Tool removed, renamed, merged, or replacement adapter added
    Evidence: .sisyphus/evidence/task-17-tool-inventory.txt
  ```

  **Commit**: YES
  - Message: `chore(workflow): verify subtraction fidelity`
  - Files: final review notes/evidence and any directly related cleanup
  - Pre-commit: T17 QA commands above

---

## Final Verification Wave (MANDATORY — after ALL implementation tasks)

> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
>
> Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read this plan end-to-end. Verify every Must Have and Must NOT Have against the diff, tests, and evidence files. Confirm all 10 workflow tools remain registered. Confirm `foreman-wave.ts` and `critic-protocol.ts` are deleted, no `criticDecision` adapter remains, Orchestrator explicitly owns Critic-result handling, existing `workflow_update_stage` has a generic terminal status/lastError path for reject/pause/retry-exhausted outcomes, and the existing `research_only` / `quick_fix` / `full_feature` workflow type paths remain intact.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `bun run typecheck` and `bun run test`. Review changed files for unsafe `as any`, `@ts-ignore`, commented-out dead code, unused imports, excessive abstractions, and duplicated workflow prompt text.
  Output: `Typecheck [PASS/FAIL] | Tests [PASS/FAIL] | Files [N clean/N issues] | VERDICT`

- [ ] F3. **Real Command-Line QA** — `unspecified-high`
  Execute every task QA scenario exactly. Save command output to `.sisyphus/evidence/final-qa/`. Include targeted workflow tests, prompt tests, full test suite, and grep checks for stale imports/deleted modules.
  Output: `Scenarios [N/N pass] | Evidence [N files] | VERDICT`

- [ ] F4. **Scope Fidelity Check** — `deep`
  Compare actual diff to this plan. Reject if any workflow tool was deleted/merged/renamed, if artifact truncation lacks full-read escape hatch, if compatibility/fallback/migration code was added, if approval gates are weakened, or if extra unrelated refactors appear.
  Output: `Tasks [N/N compliant] | Scope Creep [CLEAN/N issues] | VERDICT`

---

## Commit Strategy

- **Default**: commit each task independently after its task-level tests pass.
- **Allowed grouping**: T7+T8 may share one commit only if they introduce a shared compact-output helper; otherwise commit separately.
- **Suggested messages**: `test(workflow): characterize compact workflow outputs`, `refactor(workflow): compact workflow tool results`, `refactor(workflow): remove critic decision adapter`, `test(workflow): protect workflow type matrix`, `chore(workflow): remove foreman wave helper`, `docs(workflow): correct workflow tool inventory`.

---

## Success Criteria

### Verification Commands
```bash
bun test packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts
bun test packages/agent-core/src/prompt/builder.test.ts
bun test packages/agent-core/src/agents/workflow/workflow-integration.test.ts
bun test packages/agent-core/src/agents/workflow/guards.test.ts
bun run typecheck
bun run test
```

### Final Checklist
- [ ] Workflow output formatter reduces repeated full-state JSON returns.
- [ ] `artifact_read` defaults to bounded output and reports truncation metadata.
- [ ] Full artifact content remains explicitly retrievable.
- [ ] Orchestrator workflow prompt instructions are shorter and non-duplicative.
- [ ] `critic-protocol.ts` is deleted and Critic-result handling is Orchestrator-owned.
- [ ] User approval gate before Foreman remains enforced.
- [ ] `foreman-wave.ts` and its test are gone, with no stale imports.
- [ ] Workflow type/guard tests continue to protect the existing three-type matrix.
- [ ] AGENTS.md documents current 10 workflow tools accurately.
- [ ] Full test suite passes.
