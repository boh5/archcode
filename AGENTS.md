## Project

Specra — long-running coding CLI agent that orchestrates AI roles (PM, backend, frontend, QA, PR review) from the terminal.

## Runtime & Toolchain

- **Runtime**: Bun (not Node). All scripts use `bun run` / `bun test`.
- **Package manager**: Bun (bun.lock present, not package-lock).
- **TypeScript**: strict mode, ES2022 target, bundler module resolution. Do NOT use `.js` extensions in imports.

## Commands

```sh
bun run dev          # Run CLI entry point (src/main.ts)
bun run typecheck    # tsc --noEmit
bun test             # Run tests (bun:test runner)
```

Validation order: `typecheck` → `test`.

## Architecture

```
src/main.ts                        # CLI entry point: config → providers → tools → agent → Ink render
src/config/                        # Config loading (JSON), Zod validation (.strict() on all schemas)
src/provider/                       # Provider registry & ModelInfo (wraps AI SDK instances)
src/agents/test-agent.ts           # TestAgent: wires provider + tools, owns session store, runs query loop
src/agents/query/loop.ts            # Query loop: streamText + tool execution cycle (max 50 steps)
src/tools/                          # Tool system: define-tool, registry, hooks/guards, concurrency partition
src/tools/builtins/                 # 7 builtin tools: file_read, file_write, file_edit, grep, glob, git_status, git_diff
src/tools/hooks/                   # Before/after hooks + guard hooks (workspace guard, read-snapshot, permission, truncation, logging)
src/tools/concurrency/              # Mutation queue + partition (parallel-safe vs serial tool calls)
src/store/                          # Zustand session store: stream events → StoredMessages → ModelMessage projection
src/tui/                             # Ink React terminal UI (App, UserInput, TranscriptView)
src/core/register-tools.ts          # Wires builtin tools + global after-hooks (logger, truncator) into registry
```

**Data flow:**
```
.specra.json → config/ (load + validate) → provider/ (registry + ModelInfo) → agents/ (streamText loop) → store/ (zustand events) → tui/ (Ink render)
```

**Tool execution flow:**
```
streamText → toolCalls → partitionToolCalls (parallel vs serial) → guards (workspace, read-snapshot, sensitive) → before hooks → execute → after hooks
```

**Config structure** (`.specra.json`):
```json
{
  "provider": {
    "<providerId>": {
      "npm": "@ai-sdk/openai-compatible",   // Only this provider package is supported
      "name": "...",
      "options": { "baseURL": "...", "apiKey": "..." },
      "models": { "<modelId>": { "name": "...", "limit": { "context": N, "output": N }, "modalities": { "input": ["text"], "output": ["text"] } } }
    }
  }
}
```

## Key Dependencies

- `ai` + `@ai-sdk/openai-compatible` — LLM calls via Vercel AI SDK. `streamText` is the core API.
- `ink` + `react` — Terminal UI (Ink renders React components in the terminal).
- `zustand` — State management. Session store is a vanilla Zustand store (`createStore`), connected to Ink via `useStore`.
- `zod` (v4) — Schema validation with `.strict()` on all objects.

## Conventions

- Talk in chinese, code in english (include comments).
- If you have any questions or choices, feel free to ask user.
- Use TDD development.
- Custom error classes extend `Error` with typed constructor params, explicit `this.name = "ClassName"`, and meaningful public fields.
- Barrel exports via `index.ts` files in each module.
- All Zod schemas use `.strict()` — no passthrough of unknown properties.
- Test runner: `bun:test` (not Jest/Vitest). Import from `"bun:test"`.
- Test file convention: `<name>.test.ts` colocated with source.
- Tests create temp files in `__test_tmp__/` relative to test file dir, cleaned up in `afterAll`.
- Entry point is `src/main.ts` (not `src/index.ts`). The `package.json` bin field points to `./src/main.ts`.

## Testing Patterns

- Mock `streamText` via `__setStreamTextForTest(fn)` export from `agents/query/loop.ts` — overrides the module-level `_streamText` in tests.
- Use `createSessionStore(randomUUID())` to create test stores.
- Use `createRegistry([])` for empty tool registries in tests.
- File-system tests use `import.meta.dir` to locate paths and `__test_tmp__/` subdirectories.
- All custom errors have a named `this.name` field — test error names, not just messages.

## Tool System

- Tools are defined via `defineTool()` which returns a `ToolDescriptor` with: name, description, inputSchema (Zod), traits, hooks, guards, and execute function.
- `ToolTraits`: `{ readOnly, destructive, concurrencySafe }` — controls parallel execution and guard behavior.
- `ToolRegistry.register(descriptor)` — throws `DuplicateToolError` on name collision.
- `ToolRegistry.execute(toolCall, ctx)` — full pipeline: prepareInput → schema parse → permission guards → before hooks → execute → after hooks.
- `partitionToolCalls()` groups adjacent `concurrencySafe: true` calls into parallel batches; each `concurrencySafe: false` call becomes a serial batch.
- Guards return `{ outcome: "allow" | "deny" | "ask" }`. `"ask"` triggers user confirmation via `ToolConfirmationCallback`.

## Session Store

- Zustand vanilla store created per agent session.
- `append(event: StreamEvent)` is the single entry point — all state changes flow through the reducer-like `reduceStreamEvent()`.
- `toModelMessages()` reconstructs AI SDK-compatible `ModelMessage[]` from stored parts for the next loop step.
- Tool parts have a state machine: `pending → running → completed | error`.
- `readSnapshots` (Map<string, number>) tracks file mtimes for the edit guard.
- `BusyError` thrown if `run-start` is dispatched while `isRunning === true`.