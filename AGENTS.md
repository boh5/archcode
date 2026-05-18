## Project

Specra — long-running coding agent with Hono server + React Web UI. Two-tier agent architecture (Orchestrator + Explorer sub-agents) with structured tool execution, LSP integration, persistent memory, and context compaction.

## Runtime & Toolchain

- **Runtime**: Bun (not Node). All scripts use `bun run` / `bun test`.
- **Package manager**: Bun (bun.lock present, not package-lock).
- **TypeScript**: strict mode, ES2022 target, bundler module resolution. Do NOT use `.js` extensions in imports.
- **Entry point**: `src/main.ts` with `import.meta.main` guard; headless server boot, no terminal UI.

## Commands

```sh
bun run server       # Start Hono API/SSE server with hot reload (src/main.ts)
bun run web          # Start Vite React frontend (src/web)
bun run dev          # concurrently starts server + web with [server]/[web] prefixes
bun run build        # typecheck + Vite production build
bun run start        # Start production Hono server (single-port API + UI)
bun run typecheck    # tsc --noEmit
bun test             # Run tests (bun:test runner)
```

Validation order: `typecheck` → `test`.

## Architecture

```
src/main.ts                         # Headless server entry: createSpecraRuntime() → config → providers → tools → MCP → bootServer()
src/config/                         # Config loading (JSON), Zod validation (.strict() on all schemas)
src/provider/                       # Provider registry & ModelInfo (wraps AI SDK instances)
src/agents/definitions/             # AgentDefinition records for orchestrator, explore, and workflow roles
src/agents/factory.ts               # Agent creation and delegation through ConfiguredAgent
src/agents/constants.ts             # EXPLORER_READ_ONLY_TOOLS, DELEGATION_TOOLS lists
src/agents/errors.ts                # NoModelsConfiguredError, AgentRunningError, SubAgentError, ConcurrentLimitError, DepthLimitError
src/agents/query/loop.ts            # streamText + tool execution cycle (max 50 steps), doom detection
src/agents/query/loop-hooks.ts      # 4 hook points: beforeModelBuild, beforeModelCall, afterStepEnd, afterLoopEnd
src/agents/query/hooks/             # auto-compact, auto-inject-reminder, title-generation, todo-continuation, transcript-save, memory-extraction, memory-consolidation
src/tools/define-tool.ts            # defineTool() → ToolDescriptor (name, inputSchema, traits, hooks, guards, execute)
src/tools/registry.ts               # register/registerAll/execute, globalGuards, globalHooks
src/tools/hooks/                    # Guards: workspace, read-snapshot, sensitive-file, memory-index, bash-classifier; After: edit-error-recovery, redact, truncate, audit, logger
src/tools/concurrency/partition.ts  # partitionToolCalls(): groups concurrencySafe calls into parallel batches
src/tools/builtins/                 # 21 builtin tools (see Tool System section)
src/core/register-tools.ts          # Wires builtins + memory tools + global after-hooks (redact → truncate → audit → logger)
src/store/                          # Zustand vanilla store: createSessionStore, StreamEvent reducer, ModelMessage projection, persist/load
src/background/                     # BackgroundTaskManager (fire-and-forget, dedup) + tasks: title-generation, memory-extraction, memory-consolidation
src/commands/                       # CommandRegistry + /compact command
src/compact/                        # 3-phase pipeline: selectPrefix → pruneOutputs → summarize (streamText). Circuit breaker + token estimation
src/lsp/                            # LspClientPool (acquire/release, idle timeout, crash detection), StdioLspTransport, auto-installer, 18 language servers, 50+ ext mappings
src/llm/                            # llmObject<T>(): generateText + forced tool call + Zod validation → typed result
src/memory/                         # MemoryFileManager (atomic writes, frontmatter, index), schemas, types, constants
src/projects/                       # ProjectRegistry + ProjectContextResolver for multi-project workspace isolation
src/prompt/                         # buildSystemPrompt(): Identity → Guidelines → Tools → Environment → Memory → Project(AGENTS.md)
src/security/                       # 3 secret-detection regex patterns + containsSecretPattern()
src/server/                         # Hono REST + SSE server with auth, CORS, error handling, lifecycle, services, routes
src/mcp/                            # Built-in servers (context7, grep.app, exa) + HTTP discovery → ToolDescriptors
src/web/                            # Vite + React + Tailwind frontend, separate build artifact served by production server
src/utils/                          # getSystemErrorCode
```

**Data flow:**
```
.specra.json → config → providers → registerBuiltinTools + MCP → Hono server → project-scoped OrchestratorAgent → query loop → store → SSE → Web UI

Delegation: delegate tool → AgentFactory → ConfiguredAgent child (filtered tools, own store) → reminder to parent
```

**Server + Web UI:**
- `src/main.ts` creates `SpecraRuntime`, registers providers/tools/MCP, initializes `ProjectRegistry` + `ProjectContextResolver`, then calls `bootServer(runtime)`.
- `src/server/app.ts` builds the Hono app: request logging, CORS, optional Basic auth via `SPECRA_SERVER_PASSWORD`, `/api/health`, project/session/message/event/permission/question/command/workflow/file routes, and centralized errors.
- `src/server/boot.ts` starts the server on `SPECRA_PORT` (default `4096`) and wires graceful shutdown. Development mode is inferred when `SPECRA_SERVER_PASSWORD` is unset.
- `src/web/` is the React frontend. In development it runs through Vite with `bun run web`; production uses `bun run build` then `bun run start` so Hono can serve API + UI from one port.

**Multi-project model:**
- `src/projects/registry.ts` persists registered workspaces under `~/.specra/projects/index.json`, validates absolute existing directories, derives stable slugs, and tracks open times.
- `src/projects/context-resolver.ts` creates per-workspace runtime context: workflow state, project memory, approvals, and artifacts.
- `SpecraRuntime.agentFor(workspaceRoot)` lazily creates one root Orchestrator agent per workspace and caches it.
- Web UI Add Project flow should register an existing workspace directory, then use project-scoped API routes (`/api/projects/:slug/...`) for sessions, files, workflow, and events.

**SSE + Deferred pattern:**
- Session streaming lives in `src/server/routes/events.ts`; clients connect to `/api/projects/:slug/sessions/:sessionId/events`.
- Event names are `stream`, `permission.request`, `question.request`, `heartbeat`, and shutdown-related lifecycle notifications. `stream` carries flattened store events such as text deltas, reasoning deltas, tool calls/results, compaction, steps, reminders, and todos.
- `EventRing` stores recent events and supports replay via `Last-Event-ID` or `lastEventId`; heartbeat emits every 15 seconds to keep connections alive.
- Cross-network confirmations use a deferred request/response pattern: `PermissionService.request()` pushes `permission.request` into the session ring and returns a Promise that resolves when `/api/permissions` responds; `AskUserService.request()` does the same with `question.request` and `/api/questions`.
- Abort signals and cleanup resolve pending confirmations safely (`timeout` for permissions, cancelled response for questions) so agent execution is not left hanging when a client disconnects or a job shuts down.

**Tool execution pipeline:**
```
partitionToolCalls → globalGuards (memory-index-guard) → tool guards (workspace, read-snapshot, sensitive-file, bash-classifier)
  → before hooks → execute → after hooks (edit-error-recovery) → global after (redact → truncate → audit → logger)
```

**Config** (`.specra.json`): `provider.<id>.{npm, name, options, models}` + `agents.<agentName>.{model, variant, options}` + `mcp.servers.<id>.{url, headers, enabled}`. Strict Zod. Env expansion: `${VAR}`, `${VAR:-default}`.

**Model configuration** (`.specra.json`):
- Provider ids and model ids combine as `provider:modelId` (example: `"local:glm-5"`). Do **not** use `provider/model`.
- `provider.<id>.models.<modelId>.options` defines base AI SDK model-call options for that model. Use AI SDK camelCase names such as `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, `maxRetries`, `timeout`, and `providerOptions`.
- `provider.<id>.models.<modelId>.variants.<variantName>` defines named option profiles for the same model. An agent's `variant` references one of these names and is consumed during resolution; it is never passed to the AI SDK call.
- `agents.<agentName>.model` is required for every instantiated agent. Current instantiated agents are `orchestrator` and `explore`, so both must be configured during migration or creation fails fast.
- `agents.<agentName>.options` overrides the selected model and variant options. Merge order is shallow: model `options` → selected `variants[variant]` → agent `options`.
- `providerOptions` follows the same shallow merge rule as one top-level key: later layers replace the whole `providerOptions` object rather than deep-merging nested provider settings.
- Unknown model ids, unknown variant names, and missing agent model config all fail fast with actionable errors.

Minimal example:
```json
{
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "local",
      "options": {
        "baseURL": "http://localhost:8090/v1",
        "apiKey": "${LOCAL_API_KEY:-local-dev-key}"
      },
      "models": {
        "glm-5": {
          "name": "GLM-5",
          "limit": { "context": 200000, "output": 128000 },
          "modalities": { "input": ["text"], "output": ["text"] },
          "options": {
            "maxOutputTokens": 64000,
            "temperature": 0.2,
            "topP": 0.95,
            "providerOptions": {
              "local": { "reasoningEffort": "high" }
            }
          },
          "variants": {
            "fast": {
              "maxOutputTokens": 16000,
              "temperature": 0.1
            },
            "deep": {
              "maxOutputTokens": 128000,
              "temperature": 0.3,
              "topP": 0.9
            }
          }
        }
      }
    }
  },
  "agents": {
    "orchestrator": {
      "model": "local:glm-5",
      "variant": "deep",
      "options": { "temperature": 0.25, "maxRetries": 2 }
    },
    "explore": {
      "model": "local:glm-5",
      "variant": "fast",
      "options": { "temperature": 0, "maxOutputTokens": 12000 }
    }
  }
}
```

## Agent Architecture

| Role | Hooks | Notes |
|------|-------|-------|
| **Orchestrator** (never in registry) | auto-compact, auto-inject-reminder, title-generation, todo-continuation, transcript-save, memory-extraction, memory-consolidation | Owns store + SubAgentManager. Todo-continuation retry loop after each `runQueryLoop()` |
| **Explorer** (`"explore"` in registry) | auto-compact, auto-inject-reminder, todo-continuation | Depth-aware tool filtering. Own session store. Simpler hooks |

Both implement `Agent`: `store: StoreApi<SessionStoreState>`, `run(userMessage, ...) → AgentResult { text, steps }`.

**Tool filtering by depth:**
- Explorer depth < 2: read-only tools + delegation tools (delegate, wait_for_reminder, background_output)
- Explorer depth ≥ 2: read-only tools only (file_read, grep, glob, git_status, git_diff, lsp_*, web_fetch, ask_user, todo_write)

**Query loop lifecycle:**
```
beforeModelBuild (auto-compact) → toModelMessages → beforeModelCall (auto-inject-reminder)
  → streamText → consumeFullStream → afterStepEnd (todo-continuation)
  → executeToolCalls (doom detection → partition → guards → execute)
→ afterLoopEnd (todo-continuation, transcript-save, memory-extraction, memory-consolidation)
```

## Tool System

**21 builtin tools** (1–15 via `createBuiltinToolDescriptors()`, 16–19 LSP, 20–21 memory via factory with `MemoryFileManager`):

| Category | Tools | Notes |
|----------|-------|-------|
| File I/O | file_read✅, file_write❌, file_edit❌ | Guards: workspace, sensitive-file, read-before-edit (edit), file-exists (write). After: read-snapshot (read), edit-error-recovery (edit) |
| Search | grep✅, glob✅ | Guard: workspace |
| Git | git_status✅, git_diff✅ | — |
| Shell | bash❌✅destructive | Guard: bash-classifier |
| Interaction | ask_user✅❌not-concurrent, todo_write❌ | ask_user serializes (interactive) |
| Web | web_fetch✅ | — |
| LSP | lsp_diagnostics✅, lsp_goto_definition✅, lsp_find_references✅, lsp_symbols✅ | Guard: workspace |
| Delegation | delegate❌, background_output✅, wait_for_reminder✅, view_tool_output✅ | — |
| Memory | memory_read✅, memory_write❌ | memory_write rejects secrets |

(✅ = readOnly, ❌ = not readOnly, ✅destructive = only destructive tool)

**Global**: memory-index-guard denies edits to `.specra/memory/index.md` on file_write/file_edit. Global after-hooks: **redact → truncate → audit → logger**.

**Core API**: `defineTool()` → `ToolDescriptor`. `ToolTraits: { readOnly, destructive, concurrencySafe }`. `partitionToolCalls()` groups concurrent-safe calls into parallel batches. Guards return `{ outcome: "allow" | "deny" | "ask" }`.

## Session Store

Zustand vanilla store per agent session. `append(StreamEvent)` → `reduceStreamEvent()` → `toModelMessages()`. Tool parts: `pending → running → completed | error`. `readSnapshots` (Map<path, mtime>) for edit guard. `BusyError` if run-start while running. Reminders: todo_step_reminder, todo_loop_continuation, subagent_completed/failed/timed_out/cancelled. Persisted to `~/.specra/sessions/{id}.json`, validated by `SessionFileSchema` (strict Zod) on load.

## Context Compaction

Auto-compact at `contextTokens ≥ limit × 0.75` + ≥ 5 new messages. 3-phase: `selectCompactablePrefix` (preserve current + 2 last rounds) → `pruneToolOutputs` (persist to disk) → `summarizePrefix` (streamText structured summary). Circuit breaker (3 failures). Also `/compact` command. Token estimation: `TOKEN_CHARS_RATIO=4`, `parseStepUsage()` normalizes AI SDK/OpenAI/Anthropic/Google formats.

## Memory System

Project: `.specra/memory/`, User: `~/.specra/memory/`. Structure: `index.md` (topic index), `preferences.md`, `knowledge/{topic}.md` (frontmatter + markdown). Types: `"user" | "feedback" | "project" | "reference"`. `MemoryFileManager`: atomic writes, path validation, frontmatter parse/format, index rebuild/search. Extraction (background task via `llmObject`) → writes topics. Consolidation (background task) → reorganizes index. Injection: `prompt/sections/memory.ts` reads + truncates + wraps in `<specra-memory-context>` XML. `memory_write` rejects secrets.

## LSP Integration

`LspClientPool` (acquire/release, 5min idle timeout, crash loop detection). `LspClient` (Content-Modified retry 3x). `StdioLspTransport` (Bun.spawn + vscode-jsonrpc). Auto-install: `resolveServerBinary` → PATH → npm install -g → `~/.cache/specra/lsp-servers/`. 18 built-in servers, 50+ ext→language mappings.

## MCP

HTTP Streamable only. Built-in: context7, grep.app, exa. User servers in `.specra.json → mcp.servers`. Tool names: `mcp__{server}__{tool}`. Failed discovery = warning, not crash.

## Key Dependencies

`ai` v6 + `@ai-sdk/openai-compatible` (streamText), `hono` v4 (server), `react` 19 + `react-dom` + `react-router-dom` (Web UI), `vite` v6 + `@vitejs/plugin-react` + Tailwind (frontend build), `zustand` v5 (store), `zod` v4 (.strict()), `@modelcontextprotocol/sdk` (MCP), `vscode-jsonrpc` + `vscode-languageserver-protocol` (LSP), `jsdom` + `@mozilla/readability` + `turndown` + `@truto/turndown-plugin-gfm` (web_fetch).

## Conventions

- Talk in chinese, code in english (include comments).
- If you have any questions or choices, feel free to ask user.
- Use TDD development.
- **Prefer Bun-native APIs** over `node:*` imports. Use `crypto.randomUUID()`, `Bun.file()`, `Bun.write()`, `Bun.SystemError`, `import.meta.dir`. Only use `node:*` when Bun has no native alternative (e.g. `node:path` join/resolve, `node:os` tmpdir/homedir, `node:fs/promises` mkdir/rename/readdir/rm, `node:fs` sync methods).
- Custom error classes: extend `Error`, typed constructor params, explicit `this.name = "ClassName"`, meaningful public fields.
- Barrel exports via `index.ts`. All Zod schemas use `.strict()`.
- Test runner: `bun:test`. Import from `"bun:test"`. Use `mock()` not `jest.fn()`. Files: `<name>.test.ts` colocated. Temp dirs: `__test_tmp__/` cleaned in `afterAll`.
- Entry point: `src/main.ts` boots the headless Hono server. `package.json` bin → `./src/main.ts`.

## Testing Patterns

- Mock `streamText`: `__setStreamTextForTest(fn)` from `agents/query/loop.ts`
- Mock `generateText`: `__setGenerateTextForTest(fn)` from `llm/llm-object.ts`
- Mock LSP: `__setLspClientForTest`, `__setLspClientPoolForTest`, `__setLspTransportForTest` from respective modules
- Mock sessions dir: `__setSessionsDirForTest(dir)` from `store/sessions-dir.ts`
- Test stores: `createSessionStore(randomUUID())`. Empty registry: `createRegistry([])`
- Test error names, not just messages (all custom errors have `this.name`)
