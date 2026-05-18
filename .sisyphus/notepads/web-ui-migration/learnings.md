# web-ui-migration - learnings

## [INIT] Key codebase conventions (atlas-discovered)

### Manager construction signatures (W1.M1 reference critical)
- **WorkflowStateManager**: `new WorkflowStateManager(workspaceRoot: string)` - constructor takes single string. No load() method - all methods are async on demand. State stored at `<workspaceRoot>/.specra/workflows/<id>/workflow.json`.
- **MemoryFileManager**: `new MemoryFileManager({ project: string, user: string })` - **constructor param keys are `project` and `user`** (NOT `projectRoot` / `userRoot`). The class exposes `projectRoot` / `userRoot` as public readonly fields after construction. No standalone `load()` method.
- **ProjectApprovalManager**: `new ProjectApprovalManager(logger?: Logger)` - constructor takes optional Logger. **Requires `await manager.load(workspaceRoot)` before use.** Has `hasApproval` / `addApproval` / `reloadIfStale` / `listApprovals`.

### Zod patterns
- All schemas use `.strict()` (or `z.strictObject(...)`)
- `import { z } from "zod"` or `"zod/v4"` (both appear) - check existing imports in target dir before adding new file
- `z.iso.datetime()` for ISO timestamps
- `z.uuid()` for UUIDs

### File/atomic-write
- Use `atomicWrite` from `src/utils/safe-file` for any disk persistence
- `resolveContainedPath` for safe joining inside a root
- `SafePathError` thrown on escape attempts → wrap into custom domain error class

### Custom error classes (project convention)
- Always extend `Error`
- Always set `this.name = "ClassName"` explicitly
- Public typed constructor fields preferred over string interpolation
- Example: `WorkflowPathError`, `MemoryPathError`

### Test patterns
- bun:test, import from `"bun:test"`
- Use `mock()` not `jest.fn()`
- Test files colocated `<name>.test.ts`
- Temp dirs under `__test_tmp__/` cleaned in `afterAll`
- Use `Bun.file()`, `node:fs/promises` for fs

### Barrel exports
- Each subsystem dir has `index.ts` that re-exports public surface

## [INIT] Plan-wide architecture constraints
- Headless core: `src/agents/**` MUST NOT import `src/web/**` / `src/server/**` (enforced by W7.X4 architecture test)
- `src/store/reduce.ts` MUST be 0 node:* / 0 Bun.* imports (isomorphic for browser)
- ToolExecutionContext.workspaceRoot must be a getter on projectContext.project.workspaceRoot (single source of truth)
- ALL UI strings (buttons/labels/errors/tooltips) must be English. Only agent↔user chat content may be Chinese.
- ALL code/filenames/variables/comments must be English.
- NEVER commit. User reviews and commits manually at the end.

## [INIT] Notepad protocol
- Append-only. Never overwrite. Append timestamped sections per task.

## [2026-05-18 W1.M1] Confirmed Manager export paths
- `WorkflowStateManager` — named class export at `src/agents/workflow/state.ts:85`
- `MemoryFileManager` — named class export at `src/memory/file-manager.ts:97`
- `ProjectApprovalManager` — named class export at `src/tools/permission/project-approvals.ts:96`
- All use `import type` for type-only references; Manager classes are never imported as values in a types module.
- `export * from "./types"` barrel pattern confirmed at `src/memory/index.ts`.

## [2026-05-18 W1.M1] Zod patterns confirmed
- Both `"zod"` and `"zod/v4"` import paths work (package has zod ^4.4.2). Used `"zod/v4"` to match `memory/schemas.ts` pattern.
- `z.strictObject({...})` is the canonical form for schemas that reject unknown keys.
- Timestamp fields use `z.string()` (ISO datetime string), consistent with existing codebase — no `z.iso.datetime()` or `z.string().datetime()` seen in use.
- `z.ZodType<T>` used for schema-to-type annotation.

## [2026-05-18 W1.M2] ProjectContextResolver patterns
- ProjectContextResolver caches in-flight Promise<ProjectContext> entries by workspaceRoot, so concurrent resolve calls share construction and ProjectApprovalManager.load runs once per unique workspace.
- Constructor factories for workflowState, memory, and approvals make internal Manager construction testable without changing Manager implementations.
- Placeholder ProjectInfo uses basename(workspaceRoot) for slug/name until W1.M7 registry lookup replaces it.

## [2026-05-18 W1.M3] ToolExecutionContext refactor patterns
- `ToolExecutionContext` now requires `projectContext`; `workspaceRoot` is constructed via `createToolExecutionContext(base)` as an `Object.defineProperty` getter returning `projectContext.project.workspaceRoot`.
- `ProjectContext` now includes `artifacts: WorkflowArtifactManager`; `ProjectContextResolver` constructs `workflowState` first, then constructs `artifacts` with the same workspace root and workflow state manager.
- `ToolRegistry` no longer owns a `ProjectApprovalManager`; persistent approval checks and `approve_always` writes use `ctx.projectContext.approvals` per execution.
- `createRegistry()` now accepts only `(descriptors?, logger?)`; approval managers belong in the execution context test fixture or resolver-created project context.
- Memory, workflow, and artifact tool factories are now zero-argument factories. Their `execute(input, ctx)` implementations read managers from `ctx.projectContext.memory`, `ctx.projectContext.workflowState`, and `ctx.projectContext.artifacts`.
- `registerBuiltinTools(registry)` no longer constructs managers and contains no `process.cwd()` manager binding; runtime tools depend on the query loop/agent-provided project context.
- Tests that construct `ToolExecutionContext` should prefer `createToolExecutionContext(...)`; reusable fixtures can use `src/tools/test-project-context.ts` for manager-backed test contexts.

## [2026-05-18 W1.M3 + W1.M4] ToolExecutionContext refactor patterns

- `ToolExecutionContext.workspaceRoot` is installed as a **getter** by helper `createToolExecutionContext()` in `src/tools/types.ts` (lines 46-58). Reads from `projectContext.project.workspaceRoot` — single source of truth.
- All tool factories now take **ZERO** manager args. e.g. `createMemoryReadTool()`, `createWorkflowCreateTool()`. Managers read at execute time from `ctx.projectContext.*`.
- `ProjectContext` has 5 fields: `project / workflowState / memory / approvals / artifacts`. Artifacts added during M3 because workflow tools needed `WorkflowArtifactManager`.
- `ProjectContextResolver` constructs all 4 Managers (workflowState, memory, approvals, artifacts) with `artifacts = new WorkflowArtifactManager(workspaceRoot, workflowState)` sharing the same workflowState instance.
- `createRegistry(descriptors?, logger?)` — only 2 params now; `setProjectApprovalManager`/`ensureProjectApprovalsLoaded` removed entirely.
- `src/tools/test-project-context.ts` exports `createTestProjectContext(workspaceRoot)` — canonical helper for test fixtures. Use this in any new test that needs a `ProjectContext`.
- `ConfiguredAgent` constructor instantiates `ProjectContextResolver` once; `run()` calls `resolve(workspaceRoot)` each invocation. Same Manager instances reused across runs of same workspace = correct per-project lifecycle.

## [2026-05-18 W1.M4 audit findings]

Remaining `process.cwd()` sites in src/ (non-test) found during M4 verification:
1. `src/main.ts:106` — createSpecraRuntime workspaceRoot (M5 deletes)
2. `src/main.ts:217` — TUI render call (M5 deletes both ink import + render)
3. `src/agents/configured-agent.ts:92` — `options.workspaceRoot ?? process.cwd()` fallback (M5 removes fallback, makes required)
4. `src/agents/query/loop.ts:123` — `?? await realpath(process.cwd())` (M5 throws MissingProjectContextError)
5. `src/agents/query/hooks/title-generation.ts:23` — `workspaceRoot: process.cwd()` (M5 reads from agent.store; plan path typo had `src/background/tasks/title-generation.ts`, real path is hooks/)
6. `src/tools/builtins/bash.ts:145` — `permissions: [createBashPermission(process.cwd())]` (tricky: module-init binding; must make permission ctx-aware at call-time)

## [2026-05-18 W1.M5]

- `src/main.ts` is now headless: Ink/React/App imports are removed, main entrypoint calls `bootServer(runtime)`, and workspace root resolution uses `SPECRA_WORKSPACE_ROOT` or the real parent directory of the config path instead of `process.cwd()`.
- `src/server/boot.ts` contains the W2.S1 placeholder `bootServer(runtime)` and throws `NotImplementedError("bootServer is pending W2.S1 implementation")`; tests mock this module rather than Ink render.
- `MissingProjectContextError` was added in `src/agents/errors.ts`; `ConfiguredAgent` throws it when `options.workspaceRoot` is absent, while `AgentFactoryConfig.workspaceRoot` is required so factory callers cannot omit it.
- Query loop tool execution now requires a resolved workspace root and throws `MissingProjectContextError` instead of falling back to `realpath(process.cwd())`. For legacy test/direct call compatibility it can still derive from `projectContext.project.workspaceRoot`, then syncs that value back so `createToolExecutionContext()` getter exposes the explicit runtime workspace.
- `createTitleGenerationHook(btm, workspaceRoot)` now receives workspace root from `ConfiguredAgent.buildHooks()` and passes it into the background task context; no hook-level cwd lookup remains.
- `createBashPermission()` no longer accepts a fallback workspace argument. It reads only `ctx.workspaceRoot`, which comes from `createToolExecutionContext()`/ProjectContext. Bash permission tests and regression test call sites were updated to no-arg form.
- Making `QueryLoopOptions.workspaceRoot` required caused existing `src/tui/App.test.ts` type failures; kept the option type optional for direct/test compatibility while enforcing runtime absence with `MissingProjectContextError` at the tool-execution path.

## [2026-05-18 W1.M6] Regression test for process.cwd

### Test added
- `src/__arch__/no-process-cwd.test.ts` — architecture regression test that scans `src/` for `process.cwd` and fails if any occurrence exists outside `.test.ts` files or `__test_tmp__/` paths.

### How it works
- Uses `Bun.spawnSync(["grep", "-rn", "--include=*.ts", "process\\.cwd", "src/"])` to find all occurrences.
- Filters out `.test.ts` files and `__test_tmp__/` paths.
- Asserts the remaining violations array is empty.
- Fast (<150ms) and type-safe (no `as any`, no `@ts-ignore`).

### Verification
- RED: adversarial file `src/__arch__/__adversarial.ts` with `const x = process.cwd()` → test fails with clear diff output.
- GREEN: after deleting adversarial file → test passes cleanly.
- Evidence at `.sisyphus/evidence/task-w1m6-no-cwd-tdd.log` (RED + GREEN segments) and `task-w1m6-audit.txt`.

### Current process.cwd usage (all legit - in test files only)
- `src/tools/builtins/web-fetch.test.ts` — test fixture setup
- `src/tools/builtins/bash.test.ts` — test mock context
- `src/tui/App.test.ts` — test fixture setup
- `src/agents/query/loop.test.ts` — test fixture setup
- `src/main.test.ts` — test fixture setup
- `src/__arch__/no-process-cwd.test.ts` — test code itself (JSDoc + assertion string)

Non-test `src/`: **CLEAN** (0 matches).

## [2026-05-18 W1.M7] ProjectRegistry patterns
- ProjectRegistry persists the global project index at `homeDir/.specra/projects/index.json` with `{ version: 1, projects }`, using `atomicWrite` and a serialized `#writeQueue` mutation chain to avoid concurrent add data loss.
- Slug generation should use `input.name ?? basename(workspaceRoot)` with lowercase non-alphanumeric runs collapsed to `-`, empty slugs falling back to `project`, and conflict suffixes starting at `-2` only after idempotent workspace matching is ruled out.
- Defensive load should never delete malformed registry files: missing files produce an empty cache, malformed JSON/schema logs one warning and returns an empty list.
- Directory validation must use `node:fs/promises` `stat().isDirectory()`; `Bun.file().exists()` is not sufficient for directory-only checks.

## [2026-05-18 W1.M8] Session-per-project storage paths

- `getSessionsDir()` changed from zero-arg global path (`~/.specra/sessions/`) to `getSessionsDir(workspaceRoot: string)` returning `<workspaceRoot>/.specra/sessions/`.
- `__setSessionsDirForTest` now takes a function `((workspaceRoot: string) => string) | undefined` instead of a bare string. All test call sites updated with `() => dir` closure pattern.
- `saveSessionTranscript(state, workspaceRoot)` and `loadSessionTranscript(sessionId, workspaceRoot)` both added `workspaceRoot` as required second param.
- `createTranscriptSaveHook(btm, workspaceRoot)` — follows W1.M5 pattern: closure-captured workspaceRoot passed to hook factory (matches `createTitleGenerationHook` pattern).
- `ConfiguredAgent.buildHooks()` line 278 updated: `createTranscriptSaveHook(btm, this.workspaceRoot)`.
- `title-generation.ts` `saveSessionTranscript` call updated to pass `ctx.workspaceRoot`.
- 3 files with string `__setSessionsDirForTest` calls fixed: `configured-agent.test.ts`, `factory-delegation.test.ts`, `hooks/title-generation.test.ts`.
- All 2143 tests pass, typecheck clean, grep verification passes.

## [2026-05-18 W1.M9]

- `SpecraRuntime` now exposes `projectRegistry`, shared `contextResolver`, and async `agentFor(workspaceRoot)` while keeping `agent` as deprecated backward compatibility for the default workspace root.
- `createSpecraRuntime()` creates the default `ConfiguredAgent` object eagerly for compatibility, but does not resolve `ProjectContext` during startup; context construction remains lazy in `ConfiguredAgent.run()` through `ProjectContextResolver.resolve()`.
- `agentFor` caching is a plain `Map<string, Agent>` keyed by exact workspaceRoot string; same path returns the same agent, different paths create separate root orchestrator agents that share provider/tool registries and the shared `ProjectContextResolver`.
- `AgentFactoryConfig.projectContextResolver` and `ConfiguredAgentOptions.projectContextResolver` are optional, preserving existing callers while allowing runtime-created agents to share a resolver/cache.
- `main.test.ts` can use existing temp-root cleanup by extracting `makeTempRoot()` from `writeConfig()`; agentFor tests should pass real existing directories.

## [2026-05-18 W2.S1]

- Hono server skeleton lives under `src/server/` with `createServerApp(runtime, options)` wiring `app.onError(errorHandler)`, request logger, dev wildcard CORS, optional Basic auth, `/api/health`, and empty API route groups for future W2 steps.
- `errorHandler` preserves the single server error envelope `{ error: { code, message, details? } }`; Hono's `c.json` status overload requires literal contentful status types, so dynamic `ServerError.httpStatus: number` is emitted with a direct `Response` helper instead.
- `startServer(app, options)` uses `Bun.serve({ fetch: app.fetch, idleTimeout: 0 })`, tries the preferred port first, and falls back to `port: 0` when the preferred port is busy. `server.port` can type as `number | undefined`; guard and stop the server if Bun ever reports no TCP port.
- `bootServer(runtime)` now starts the server through `createServerApp` + `startServer`; dev mode is currently inferred from absence of `SPECRA_SERVER_PASSWORD`.
- TDD evidence for RED/GREEN/test/typecheck/grep checks is recorded at `.sisyphus/evidence/task-w2s1-skeleton-tdd.log`.
