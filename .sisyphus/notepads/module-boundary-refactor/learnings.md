# Module Boundary Refactor - Learnings

## 2026-05-26 Session Start
- Plan has 11 implementation tasks + 4 final verification tasks
- 4 execution waves with explicit dependency matrix
- Wave 1 (Tasks 1-4): Independent, can all run in parallel
- Wave 2 (Tasks 5-7): Task 5+6 parallel after Task 1; Task 7 depends on Task 6
- Wave 3 (Tasks 8-10): Task 8 depends on 5+6+7; Task 9 depends on 8; Task 10 depends on 2+3+4+8
- Wave 4 (Task 11 + F1-F4): Final verification
- User explicitly requested parallel delegation with run_in_background

## 2026-05-26 Task 1 Architecture Tests
- Added red boundary tests in `packages/agent-core/src/__arch__/module-boundaries.test.ts` only; no production code changes.
- Existing architecture helpers use recursive `findTsFiles`, import extraction, and `expectNoViolations()` messages formatted as `file -> import/path/source-pattern`; new tests mirror that style.
- Current red violations detected include private root exports from `packages/agent-core/src/index.ts`, internal exports from `packages/agent-core/src/agents/index.ts`, server usage of session store internals/runtime session manager, raw built-in tool name arrays in agent permission modules, `memory-read.ts` direct `Bun.file()`/`parseFrontmatter`, and non-barrel/test-utils LSP imports.
- `bun test packages/agent-core/src/__arch__` intentionally fails before migration; keep these tests uncommitted until later migration work makes them green.

## 2026-05-26 Task 4: LSP barrel and test utils boundary
- Created `packages/agent-core/src/lsp/test-utils.ts` — re-exports `FakeLspServer`, `FakeLspServerConfig`, `DEFAULT_INITIALIZE_RESULT` from `./fake-server.ts`
- `lsp/index.ts` does NOT export `FakeLspServer` (confirmed with grep)
- Updated 5 production tool files under `tools/builtins/lsp/` to import from `../../../lsp` barrel instead of deep subpaths:
  - `format-output.ts`, `lsp-diagnostics.ts`, `lsp-goto-definition.ts`, `lsp-find-references.ts`, `lsp-symbols.ts`
- Updated 5 test files under `tools/builtins/lsp/` to:
  - Import `FakeLspServer` from `../../../lsp/test-utils` instead of `../../../lsp/fake-server`
  - Import production APIs (LspClient, setLspClientPoolForTest, pathToFileUri, etc.) from `../../../lsp` barrel instead of deep subpaths
- All 57 LSP tool tests pass
- Typecheck passes across all 4 packages
- Commit: `refactor(lsp): enforce barrel and test utils boundary`

## 2026-05-26 Task 2: Centralize builtin tool names
- Created `packages/agent-core/src/tools/names.ts` — 31 individual tool name constants (TOOL_FILE_READ, TOOL_GREP, etc.) as single source of truth
- Created `packages/agent-core/src/tools/groups.ts` — 4 tool groups referencing names.ts: EXPLORER_READ_ONLY_TOOLS, DELEGATION_TOOLS, SKILL_TOOLS, DELEGATION_EXECUTION_TOOLS
- Exported both through `tools/index.ts` barrel
- `agents/constants.ts` now imports tool groups from `../tools/groups` and re-exports them for backward compat (avoids breaking agents/index.ts, tool-filter.ts re-exports)
- `agents/workflow/permissions.ts` imports EXPLORER_READ_ONLY_TOOLS, SKILL_TOOLS, DELEGATION_EXECUTION_TOOLS from `../../tools/groups` instead of `../constants`
- `core/register-tools.test.ts` imports EXPLORER_READ_ONLY_TOOLS, DELEGATION_EXECUTION_TOOLS from `../tools/groups` instead of `../agents/constants`
- Added new test: `DELEGATION_EXECUTION_TOOLS` includes exactly delegate, background_output, wait_for_reminder, view_tool_output
- All 11 register-tools tests pass, all agent-core tests pass (12 pre-existing failures unrelated)
- Pre-existing: memory-read.ts has missing imports (join, parseFrontmatter, etc.) causing typecheck failures — not in scope of this task
- Commit: `refactor(tools): centralize builtin tool names`

## 2026-05-26 Wave 1 Task 3 - Route memory reads through file manager

### What was done
- Added `readTopicContent(name)` method to `MemoryFileManager` — reads raw topic file content without frontmatter parsing, returns `null` if file doesn't exist
- Refactored `memory-read.ts`:
  - Removed all `Bun.file()` direct file reads
  - Removed `readRawFile()` helper function
  - Removed `join`, `INDEX_FILE`, `KNOWLEDGE_DIR_NAME`, `PREFERENCES_FILE`, `parseFrontmatter` imports
  - `readTopicFile()` now uses `fileManager.readTopic()` with fallback to `fileManager.readTopicContent()` for files without valid frontmatter
  - Preferences read uses `fileManager.readPreferences()` instead of raw path + Bun.file
  - Index read uses `fileManager.readIndex()` instead of raw path + Bun.file
- Converted `memory/index.ts` from wildcard (`export *`) to explicit grouped exports (matching LSP barrel pattern)

### Key decisions
- `readTopicContent()` added as a new method rather than modifying `readTopic()` because the frontmatter-parsing behavior of `readTopic()` is correct for other consumers (extraction, manifest). The raw read fallback is tool-specific.
- Frontmatter parsing error → raw content fallback preserves the existing tested behavior for topic files without valid frontmatter.

### Files changed
- `packages/agent-core/src/memory/file-manager.ts` — added `readTopicContent` (+7 lines)
- `packages/agent-core/src/memory/index.ts` — explicit exports (+47/-5 lines)
- `packages/agent-core/src/tools/builtins/memory-read.ts` — no more Bun.file/join/constants imports; all reads routed through manager (-62/+43 lines)

### Verification
- `bun run typecheck` — 4/4 packages pass
- `bun test packages/agent-core/src/tools/builtins/memory-read.test.ts packages/agent-core/src/memory` — 97/97 pass
- LSP diagnostics clean on all changed files
- Commit: `refactor(memory): route reads through file manager`

## 2026-05-26 Task: Core-owned deferred session events
- Added `packages/agent-core/src/deferred/` with `DeferredPermissionService` and `DeferredQuestionService`; pending permission/question maps now live in agent-core.
- `SpecraRuntime` now exposes high-level deferred APIs: `requestPermission`, `respondPermission`, `requestQuestion`, `respondQuestion`, `cleanupDeferredSession`, and `notifyRuntimeShutdown`.
- Deferred request/terminal/shutdown events are appended through runtime-owned `submitDeferredEvent(workspaceRoot, sessionId, event)` rather than server services writing stores.
- `apps/server/src/permission-service.ts` and `apps/server/src/ask-user-service.ts` are thin runtime adapters and no longer accept or import store types.
- Removed server shutdown store writes from `session-event-bridge`; lifecycle now emits global shutdown and calls `runtime.notifyRuntimeShutdown("server_shutdown")`.
- `apps/server/src` no longer contains `.getState().append(` sites; tests that need store appends split state reads from append calls.
- Added core deferred tests for permission approve/deny/timeout/cancelled and question resolved/error/cancelled paths.
- Required deferred/server test suite passes; `bun run typecheck` passes after server `rootDir` was widened so workspace package source imports are valid during server typecheck.

## 2026-05-26 Task: Store-owned session persistence
- Store persistence moved behind `SessionStoreManager`: new sessions, `user-message`, `run-end`, and metadata actions (`setTitle`, parent/child links) now trigger serialized fire-and-forget writes through store internals.
- Removed active `transcript-save` hook and deleted its hook/test; title generation now calls the store metadata action so generated titles persist.
- Root public API no longer re-exports session store manager/state or session file read/write helpers; runtime/server routes use store-owned session file projection APIs instead.
- Verification passed: focused store/title/architecture tests and full `bun run typecheck`; LSP diagnostics clean on changed areas.

## 2026-05-26 Task: Core-owned agent job lifecycle
- Added `packages/agent-core/src/runner/AgentJobRunner` owning active job map, abort/abortAndWait/abortAll, per-workspace session-slot acquire/release, runtime-backed permission/question callbacks, session-event subscription, and delete-session cleanup.
- `SpecraRuntime` public surface now exposes `submitAgentJob`, `abortAgentJob`, `abortAgentJobAndWait`, `abortAllAgentJobs`, `isAgentJobRunning`, `getAgentJob`, `subscribeSessionEvents`, and `deleteSession`; it no longer exposes `sessionAgentManager`, `storeManager`, or `agentFor`.
- `dispatchCommand` is routed through `SessionAgentManager.dispatchCommand()` against the optional `Agent.dispatchCommand` interface, removing public-runtime `instanceof ConfiguredAgent` dispatch.
- Server `AgentRunner` is now a thin adapter that subscribes runtime session events into `globalEventBus` and delegates all job lifecycle/command methods to runtime; server route tests use runtime lifecycle APIs instead of importing core `Agent`/callback internals.
- `scopedKey` moved to internal `store/key.ts` and is no longer exported from `store/store.ts`.
- Verification passed: LSP diagnostics clean, `bun run typecheck`, full `bun run test`, and `bun test packages/agent-core/src/__arch__`.

## 2026-05-26 Task: Server depends on runtime session APIs
- `apps/server/src/routes/sessions.ts` now delegates create/get/list/delete to `SpecraRuntime` APIs; delete calls only `runtime.deleteSession()` and no longer aborts/disposes/unregisters/removes files directly.
- Deleted the old server `session-event-bridge`; runtime `subscribeSessionEvents()` plus the thin `AgentRunner` global-bus adapter owns SSE forwarding, so server no longer registers raw store bridges.
- `apps/server/src/routes/workflow.ts` verifies session existence through `runtime.getSessionFile()` instead of importing `getSessionsDir()` or checking session files directly.
- Server route tests now use runtime-shaped fakes rather than `SessionStoreManager`, session helper internals, `sessionAgentManager`, or `agentFor` fields.
- Boundary search confirmed no `StoreApi`, `SessionStoreState`, `saveSessionTranscript`, `readSessionFile`, `scopedKey`, `sessionAgentManager`, `getSessionsDir`, raw `.getState()`, or `session-event-bridge` references remain under `apps/server/src`.
- Verification passed: LSP diagnostics clean on changed server files, `bun test apps/server/src packages/agent-core/src/__arch__`, and `bun run typecheck`.

## 2026-05-26 Task: Final public API cleanup
- Root `@specra/agent-core` exports now omit old session internals: `SessionAgentManager`, `createSessionStore`, `getSessionsDir`, and `SessionFile` are no longer exported from `packages/agent-core/src/index.ts`.
- `agents/index.ts` no longer exports `ConfiguredAgentOptions`, `QueryLoopOptions`, or `QueryLoopResult`; direct query loop APIs remain internal under relative package paths.
- Deleted the obsolete `agents/tool-filter.ts` re-export and its re-export-only test; delegation tool constants now come from `agents/constants.ts` or `tools/groups.ts`.
- Removed stale `transcript-save` assertions from configured-agent hook tests; no transcript-save hook file or registration remains.
- Server permission/question services were verified as thin runtime response/request adapters with no store coupling or deep agent-core imports.
- Verification passed: LSP diagnostics clean on changed files, `bun run typecheck`, `bun test packages/agent-core/src/__arch__`, and full `bun run test`.
