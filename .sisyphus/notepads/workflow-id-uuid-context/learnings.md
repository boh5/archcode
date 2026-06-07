
# Task 4: Derived Workflow Creation UUID-Only with Title-Aware Source References

## Implementation Notes

- **`CreateDerivedWorkflowInput.id` removed**: The interface no longer exposes any caller-controllable `id` field. Derived workflow IDs are generated exclusively by `WorkflowStateManager.create()` via `crypto.randomUUID()`.
- **`title: string` remains required**: Callers must provide an explicit title; no auto-synthesis from source workflow data occurs.
- **`buildHandoffSummary()` enhanced**: Now accepts `title` parameter and includes:
  - Source workflow: ID, title, type, stage, status
  - Derived workflow request: title, target type, reason, trigger message ID
  - Header changed from `# Handoff Summary for {id}` to `# Handoff Summary` for neutrality
- **`buildDerivedWorkflowInitialMessage()` enhanced**: First block now declares:
  - Active derived W2 exact UUID and title
  - Source workflow W1 exact UUID and title
  - Then handoff summary artifact, artifact references with explicit source UUIDs
- **Source artifact refs preserved**: All `artifact_read` instructions use `workflowId: "<source-uuid>"` explicitly

## Files Modified

- `packages/agent-core/src/agents/workflow/state.ts` — removed `id` from input, enhanced handoff summary
- `packages/agent-core/src/agents/workflow/linking.ts` — enhanced initial message with UUID/title declarations
- `packages/agent-core/src/agents/workflow/state.test.ts` — added UUID uniqueness and title assertions
- `packages/agent-core/src/agents/workflow/workflow-integration.test.ts` — added initial message structure assertions
- `packages/agent-core/src/agents/workflow/linking.test.ts` — updated JSON string assertion for escaped quotes

## Test Coverage

- `state.test.ts`: 4 derived-related tests pass (UUID uniqueness, source/derived linkage, handoff summary content)
- `workflow-integration.test.ts`: 1 derived test passes (initial message structure, source artifact refs, session linking)
- `linking.test.ts`: 7 tests pass (including derived workflow creation with fresh session)
- All 110 workflow tests pass across 11 files
- Typecheck passes across all 5 packages

## Key Assertions Added

1. `expect(result.derived.id).not.toBe(source.id)` — proves generated UUID differs from source
2. `expect(result.handoffSummary).toContain("Title: Source")` — source title in handoff
3. `expect(result.handoffSummary).toContain("Title: Upgrade to full feature")` — derived title in handoff
4. `expect(initialMessageText).toContain("derived workflow ${result.workflow.id}")` — derived UUID in initial message
5. `expect(initialMessageText).toContain("titled \"Derived from source\"")` — derived title in initial message
6. `expect(initialMessageText).toContain("Source workflow: ${source.workflow.id}")` — source UUID in initial message
7. `expect(initialMessageText).toContain('artifact_read({ workflowId: "' + source.workflow.id + '", path: "RESEARCH.md" })')` — explicit source UUID in artifact refs

# Task 5: Fixture Migration to UUID Helpers

## Summary
Migrated all positive workflow test fixtures from human-readable slug IDs (wf-*) to descriptive titles or deterministic UUIDs.

## Files Changed
- packages/agent-core/src/agents/workflow/guards.test.ts
- packages/agent-core/src/tools/builtins/workflow/workflow-tools.test.ts
- packages/agent-core/src/agents/workflow/artifacts.test.ts
- packages/agent-core/src/agents/workflow/workflow-error-behavior.test.ts
- packages/agent-core/src/agents/workflow/linking.test.ts
- packages/agent-core/src/agents/workflow/critic-protocol.test.ts
- packages/agent-core/src/agents/workflow/workflow-integration.test.ts
- apps/server/src/routes/workflow.test.ts

## Approach
1. For WorkflowStateManager.create() calls: changed titles from wf-* to descriptive names (e.g., "wf-prd" -> "PRD Draft")
2. For direct workflowId assignments in positive fixtures: used deterministic UUIDs (e.g., "550e8400-e29b-41d4-a716-446655440000")
3. For workflow_create tool tests: changed titles, preserved strict-schema rejection tests
4. Preserved all explicit invalid-ID tests in state.test.ts

## Test Results
- All 137 workflow tests pass across 11 files
- Typecheck passes across all 5 packages
- LSP diagnostics: zero errors on all changed files

## Evidence Files
- .sisyphus/evidence/task-5-fixture-migration.txt
- .sisyphus/evidence/task-5-fixture-migration-grep.txt

# Task 6: Active Workflow Prompt Context

## Implementation Notes

- Added `ActiveWorkflowPromptContext` to `PromptContext` with id/title/type/stage/status typed from workflow state exports.
- Added `packages/agent-core/src/prompt/sections/active-workflow.ts` with `hasWorkflowTools()`, `buildActiveWorkflowSection()`, and `formatActiveWorkflowBlock()`.
- Workflow-capable detection includes workflow tools and artifact tools: workflow_create/read/update_stage/complete/record_completion/task_check plus artifact_read/write.
- `buildSystemPrompt()` inserts Active Workflow after Workflow MVP Orchestration and before Skills/Tools.
- `ConfiguredAgent.run()` resolves project context before prompt creation, reads `store.workflowId` only when allowed tools are workflow-capable, and fails fast if workflow state cannot be read.
- `SessionExecutionManager.startChildExecution()` computes target child allowed tools, inherits workflowId into the child store, reads active workflow for workflow-capable children, and passes it into `buildChildUserMessage()` before available artifact refs.
- Non-workflow-capable agents omit active workflow even when the session has workflowId.

## Verification

- `bun test packages/agent-core/src/prompt/builder.test.ts --test-name-pattern "Active Workflow"` passed.
- `bun test packages/agent-core/src/execution/session-execution-manager.test.ts --test-name-pattern "active workflow"` passed.
- `bun test packages/agent-core/src/prompt/builder.test.ts packages/agent-core/src/execution/session-execution-manager.test.ts` passed.
- `bun test packages/agent-core/src/prompt/builder.test.ts packages/agent-core/src/execution/session-execution-manager.test.ts packages/agent-core/src/agents/configured-agent.test.ts` passed.
- `bun run typecheck` passed.

# Task 7: Propagate UUID/Title Contract Through Session Persistence, Protocol, Server, Web

## Implementation Notes

- **`WorkflowState` protocol interface got `title: string`**: Now matches the agent-core's `WorkflowStateSchema` which already required `title`. The protocol is the contract layer used by server/web, so this propagates the type through the full stack.
- **`SessionFileSchema.workflowId` → `z.string().uuid()`**: Previously `z.string()` without format validation. Now session files with non-UUID workflowId will be rejected on load. Since all workflow IDs are generated via `crypto.randomUUID()` in `create()` (Task 3), no stored sessions are affected.
- **`WorkflowInvalidIdError` exported from agent-core**: Added to the barrel export in `index.ts` so server routes can reference it without duplicating UUID validation logic.
- **Server routes map invalid IDs to 400 BadRequest**: Both the single-workflow GET route and `readRouteArtifact()` now catch `WorkflowInvalidIdError` and throw `BadRequestError` instead of letting it fall through to a 500.

## Files Modified

- `packages/protocol/src/types.ts` — Added `title: string` to `WorkflowState` interface
- `packages/agent-core/src/store/helpers.ts` — UUID validation in `SessionFileSchema`
- `packages/agent-core/src/store/helpers.test.ts` — Added non-UUID rejection test
- `packages/agent-core/src/index.ts` — Exported `WorkflowInvalidIdError`
- `apps/server/src/routes/workflow.ts` — Catch `WorkflowInvalidIdError` → `BadRequestError`
- `apps/server/src/routes/workflow.test.ts` — Added title assertion and invalid-ID 400 test
- `apps/web/src/api/queries.test.ts` — Added `title` to mock WorkflowState fixture

## Test Coverage

- helpers.test.ts: `load rejects non-UUID workflowId` — writes a session file with `workflowId: "not-a-uuid"` and asserts load throws.
- workflow.test.ts: `returns 400 for non-UUID workflow ID` — requests with `workflowId=not-a-uuid`, asserts 400 with `WorkflowInvalidIdError` message.
- workflow.test.ts: Existing `returns the requested workflow` now asserts `body.workflow.title` equals the created workflow's title.

## Verification

- All 61 helper tests, 22 workflow route tests, 6 web query tests pass
- Full monorepo typecheck passes across all 5 packages
- LSP diagnostics: 0 errors on all changed files

## Task 8 — Shared current-workflow guard for mutating tools

### Implementation
- Created `packages/agent-core/src/tools/builtins/workflow/guard-current-workflow.ts` with a `guardCurrentWorkflow()` function.
- The guard checks `ctx.store.getState().workflowId !== input.workflowId` and returns a `ToolExecutionResult` (error) or `undefined` (pass).
- When `workflowId` is set: shows both current and requested UUIDs in the error message.
- When `workflowId` is not set: says "requires the current session to be linked to a workflow".
- Error code: `TOOL_WORKFLOW_WRONG_WORKFLOW` across all guarded tools.
- Applied to: `workflow_update_stage`, `workflow_record_completion`, `workflow_complete`, `workflow_task_check`, `artifact_write`.

### Key decisions
- Guard runs immediately after input parsing and before any state/artifact mutation.
- `workflow_read` and `artifact_read` remain unguarded — they accept any valid UUID.
- Replaced old `TOOL_ARTIFACT_WRONG_WORKFLOW` in `artifact-write.ts` with shared guard; no legacy code path remains.
- Existing tests needed `store.getState().setWorkflowId(...)` to work with the new guard.


## Task 9

- Added end-to-end regression coverage for the original `workflow_read({ workflowId: "default" })` bug in both schema-level and registry/tool execution paths; assertions prove schema failure occurs before lookup/file-not-found handling.
- Strengthened active workflow prompt/session tests so workflow-bound child and grandchild prompts expose exact UUID/title/rules, proving child `store.workflowId` alone is insufficient for model salience.
- Extended derived W1/W2 integration coverage: W2 prompt exposes W2 UUID/title, source W1 artifact refs stay explicit via source UUID, explicit W1 reads remain allowed, and W2 writes to W1 fail with `TOOL_WORKFLOW_WRONG_WORKFLOW`.
