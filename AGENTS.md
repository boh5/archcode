## Project

ArchCode is an open-source, self-hosted AI coding workbench. Users run it on a local machine or remote server, capture features, bugs, refactors, experiments, and other ideas as Project Todos, shape Ideas through dedicated Discussions, and start Ready or In Progress work as durable Sessions or Automations. A Goal is an optional persistent protocol on a root Lead Session, not a separate work item. ArchCode runs as a Hono server + React Web UI rather than a one-off CLI, with six Agent identities (Lead, Discussion, Analyst, Build, Explore, Librarian), three model Profiles (`principal`, `deep`, `fast`), workflow Skills, HITL/Automation primitives, structured tool execution, LSP integration, persistent memory, and context compaction.

## Monorepo Structure

Turborepo workspace with Bun. Five workspaces:

```
archcode/                        # Root workspace (bun@1.3.13)
├── apps/server/                 # @archcode/server  — Hono API/SSE server
├── apps/web/                    # @archcode/web     — Vite + React frontend
├── packages/agent-core/        # @archcode/agent-core — core agent logic
├── packages/protocol/           # @archcode/protocol — shared types (zero runtime deps)
├── packages/utils/              # @archcode/utils — shared utility helpers (zero runtime deps)
└── scripts/build.ts            # 3-phase production build pipeline
```

**Dependency graph:**
```
@archcode/server → @archcode/agent-core → @archcode/protocol
@archcode/server → @archcode/utils
@archcode/agent-core → @archcode/utils
@archcode/web → @archcode/protocol
```

Web does NOT depend on agent-core or server. Architecture tests in `__arch__/` enforce these boundaries.

## Runtime & Toolchain

- **Runtime**: Bun (not Node). Root commands use `bun run`; tests execute through Bun's `bun:test` runner via `bun run test`.
- **Package manager**: Bun (bun.lock present, not package-lock).
- **TypeScript**: strict mode, ES2022 target, bundler module resolution. Do NOT use `.js` extensions in imports.
- **Entry point**: `apps/server/src/main.ts` with `import.meta.main` guard; headless server boot, no terminal UI.

## Commands

```sh
bun run dev          # Turborepo: starts server + web in parallel
bun run build        # typecheck + Vite build + temporary production entry + Bun compile binary
bun run typecheck    # tsc --noEmit via Turborepo across all workspaces
bun run test         # bun:test via Turborepo across all workspaces (depends on ^typecheck)
bun run web:build    # Standalone: Vite build only (no full pipeline)
```

Per-package direct commands:
```sh
bun run --cwd apps/server dev      # Server with hot reload (bun --hot apps/server/src/main.ts)
bun run --cwd apps/web dev         # Vite dev server on :5173, proxies /api → :4096
bun run --cwd apps/web build       # Vite production build → apps/web/dist/
bun run --cwd packages/agent-core test:unit         # Unit tests, file-parallel with 4 isolated workers
bun run --cwd packages/agent-core test:integration  # Real process/Git/LSP integration tests, isolated and serial
bun run --cwd packages/agent-core test:arch         # Architecture contracts, isolated and serial
```

Validation order: `typecheck` → `test` (enforced by Turborepo task graph).

Agent Core test lanes are hard-separated by naming: `*.integration.test.ts` owns real subprocess, Git/worktree, and LSP process lifecycles; `src/__arch__/**/*.test.ts` owns architecture contracts; all remaining `*.test.ts` files are unit tests. Do not use `test.concurrent`, `--concurrent`, test-runner retries, or retry-based flaky-test mitigation.

## UI/UX Pro Max Workflow

Use the `ui-ux-pro-max` Skill for work that changes UI structure, visual
language, interaction, motion, responsive behavior, or accessibility.

The design-system working structure is:

```text
design-system/
├── MASTER.md
├── pages/
└── prototypes/
```

`MASTER.md` and `pages/` are normative design specifications.
`prototypes/` contains supporting visual references, not authoritative
specifications.

Follow this order for every UI task:

1. Read `design-system/MASTER.md`. It is the single global design baseline.
2. Read `design-system/pages/<page>.md` when it exists. Page files contain only
   explicit deviations from the Master and override it only for that page.
3. Inspect the current rendered product and implementation for established
   product behavior, state semantics, and component interactions.
4. Inspect the relevant current HTML prototype under
   `design-system/prototypes/` when one exists. Use it only as a supporting
   rendered reference.
5. UI/UX Pro Max is advisory, not authoritative. Use its searches as candidate
   evidence and filter recommendations through ArchCode's established quiet
   engineering workbench direction; never replace the Master with generic
   landing-page, purple AI-SaaS, glassmorphism, or decorative-motion output.
6. Record an approved cross-page rule in `MASTER.md`; record a page-only
   exception in `pages/<page>.md`; then synchronize the current prototype and
   product implementation as applicable.

Resolve conflicts as follows: a page override modifies `MASTER.md` only for
that page; the current product is authoritative for existing behavior and state
mechanics; an HTML prototype never overrides `MASTER.md`, a page override, or
current product behavior.

Create or update an HTML prototype only for a new complex module, a major
layout change, or an uncertain visual direction. Routine UI fixes and small
component changes do not require a prototype.

Keep one current effective HTML prototype per page, named
`design-system/prototypes/<page>.html`. Do not retain parallel `v2`, `final`,
`latest`, or dated variants. Keep only cross-page styles and behavior in
`design-system/prototypes/styles.css` and
`design-system/prototypes/app.js`. Put page-only CSS and JavaScript directly in
that page's HTML instead of creating page-specific `.css` or `.js` files.

The current references are:

- Dashboard: `design-system/prototypes/dashboard.html`
- Session: `design-system/prototypes/session.html`
- Todos: `design-system/prototypes/todos.html`

When browser QA needs an HTTP origin, serve the prototype root without first
changing into that directory:

```sh
python3 -m http.server 4181 \
  --bind 127.0.0.1 \
  --directory design-system/prototypes
```

Files under `docs/` are historical work records, not active design-system
artifacts. Preserve their original content and paths; an older prototype or
design reference there does not compete with the current prototype above.

## Architecture

```
apps/server/src/
├── main.ts                     # Boot entry: create Config service → ServerHost → listener
├── index.ts                     # Barrel: re-exports app, boot, error-handler, errors, listen, logger
├── app.ts                       # Runtime-backed route composition only
├── server-host.ts               # Single HTTP shell, bootstrap modes, Runtime lifecycle
├── server-auth-service.ts       # Password verification, bounded sessions, SSE revocation
├── setup-grant.ts               # Process-local one-time first-run capability
├── auth-http.ts                 # Cookie and same-origin HTTP adapters
├── boot.ts                      # Listener bootstrap + graceful shutdown on SIGINT/SIGTERM
├── ask-user-service.ts         # Deferred question request/response pattern
├── permission-service.ts       # Deferred permission request/response pattern
├── error-handler.ts            # Hono error handler
├── error.ts                    # Server-specific error classes
├── lifecycle.ts                # Server lifecycle events
├── listen.ts                   # Port binding (falls back to ephemeral if busy)
├── logger.ts                   # Request logger
├── resolve.ts                  # Request path resolution
├── validation.ts               # Hono validator + Zod → BadRequestError thin adapter
├── serve-web.ts                # Embedded web asset serving through an explicit asset-map input
├── routes/                     # Route modules: setup, auth, dashboard, directories, files,
│                               #   automations, global-events, hitl, mcp, messages,
│                               #   permissions, projects, questions, sessions, todos
└── events/                     # global-event-bus.ts

packages/agent-core/src/
├── runtime.ts                  # createRuntime(): config → providers → tools → MCP → session manager
├── index.ts                    # Public API exports
├── config/                     # Global config service, Zod schema (.strict()), MCP/GitHub env resolution
├── provider/                   # Provider instance creation and immutable model metadata
├── models/                     # ModelRuntime snapshots, selection resolution, and Execution-owned bindings
├── agents/definitions/         # AgentDefinition records for lead, analyst, build, explore, librarian
├── agents/factory.ts           # Agent creation and delegation through ConfiguredAgent
├── agents/configured-agent.ts  # Filtered tool set + own store per delegated agent
├── agents/session-agent-manager.ts  # Rebuildable per-Session Agent cache
├── agents/constants.ts         # AgentType/depth defaults + Skill/delegation capability packages only
├── agents/errors.ts            # NoModelsConfiguredError, AgentRunningError, SubAgentError, ConcurrentLimitError, DepthLimitError, etc.
├── agents/tool-filter.ts       # Definition-based tool filtering and delegation-depth enforcement
├── agents/tool-filter.test.ts  # Architecture coverage for definition-based capability filtering
├── agents/query/               # runLlmStream + tool execution cycle (max 50 steps), doom detection
├── agents/query/loop-hooks.ts  # 4 hook points: beforeModelBuild, beforeModelCall, afterStepEnd, afterLoopEnd
├── agents/query/hooks/         # auto-compact, auto-inject-reminder, title-generation, todo-continuation, memory-extraction, memory-consolidation
├── execution/session-execution-manager.ts # Sole logical Execution lifecycle/admission, run resources, abort, recovery, and terminal owner
├── process/                    # ProcessRunner lifecycle, bounded streaming, timeout/abort, and structured results
├── tools/define-tool.ts        # defineTool() → ToolDescriptor (strict RawToolResult + explicit outputPolicy)
├── tools/registry.ts           # admission/blocked handling and exactly-once Raw → Finalized finalization
├── tools/builtins/             # Base, delegation/resume, memory, Session Goal, and worktree tools
├── tools/github.ts             # Generic GitHub connector descriptors; not default agent tools
├── tools/hooks/                # File/workspace guards and raw-result hooks such as edit recovery
├── tools/permission/           # Tool access policy; Bash owns finite analysis -> deny/ask/default allow
├── tools/concurrency/          # partitionToolCalls(): groups concurrencySafe calls into parallel batches
├── tools/security/             # Secret detection plus finite Bash syntax/path analysis facts
├── tool-output/                # Finalizer, streaming redaction/capture, bounded artifacts, read/search authorization
├── tools/riipgrep/             # Ripgrep wrapper for search tools
├── core/                       # register-tools.ts: wires tools and finalized-result audit/logger hooks
├── store/                      # Zustand vanilla store: createSessionStore, StreamEvent reducer, ModelMessage projection, persist/load
├── background/                 # BackgroundTaskManager (fire-and-forget, dedup) + tasks: title-generation, memory-extraction, memory-consolidation
├── commands/                   # CommandRegistry + /compact command
├── compression/                # DCP-like dynamic range compression: model tool action, refs, block state, soft/strong nudges below hard threshold
├── compact/                    # Mandatory hard compact safety path at >=85% context pressure plus /compact command
├── memory/                     # MemoryFileManager (atomic writes, frontmatter, index), schemas, types, constants
├── session-goal/               # Session.goal schema, ownership service, status, budget, and usage
├── hitl/                       # Durable project-scoped approval/question queue and redacted display payloads
├── automations/                # Canonical Automation schemas, schedule, durable Invocation, Session dispatch
├── todos/                      # ProjectTodo schema, serialized state, and narrow Session-entry coordination
├── lsp/                        # LspClientPool (acquire/release, idle timeout, crash detection), StdioLspTransport, auto-installer, 18 language servers, 50+ ext mappings
├── llm/                        # Managed LLM runtime: runLlmStream/runLlmText/runLlmObject, retry/recovery, adapter test seam
├── projects/                   # ProjectRegistry + per-workspace HITL/memory/approval context resolver
├── prompt/                     # PromptContractCompiler V2: typed kernel/runtime/role/collaboration/context/overlay layers + trace/eval
├── mcp/                        # Built-in servers (context7, grep.app, exa) + HTTP discovery → ToolDescriptors
├── delegation/                 # Strict child Agent/Profile/Skill delegation contract
├── security/                   # 3 secret-detection regex patterns + containsSecretPattern()
└── utils/                      # Error utilities, frontmatter parse/format, safe-file operations

apps/web/src/
├── main.tsx                    # React entry point
├── App.tsx                     # Root component
├── router.tsx                  # React Router routes
├── api/                        # API client layer
├── components/                 # UI components
├── context/                    # React context providers
├── hooks/                      # Custom hooks
├── lib/                        # Utility library (includes SSE client)
├── routes/                     # Page route components
├── store/                      # Client-side Zustand stores
└── styles/                     # CSS/styles

packages/protocol/src/
├── index.ts                    # Barrel export
├── types.ts                    # SSE, session, todo, reminder, HITL, Automation types
├── automation.ts               # Cross-layer Automation limits
├── compression.ts              # Structured compression summary snapshot + renderer
├── guards.ts                   # Cross-layer StreamEvent/terminal-child guards
└── reduce.ts                   # Stream event reduction logic

packages/utils/src/
├── index.ts                    # Barrel export
├── format-time.ts              # Shared duration/time formatting helper
├── sort-json-value.ts          # Runtime-free stable JSON key ordering
└── *.test.ts                   # bun:test coverage for utility helpers
```

**Data flow:**
```
~/.archcode/config.json → startup activation or token-protected Setup
  → optional Session auth → providers → registerBuiltinTools → fire-and-forget MCP background load
  → Hono Runtime routes → Session-scoped Lead / Automation / HITL routes
  → SessionExecutionManager → ConfiguredAgent → query loop → store → SSE → Web UI

Delegation: `delegate(DelegationRequest)` creates a durable direct child; `resume_session` preserves its Agent, Profile, Skills, and responsibility. Every child finishes with a normal assistant response; synchronous delegation returns that final response directly, while background work is read through `background_output`. If a synchronous child suspends, its parent suspends on the original tool call; each resumes its own same logical Execution when ready. `SessionExecutionManager` is the sole owner of Execution lifecycle, admission, concurrency, live run resources, recovery, and terminal records. There is no Build owned-scope or lease subsystem.
```

**Server + Web UI:**
- `apps/server/src/main.ts` creates `ServerConfigService`, classifies Config state, and creates `ArchCodeServerHost`. Missing Config enters token-protected Setup without constructing an `AgentRuntime`.
- `apps/server/src/server-host.ts` owns the single HTTP shell, structured request logging controlled by `ARCHCODE_ACCESS_LOG`, bootstrap mode, Setup coordination, optional Session auth, Runtime activation, and optional Runtime shutdown. `apps/server/src/app.ts` composes Runtime-backed routes only.
- `apps/server/src/boot.ts` starts the Host on `ARCHCODE_PORT` (default `4096`) and wires graceful shutdown. Development mode is derived from the source/compiled runtime, never from authentication state.
- `apps/web/` is the React frontend. In development it runs through Vite (`bun run --cwd apps/web dev`); production uses `bun run build` and runs `dist/archcode` so Hono can serve API + UI from one port.

**Build pipeline** (`scripts/build.ts`):
1. `runWebBuild()` → Vite builds `apps/web/` to `apps/web/dist/`
2. `writeProductionEntrypoint()` → generates ignored `dist/.build/main.ts` with static file-loader imports for every Web asset
3. `compileBinary()` → `Bun.build()` compiles that temporary entrypoint, the Server, and the embedded Web assets into `dist/archcode` (minified, includes the css-tree patch plugin); the temporary entrypoint is removed in `finally`

**Multi-project model:**
- `packages/agent-core/src/projects/registry.ts` persists registered workspaces under `~/.archcode/projects/index.json`, validates absolute existing directories, derives stable slugs, and tracks open times.
- `packages/agent-core/src/projects/context-resolver.ts` creates per-workspace runtime context: durable HITL, project memory, approvals, and resource notifications. Automation state is owned by the Automation service.
- Ordinary Session routes create a `lead`. A root Lead Session may own one optional `Session.goal`; no Goal-specific Session, route family, or worktree exists. A Todo-originated root stores its immutable `{ todoId, entry }` source on the Session itself: `discussion` requires a root `discussion` Agent, while `work` and `automation` require a root `lead`.
- Web UI Add Project flow should register an existing workspace directory, then use project-scoped API routes (`/api/projects/:slug/...`) for sessions, files, automations, HITL, and events.

**Project `.archcode` layout** (per registered workspace root; user-global `~/.archcode` is unchanged):
```text
.archcode/
├── runtime/                         # system-managed authority state
│   ├── sessions/{id}/session.json
│   ├── hitl-queue.json
│   ├── permissions.json
│   ├── todos/state.json
│   ├── automations/state.json
│   ├── session-cwd-migrations/
│   └── memory/{index.md,preferences.md,knowledge/...}
├── plans/*.md                       # ordinary Markdown Plans (plan-work)
└── skills/**                        # project Skills
```
- Agent mutation tools hard-deny `.archcode/runtime/**`, mutations of ancestors that would affect that runtime tree, and `.git/**` (reads remain allowed). Direct mutations under `plans/` and `skills/` stay outside runtime and are not denied by that guard.
- System services persist under `runtime/` via their own writers (not agent mutation tools).

**SSE + Deferred pattern:**
- Session streaming lives in `apps/server/src/routes/events.ts`; clients connect to `/api/projects/:slug/sessions/:sessionId/events`.
- Event names are `stream`, `permission.request`, `question.request`, `heartbeat`, and shutdown-related lifecycle notifications. `stream` carries flattened store events such as text deltas, reasoning deltas, tool calls/results, compaction, steps, reminders, and todos.
- `EventRing` stores recent events and supports replay via `Last-Event-ID` or `lastEventId`; heartbeat emits every 15 seconds to keep connections alive.
- Cross-network confirmations use a deferred request/response pattern: `PermissionService.request()` pushes `permission.request` into the session ring and returns a Promise that resolves when `/api/permissions` responds; `AskUserService.request()` does the same with `question.request` and `/api/questions`.
- Abort signals and cleanup resolve pending confirmations safely (`timeout` for permissions, cancelled response for questions) so agent execution is not left hanging when a client disconnects or a job shuts down. A response is applied to its exact original Tool Batch call, then resumes the same logical Execution; it is never a terminal `waiting_for_human` Execution followed by a continuation Execution.

**Tool execution pipeline:**
```
partitionToolCalls → global permissions
  → tool permissions (workspace, protected/sensitive path, finite Bash policy)
  → before hooks → execute → raw after hooks (edit-error-recovery)
  → Registry → ToolOutputFinalizer → finalized audit → logger
```

Every descriptor declares an explicit `outputPolicy`. Registry is the sole Raw-to-Finalized conversion boundary: blocked requests produce no settled result, while settled and synthetic results are finalized exactly once. `ToolOutputFinalizer` owns redaction of output/details and streaming capture redacts before artifact persistence; model, Session/SSE/UI, audit, and logger consume only finalized data. Large one-shot output is recovered through authorized, bounded `output_read` and `output_search` pages rather than a full-output escape hatch.

**Config** (`~/.archcode/config.json`): server-wide `provider.<id>.{npm, name, options, models}` + strict `profiles.{principal,deep,fast}.{model,variant,options}` + optional `memory`, `integrations.github`, and `mcp.servers.<id>.{url, headers, timeout}`. Strict Zod. Provider values are literal; MCP URL/headers and GitHub token resolution retain their environment-variable behavior. Project directories are never searched for configuration.

**Model configuration** (`~/.archcode/config.json`):
- Provider ids and model ids combine as `provider:modelId` (example: `"local:glm-5"`). Do **not** use `provider/model`.
- All configured models use the same Prompt contracts. Provider and model differences stay in API call options rather than branching Prompt behavior.
- `provider.<id>.models.<modelId>.options` defines base AI SDK model-call options for that model. Use AI SDK camelCase names such as `maxOutputTokens`, `temperature`, `topP`, `topK`, `presencePenalty`, `frequencyPenalty`, `stopSequences`, `seed`, `timeout`, and `providerOptions`.
- `provider.<id>.models.<modelId>.variants.<variantName>` defines named option variants for the same model. A Profile or Session override may reference one; the variant name is consumed during resolution and never passed to the AI SDK call.
- `profiles.principal`, `profiles.deep`, and `profiles.fast` are all required, and unknown configuration keys fail strict validation.
- Profile-default merge order is shallow: model `options` → selected `variants[variant]` → Profile `options`. A user-facing root Session override resolves independently and never inherits principal Profile options.
- `providerOptions` follows the same shallow merge rule as one top-level key: later layers replace the whole `providerOptions` object rather than deep-merging nested provider settings.
- Unknown model ids, unknown variant names, and missing Profile config all fail fast with actionable errors.
- LLM execution is centralized in `packages/agent-core/src/llm/`. Non-LLM runtime code must not import `streamText` or `generateText` directly from `"ai"`; use `runLlmStream`, `runLlmText`, or `runLlmObject` instead.
- `maxRetries` is not a configuration field. Managed calls force AI SDK `maxRetries: 0` so ArchCode owns retry/recovery, including HTTP 200 stream-body EOF/truncated-SSE failures that AI SDK retries cannot recover.
- Retry constants are internal v1 implementation details. There is no global recovery retry config yet. Existing auto-compact behavior is preserved; emergency context-overflow compact automation is follow-up/out-of-scope.

Minimal example:
```json
{
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "local",
      "options": {
        "baseURL": "http://localhost:8090/v1",
        "apiKey": "local-dev-key"
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
  "profiles": {
    "principal": {
      "model": "local:glm-5",
      "variant": "deep",
      "options": { "temperature": 0.25 }
    },
    "deep": {
      "model": "local:glm-5",
      "variant": "deep",
      "options": { "temperature": 0.3 }
    },
    "fast": {
      "model": "local:glm-5",
      "variant": "fast",
      "options": { "temperature": 0.1 }
    }
  }
}
```

## Agent Architecture

| Agent | Profile | Notes |
|------|---------|-------|
| **Lead** (`"lead"`) | root default `principal` | Ordinary user-work entry and final technical owner. Works directly, delegates bounded work, owns Plan files, Goal/Automation requests, integration, verification, and delivery. |
| **Discussion** (`"discussion"`) | root default `principal` | Shapes one bound Todo and its optional Plan without implementing product work. May delegate evidence gathering to Explore/Librarian. |
| **Analyst** (`"analyst"`) | `deep` | Source-read-only architecture analysis, planning support, gap analysis, and independent review. May delegate evidence gathering to Explore/Librarian. |
| **Build** (`"build"`) | delegated `deep` or `fast` | Source writer with file write/edit, Bash, LSP, Git diff/status, and `ast_grep_replace`. May delegate local research to Explore. |
| **Explore** (`"explore"`) | `fast` | Terminal read-only local code search/LSP/Git/AST agent. |
| **Librarian** (`"librarian"`) | `fast` | Terminal read-only documentation/reference agent with local read/search, web_fetch, memory_read, and MCP docs/search tools. |

All six implement `Agent`: `store: StoreApi<SessionStoreState>`, `run(options) → AgentResult`; SessionExecutionManager commits input before invoking the Agent. Visual is documentation-only future scope and has no runtime identity.

**Delegation + tool filtering:**
- Tool sets are hardcoded by `AgentDefinition`; typed RoleContract and Prompt layers describe behavior but never change runtime permissions.
- Profiles route model resources only; Skills provide guidance only. Neither changes tools, delegation targets, or completion authority.
- `lead` uses `childPolicy.maxDepth = 3`; `discussion`, `analyst`, and `build` use `maxDepth = 2`. Discussion may delegate Explore/Librarian.
- Lead targets Analyst/Build/Explore/Librarian; Analyst targets Explore/Librarian; Build targets Explore.
- `explore` and `librarian` have no `delegateTargets`; they are terminal read-only support agents.
- `agents/factory.ts` resolves definition-based allowed tools and removes delegation capabilities at the runtime depth boundary; SessionExecutionManager enforces each role's child policy before child creation.
- `delegate` persists Agent, Profile, Skills, title, objective, and background choice. `resume_session` preserves that identity. Multiple Builds share general Session concurrency; there is no owned-scope or Build lease subsystem.

**Workflow Skills:**
- Ordinary root Lead activates `orchestrate-work`; active Goal activates `run-goal`; root Discussion activates `shape-todo`, derived from authoritative runtime facts on every Execution.
- `plan-work` writes one ordinary Markdown Plan per Todo under `.archcode/plans/`. Plan has no service, state, ID, API, dedicated page, or Goal link. `execute-plan` is activated only by the Todo-to-work handoff when that file exists.
- `review-work` guides Lead review orchestration. Analyst analysis/review Skills include `analyze-work`, `review-change`, and the reserved `goal-review` final gate.

**MCP visibility by agent:**

| Agent | MCP servers |
|-------|-------------|
| `lead` | `context7`, `exa` |
| `discussion` | — |
| `analyst` | `context7` |
| `build` | — |
| `explore` | — |
| `librarian` | `context7`, `grep.app`, `exa` |

**MCP tool resolution**: `AgentDefinition.mcpTools` lists MCP server names (e.g. `["context7", "exa"]`). `factoryResolveAllowedTools` merges matching `mcp__{server}__*` tools from the registry. MCP tools load in background; agents see them on the next `run()` call after registration. See MCP section below.

**Query loop lifecycle:**
```
beforeModelBuild (auto-compact) → toModelMessages → beforeModelCall (auto-inject-reminder)
  → runLlmStream → consumeFullStream → afterStepEnd (todo-continuation)
  → executeToolCalls (doom detection → partition → guards → execute)
→ afterLoopEnd (todo-continuation, memory-extraction, memory-consolidation)
```

## Tool System

**35+ builtin tools** (base tools via `createBuiltinToolDescriptors()`, memory, Goal, Automation, Project Todo, and GitHub connector tools — all registered in `core/register-tools.ts`):

| Category | Tools | Notes |
|----------|-------|-------|
| File I/O | file_read✅, file_write❌, file_edit❌ | Guards: workspace, sensitive-file, read-before-edit (edit), file-exists (write). After: read-snapshot (read), edit-error-recovery (edit) |
| Search / AST | grep✅, glob✅, ast_grep_search✅, ast_grep_replace❌ | Search tools are workspace-scoped. `ast_grep_replace` is destructive and preview-first. |
| Git / GitHub | git_status✅, git_diff✅, github_get_pull_request✅, github_list_pull_requests✅, github_get_pull_request_checks✅, github_list_issue_comments✅, github_create_issue_comment❌, github_list_workflow_runs✅, github_get_workflow_run✅, github_rerun_workflow_run❌ | GitHub connectors are registered globally but are not default agent tools. |
| Shell | bash❌✅destructive | Permission: finite path-aware Bash analysis, deterministic deny/ask, default allow |
| Interaction | ask_user✅❌not-concurrent, todo_write❌, project_todo_update❌ | ask_user serializes (interactive); `project_todo_update` derives its Todo from the current bound root Discussion and requires `expectedRevision` |
| Web | web_fetch✅ | — |
| LSP | lsp_diagnostics✅, lsp_goto_definition✅, lsp_find_references✅, lsp_symbols✅ | Guard: workspace |
| Delegation / Skills | delegate❌, resume_session❌, background_output✅, wait_for_reminder✅, cancel_session❌, skill_list✅, skill_read✅ | `delegate` accepts only strict `{ agent_type, profile, title, objective, skills, background }`; `resume_session` accepts only `{ session_id, instruction, background }`; delegated roles return ordinary final assistant text. Only Lead has family cancel. |
| Tool output recovery | output_read✅, output_search✅ | All agents may retrieve only authorized, bounded artifact pages or search results. |
| Memory | memory_read✅, memory_write❌ | memory_write rejects secrets |
| Goal / Automation creation | create_goal❌, get_goal✅, update_goal❌, automation_create❌ | Before a root Lead calls strict `create_goal({ objective })`, it uses ordinary `ask_user` and interprets the answer semantically. Goal creation never parses an initial budget from objective text; users control budget through the Session API/UI. Before completion, Lead uses a fresh direct deep Analyst with `goal-review`, interprets its ordinary report, and calls strict `update_goal({ status, reason })`; Runtime retains only active-family and instance/generation consistency checks. |

(✅ = readOnly, ❌ = not readOnly, ✅destructive = only destructive tool)

**Output finalization/hooks**: standard permissions run before execution. Tool-specific after hooks still operate on raw results; Registry then finalizes once through the Tool Output Plane. Redaction is owned by the Finalizer/capture boundary, and global finalized-result hooks are **audit → logger**.

**Core API**: `defineTool()` → `ToolDescriptor`. `ToolTraits: { readOnly, destructive, concurrencySafe }`. `partitionToolCalls()` groups concurrent-safe calls into parallel batches. Guards return `{ outcome: "allow" | "deny" | "ask" }`.

## Session Store

Zustand vanilla store per Agent Session. `append(StreamEvent)` → `reduceStreamEvent()` → `toModelMessages()`. Strict Session identity includes `agentName`, immutable resolved `profile`, `activeSkillNames`, root/parent ids, cwd, delegated identity, and, when present, an immutable `projectTodo` source; an optional `goal` belongs only to a root Lead Session. `projectTodo` is valid only on a user-facing root and records `{ todoId, entry }`, where entry is `discussion`, `work`, or `automation`; strict identity validation requires `discussion` entry ↔ Discussion Agent and `work`/`automation` entry ↔ Lead Agent. Active Skill bodies are resolved again for every Execution. Tool parts: `pending → running → completed | error`. `readSnapshots` (Map<path, mtime>) supports the edit guard. Reminders include todo continuation and child terminal notifications. Persisted under the project workspace at `.archcode/runtime/sessions/{id}/session.json`, validated by strict `SessionFileSchema` on load. `SessionExecutionManager` alone owns logical Execution start/suspend/resume/end, admission, live run resources, and recovery. Store load performs no lifecycle repair; it exposes only current-schema durable facts and reducer state.

## Context Compaction

ArchCode has two intentionally separate context-reduction paths. Dynamic DCP-like compression lives in `packages/agent-core/src/compression/`: it is an agent conversation/tool behavior where the model may call `compress` on visible `mNNNN`/`bN` refs, with soft/strong nudges injected from 55% up to the hard threshold. Forced hard compact lives in `packages/agent-core/src/compact/`: every agent's query hook runs this path at `contextTokens ≥ limit × 0.85`, and `/compact` enters through the ordinary checked Session message path before QueryLoop command parsing. Hard compact is the last safety mechanism to avoid context collapse, not a model-selected tool action: `selectCompactablePrefix` preserves the current + last 2 rounds, `pruneToolOutputs` persists outputs, `summarizePrefix` produces the compact summary, `commitCompact` emits a `compact` event, and DCP compression projection state is cleared so the two mechanisms do not layer over each other. Hysteresis remains ≥ 5 new messages and the circuit breaker opens after 3 failures/skips.

## Memory System

Project: `.archcode/runtime/memory/`, User: `~/.archcode/memory/` (user-global, not under project runtime). Structure: `index.md` (topic index), `preferences.md`, `knowledge/{topic}.md` (frontmatter + markdown). Types: `"user" | "feedback" | "project" | "reference"`. `MemoryFileManager`: atomic writes, path validation, frontmatter parse/format, index rebuild/search. Extraction (background task via `runLlmObject`) → writes topics. Consolidation (background task) → reorganizes index. Injection: ConfiguredAgent resolves one immutable Execution snapshot; PromptContractCompiler labels it non-authoritative and emits its source/status in the durable Prompt trace. `memory_write` rejects secrets.

## Session Goal System

`Session.goal` is an optional persistent status record for a root Lead Session. `packages/agent-core/src/session-goal/` owns its strict schema, user/Agent authority checks, objective, status, budget, usage, timestamps, and durable model-context notices. `create_goal` accepts only `{ objective }`; before calling it, Lead uses ordinary `ask_user` and interprets the answer semantically. Goal creation never derives an initial token budget from objective text; users set or change budget through the Session API/UI. Plan is independent and never referenced by Goal. Goal creation and semantic changes append a durable pending notice that becomes an ordered internal `goal-notice` Session message at the next safe model boundary; Goal content is never rebuilt dynamically from live state into the System Prompt. `run-goal` treats the latest Goal notice as the objective/status/blocked-reason authority, while `get_goal` supplies accounting only. While an active Goal family is idle and runnable, the server continues the same Lead without a Goal-specific workflow engine. Lead owns the work loop and final fix/review decisions. Before completion, Lead creates a fresh direct `analyst + deep + goal-review`, reads its ordinary evidence report, fixes material findings and reviews again, or calls `update_goal({ status: "complete", reason })` when it judges the Goal achieved. Runtime does not parse verdict text or persist Review provenance; it only rejects completion for a non-active Goal, an active child, or an instance/generation race. Goal owns neither a dedicated Session nor a worktree.

## Project Todos

Project Todos are project-owned intent, separate from Session-local `todo_write` execution checklists. Each Project opens its `/projects/:slug/todos` board by default, while `/projects/:slug` remains the Project Dashboard. `ProjectTodoStateManager` owns strict Todo persistence, flat state updates (`idea`, `ready`, `in_progress`, `done`, `rejected`), archive state, revision checks, and the one canonical array order. `ProjectTodoService` is the only Todo application boundary: it exposes list/create/flat-update and creates a root Discussion Session for `discussion`, or a root Lead Session for `work` and `automation`. A Todo never points back to Sessions, Plans, or Automations.

A Todo can have any number of direct root Sessions. Each such root stores its immutable `{ todoId, entry }` source; children never copy it. `discussion` roots activate `shape-todo`, may update only their source Todo, and may delegate only Explore/Librarian. **Generate / Improve Plan** reuses the latest Discussion only when it is idle, then invokes `plan-work` for the unique `.archcode/plans/<todo-id>.md`. If no Discussion exists, the latest one is busy or suspended, it was deleted, or an idle reuse loses the acceptance race, the action creates a new Discussion whose first accepted message is the Plan request; it never races a generic Discussion start with a second command. No Plan existence is stored or exposed through Todo APIs. `work` and `automation` roots may start only from Ready or In Progress. At work creation only, `ProjectTodoService` checks that Plan path: an existing file starts with `execute-plan`, while no file preserves ordinary implementation behavior. Starting from Ready moves the Todo to In Progress, while starting from In Progress leaves it there. Creating an Automation copies the source `todoId` into the Automation's own optional `projectTodoId`; Automation Invocation Sessions are not direct Todo relations. Todo moves never create, stop, rebind, or delete Sessions or Automations.

## HITL

HITL is a durable project-scoped approval/question queue backed by `.archcode/runtime/hitl-queue.json`. Server and Web routes expose redacted `displayPayload` data for approval/dashboard views; raw sensitive payloads must not be rendered or persisted in UI state. Deferred permission/question flows resolve safely on timeout, cancellation, or shutdown so long-running agent execution is not left hanging.

## Automation System

`packages/agent-core/src/automations/` owns schedule calculation, durable Invocation persistence, and dispatch to the ordinary Session API. After the user confirms the creation summary, a root Lead Session calls `automation_create` and commits the Automation through the existing scheduler/state path; Discussion does not expose that capability. When the creating root has a Todo source, the new Automation copies its `todoId` into its own `projectTodoId`; Invocation Sessions do not inherit that source. An Automation has exactly one `once`, `interval`, or `cron + timezone` trigger and one action: create an ordinary Lead Session or send a message to an existing Session. Session execution, Agent behavior, permissions, HITL, Session Goal state, and worktree lifecycle remain outside Automation.

## LSP Integration

`LspClientPool` (acquire/release, 5min idle timeout, crash loop detection). `LspClient` (Content-Modified retry 3x). `StdioLspTransport` (Bun.spawn + vscode-jsonrpc). Auto-install: `resolveServerBinary` → PATH → npm install -g → `~/.cache/archcode/lsp-servers/`. 18 built-in servers, 50+ ext→language mappings.

## MCP

HTTP Streamable only. Built-in: context7, grep.app, exa (hardcoded in `BUILTIN_MCP_SERVERS` and non-overridable). User servers are read from `~/.archcode/config.json → mcp.servers`. Tool names: `mcp__{server}__{tool}`. Failed discovery = warning, not crash.

**Background loading** (non-blocking): `McpManager.startBackgroundDiscovery()` fires-and-forgets at `createRuntime()` — server boots immediately while MCP servers connect in background. Per-server status: `pending → ready(toolCount, warningCount) | failed`; Prompt projection distinguishes `ready`, `ready-zero`, and `partial-warning`. Status is accessible via `AgentRuntime.getMcpServerStatuses()` and `AgentRuntime.subscribeMcpStatusChanges(listener)`.

**Agent visibility**: agents opt into MCP tools via `mcpTools: ["context7", "exa"]` (server names) in their `AgentDefinition`. `factoryResolveAllowedTools` merges `mcp__{server}__*` tools from `ToolRegistry.listByPrefix()` — picks up tools registered after background load completes. Tools become visible on the next `run()` call (per-message resolution at `ConfiguredAgent.run()` line 189), not mid-message.

**SSE bridge**: MCP status changes emit `GlobalSSEMcpStatusEvent` (`type: "mcp_status"`) via `globalEventBus` → Web `useMcpStatusStore`. API route: `GET /api/mcp/status` (global, not project-scoped). Web `GlobalSSEProvider` fetches the snapshot on mount and on SSE `reset` events (reconnect) to populate the store even when connecting after MCP servers became ready.

## Key Dependencies

- `@archcode/agent-core`: `ai` v6 + the 24 statically supported official AI SDK language Provider packages (including `@ai-sdk/openai-compatible`), `@modelcontextprotocol/sdk`, `zustand` v5, `zod` v4 (.strict()), `vscode-jsonrpc` + `vscode-languageserver-protocol` (LSP), `jsdom` + `@mozilla/readability` + `turndown` + `@truto/turndown-plugin-gfm` (web_fetch)
- `@archcode/server`: `hono` v4 (HTTP/SSE), `zustand` v5, `zod` v4, `fuzzysort`
- `@archcode/web`: `react` 19 + `react-dom` + `react-router-dom` v7, `@tanstack/react-query`, `zustand` v5, `@radix-ui/*`, `streamdown`, `eventsource-parser`
- `@archcode/protocol`: zero runtime deps
- `@archcode/utils`: zero runtime deps
- Build: `vite` v6 + `@vitejs/plugin-react` + Tailwind v4 (`@tailwindcss/vite`), `typescript` v6, `turbo` v2

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ARCHCODE_PORT` | `4096` | Hono server port (falls back to ephemeral if busy) |
| `ARCHCODE_LOG_LEVEL` | `info` | Minimum structured log level: `debug`, `info`, `warn`, or `error` |
| `ARCHCODE_ACCESS_LOG` | `on` | Enables (`on`) or disables (`off`) HTTP access logs independently |
| `ARCHCODE_HOST` | unset | Externally advertised host |
| `ARCHCODE_OPEN_BROWSER` | unset | Auto-open Web UI on boot (reserved) |
| `ARCHCODE_PROJECTS_DIR` | unset | Base directory for project selection flows |
| `GITHUB_TOKEN` | unset | Fallback token for GitHub.com integration when `integrations.github` is present and `tokenEnv` is unset or unresolved |
| `GH_TOKEN` | unset | Second fallback token for GitHub.com integration. `GITHUB_TOKEN` wins when both are set |

## Conventions

- Talk in chinese, code in english (include comments).
- If you have any questions or choices, feel free to ask user.
- Use TDD development.
- **When modifying the global config schema or defaults, must also update README.md config docs.**
- **Prefer Bun-native APIs** over `node:*` imports. Use `crypto.randomUUID()`, `Bun.file()`, `Bun.write()`, `Bun.SystemError`, `import.meta.dir`. Only use `node:*` when Bun has no native alternative (e.g. `node:path` join/resolve, `node:os` tmpdir/homedir, `node:fs/promises` mkdir/rename/readdir/rm, `node:fs` sync methods).
- Custom error classes: extend `Error`, typed constructor params, explicit `this.name = "ClassName"`, meaningful public fields.
- Barrel exports via `index.ts`. All Zod schemas use `.strict()`.
- Test runner: `bun:test`. Import from `"bun:test"`. Use `mock()` not `jest.fn()`. Files: `<name>.test.ts` colocated. Temp dirs: `__test_tmp__/` cleaned in `afterAll`.
- Entry point: `apps/server/src/main.ts` boots the headless Hono server. `package.json` bin → `./apps/server/src/main.ts`.

## Repository GitHub Workflow

- `main` is protected and accepts changes through pull requests only. Never commit or push directly to `main`.
- Start repository work from the latest `origin/main` on a focused feature branch. Branch creation, commit, push, opening or marking a PR ready, and merge are distinct state-changing actions: perform only the actions the user requested, unless they explicitly requested the complete end-to-end PR lifecycle, and report each completed state precisely.
- Before opening a PR, inspect the staged scope and run the relevant local validation documented in `CONTRIBUTING.md`, including `git diff --check`. Open a ready PR against `main` and complete the repository PR template when the change is ready for review.
- The required GitHub gates are the `Verify` status check and the CodeQL code-scanning policy. `Verify` installs with the frozen lockfile, typechecks, runs tests with diagnostics, builds the production binary, and smoke-tests that binary.
- CodeRabbit and Cubic provide automatic advisory review on ready PRs and incremental pushes. After every pushed change, wait for checks and reviews on the new head SHA, inspect review conversations again, address or explain actionable findings, rerun relevant validation, and repeat until the latest head is clear. A pending AI reviewer is neither a failure nor permission to merge.
- Immediately before merge, record the current head SHA and confirm that it is still the reviewed head, the PR is mergeable, `Verify` and CodeQL pass, every review conversation is resolved, and the user has authorized the merge. Merge with squash only. Do not bypass repository rules, force-push shared branches, or weaken required checks to unblock a change.
- After merge, fetch the remote, switch to local `main`, fast-forward it with `git merge --ff-only origin/main`, and verify that local `main` matches `origin/main` with a clean worktree. Report the merge commit and synchronized state separately from PR creation.
- Release work follows the same PR loop, then verifies that the release tag points to the exact merged commit, the release workflow succeeds, the public Release and expected assets exist, and local `main` is synchronized. A green PR or a pushed tag alone is not a completed release.

## Testing Patterns

- Mock LLM calls through `setLlmAdapterForTest()` from `packages/agent-core/src/llm`; do not reintroduce `__setStreamTextForTest`, `__setGenerateTextForTest`, or public `llmObject()` aliases.
- Mock LSP: `__setLspClientForTest`, `__setLspClientPoolForTest`, `__setLspTransportForTest` from `packages/agent-core/src/lsp/` respective modules
- Mock sessions dir: `__setSessionsDirForTest(dir)` from `packages/agent-core/src/store/sessions-dir.ts`
- Test stores: `createSessionStore(randomUUID())`. Empty registry: `createRegistry([])`
- Test project context: `createTestProjectContext(workspaceRoot)` from `packages/agent-core/src/tools/test-project-context.ts`
- Server HTTP tests: Hono's `app.request("/api/health")` pattern
- Test error names, not just messages (all custom errors have `this.name`)
- Architecture tests in `packages/agent-core/src/__arch__/`: enforce monorepo boundary rules and no `process.cwd()` in production code
