## Project

ArchCode is an open-source, self-hosted AI coding workbench. Users run it on a local machine or remote server, capture features, bugs, refactors, experiments, and other ideas as Project Todos, shape Ideas through dedicated Discussions, and start Ready or In Progress work as durable Sessions or Automations. A Goal is an optional persistent protocol on a root Lead Session, not a separate work item. ArchCode runs as a Hono server + React Web UI rather than a one-off CLI, with six Agent identities (Lead, Discussion, Analyst, Build, Explore, Librarian), three model Profiles (`principal`, `deep`, `fast`), workflow Skills, HITL/Automation primitives, structured tool execution, LSP integration, persistent memory, and context compaction.

## Working Scope and Completion

- Follow the user's requested scope. For consultation, read-only audits, or documentation work, inspect only the material needed for that task; do not turn it into a business-code review or implementation task.
- Read relevant instructions and references on demand. Do not load every directory, design document, or Skill before a small change.
- Continue authorized investigation, implementation, fixes, and verification through a concrete result. Resolve routine choices from the request and available evidence; do not ask the user to reconfirm work they already authorized.
- Ask when a material product decision, missing essential information, new authority, or scope change prevents progress. Honor explicit instructions to present a plan and wait before editing.
- Apply UI, testing, PR, merge, and release workflows only to the corresponding work. Report what changed, the validation performed, and any remaining limitation; do not claim completion without the required evidence.
- The Agent identities, tools, Skills, and lifecycle rules below describe ArchCode's product runtime. They do not redefine the capabilities or authorization of the coding assistant working on this repository.

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

## Installed Third-Party Skills

- `.codex/skills/**` contains installed upstream packages. Do not rewrite their instructions, descriptions, scripts, examples, or references for this project, including to satisfy a review finding.
- When an update is requested, verify the upstream source and revision, stage the complete official package or official installer output, compare it with the installed package, and synchronize only confirmed upstream changes. Preserve upstream contents without local patches; verify the resulting files against the staged package.
- Report upstream defects or conflicts as upstream issues. Put necessary project-specific usage constraints in this file, not inside third-party packages.
- Keep packages under the existing `.codex/skills/` root. Resolve example script/resource paths from the actual installed package directory; upstream examples may use `.agents/skills/` or `.claude/skills/`. Do not create duplicate installations just to match an example path.
- Marketing packages come from `coreyhaines31/marketingskills`, under `skills/` (last synchronized commit: `5b2c0007766c6a1cf1d53fd8fc73e979e0821022`).
- `banner-design`, `brand`, `design`, `design-system`, `slides`, `ui-styling`, and `ui-ux-pro-max` come from `nextlevelbuilder/ui-ux-pro-max-skill`. Use its official CLI Codex generator (last synchronized source commit: `f3ac195224eac1eb0dfe1a3059c2a6add78ffbe3`).

## AI Review Triage

- Treat every AI Reviewer finding as a hypothesis, not as authority. Verify it
  against the implementation, a concrete reproduction, and the authoritative
  product/design contracts before changing code.
- Fix only confirmed defects in repository-owned code. If a finding is a false
  positive or conflicts with an explicit contract, reply with the evidence and
  reject it instead of changing correct behavior merely to satisfy the Reviewer.
- A review finding does not authorize scope expansion, speculative hardening,
  or a new compatibility path. Any materially different product decision must
  return to the user; otherwise use the smallest fix that closes the reproduced
  defect.

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

`MASTER.md` and `pages/` define approved product and interaction contracts.
For a page with a current effective prototype, that prototype's actual browser
render is the visual delivery and visual acceptance authority. Source code,
tokens, DOM inspection, screenshots inferred from CSS, or prose specifications
cannot substitute for looking at the rendered prototype and rendered product.

For UI work within the authorized scope:

1. Read `design-system/MASTER.md`. It is the single global design baseline.
2. Read `design-system/pages/<page>.md` when it exists. Page files contain only
   explicit deviations from the Master and override it only for that page.
3. Inspect the current rendered product and implementation for established
   product behavior, state semantics, and component interactions.
4. Open the relevant current HTML prototype under `design-system/prototypes/`
   in a real browser when one exists. Use its actual rendered visual result as
   the target for layout, density, typography, color, responsive behavior, and
   interaction presentation; never claim visual completion from file or code
   inspection alone.
5. UI/UX Pro Max is advisory, not authoritative. Use its searches as candidate
   evidence and filter recommendations through ArchCode's established quiet
   engineering workbench direction; never replace the Master with generic
   landing-page, purple AI-SaaS, glassmorphism, or decorative-motion output.
6. Record an approved cross-page rule in `MASTER.md`; record a page-only
   exception in `pages/<page>.md`; then synchronize the current prototype and
   product implementation as applicable.

Resolve conflicts as follows: a page override modifies `MASTER.md` only for
that page; the current product is authoritative for existing runtime facts,
domain state, persistence, and behavior that an approved design decision does
not intentionally change. The current prototype is authoritative for visual
delivery, while `MASTER.md` and page overrides define the product/interaction
rules that the visual must satisfy. A prototype never invents product
capability: if it visibly implies behavior the product does not have, classify
the mismatch before implementation. Fix an obvious prototype defect in the
prototype; escalate a genuine product decision to the user. Only explicitly
approved hard-cut decisions may remove or change existing product behavior.

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

- Root no-project entry: `design-system/prototypes/index.html`
- Todos: `design-system/prototypes/todos.html`
- Automations: `design-system/prototypes/automations.html`
- Sessions: `design-system/prototypes/sessions.html`
- Session detail: `design-system/prototypes/session.html`

There is no Dashboard prototype. The root entry is only the zero-project
registration state; with a current/last project, `/` resolves to that project's
All todos surface as specified by `design-system/pages/root.md`.

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

## Runtime Architecture Contracts

Read only the modules relevant to the task: `apps/server/` owns HTTP/bootstrap; `packages/agent-core/` owns runtime services; `apps/web/` owns the client; `packages/protocol/` and `packages/utils/` remain runtime-dependency-free. Detailed file inventories, dependency versions, and configuration examples should be looked up when needed rather than duplicated here.

**Data flow:**
```
~/.archcode/config.json → startup activation or token-protected Setup
  → optional Session auth → providers → registerBuiltinTools → live MCP runtime activation
  → Hono Runtime routes → Session-scoped Lead / Automation / HITL routes
  → SessionExecutionManager → ConfiguredAgent authorized catalog
  → Core + State + Execution-loaded visibility → query loop → store → SSE → Web UI
```

`SessionExecutionManager` is the sole owner of logical Execution lifecycle, admission, concurrency, live run resources, abort, recovery, terminal validation, and terminal records. Store loading does not repair lifecycle state. There is no Build owned-scope or lease subsystem.

A delegated child may publish `completed` only with a non-blank canonical `final_answer` that is not a whole-response Tool-control document. The centralized gate runs before `execution-end`; its stable failure is shared by Execution, child link, parent Tool result, background output, and reminder. Synchronous delegation returns the accepted final response; background work is read through `background_output`. When a synchronous child suspends, the parent suspends on the original tool call; each later resumes its own same logical Execution.

**Server + Web UI:**
- `apps/server/src/main.ts` creates `ServerConfigService`, classifies Config state, and creates `ArchCodeServerHost`. Missing Config enters token-protected Setup without constructing an `AgentRuntime`.
- `apps/server/src/server-host.ts` owns the single HTTP shell, structured request logging controlled by `ARCHCODE_ACCESS_LOG`, bootstrap mode, Setup coordination, optional Session auth, Runtime activation, and optional Runtime shutdown. `apps/server/src/app.ts` composes Runtime-backed routes only.
- `apps/server/src/boot.ts` starts the Host on `ARCHCODE_PORT` (default `4096`) and wires graceful shutdown. Development mode is derived from the source/compiled runtime, never from authentication state.
- `apps/web/` is the React frontend. In development it runs through Vite (`bun run --cwd apps/web dev`); production uses `bun run build` and runs `dist/archcode` so Hono can serve API + UI from one port.

**Production build:** `scripts/build.ts` builds the Web assets, generates ignored `dist/.build/main.ts` with static asset imports, and compiles the Server and assets into `dist/archcode` with the css-tree patch plugin. The temporary entrypoint is removed in `finally`.

**Multi-project model:**
- `packages/agent-core/src/projects/registry.ts` persists registered workspaces under `~/.archcode/projects/index.json`, validates absolute existing directories, derives stable slugs, and tracks open times.
- `packages/agent-core/src/projects/context-resolver.ts` creates per-workspace runtime context: durable HITL, project memory, approvals, and resource notifications. Automation state is owned by the Automation service.
- Ordinary Session routes create a `lead`. A root Lead Session may own one optional `Session.goal`; no Goal-specific Session, route family, or worktree exists. A Todo-originated root stores its immutable `{ todoId, entry }` source on the Session itself: `discussion` requires a root `discussion` Agent, while `work` and `automation` require a root `lead`.
- Web UI Add Project flow should register an existing workspace directory, then use project-scoped API routes (`/api/projects/:slug/...`) for sessions, files, automations, HITL, and events.

**Workspace storage:** `.archcode/runtime/` holds system-managed Sessions, attachments, HITL, permissions, Todos, Automations, cwd migrations, and project memory. `.archcode/plans/*.md` and `.archcode/skills/**` are ordinary project files; user-global `~/.archcode` is unchanged. Agent mutation tools hard-deny `.archcode/runtime/**`, mutations of ancestors affecting that tree, and `.git/**`; reads remain allowed. System services use their own runtime writers. Plans and Skills remain outside that guard.

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

Model-visible tools are a projection, never an authorization source. Each
`AgentDefinition` declares `tools.authorized` and its strict `tools.core`
subset. `ConfiguredAgent` rebuilds the live authorized catalog at every model
boundary, then exposes Core, fixed runtime State activations, valid
Execution-local loaded refs, and `tool_search` only while deferred candidates
exist. It also rebuilds Current Context from complete Session Todos plus latest
direct-child facts as deterministic JSON. Completeness is enforced at writes,
not by Prompt truncation: one Session holds at most 32 Todos and 24 KiB of
serialized Todo JSON, while one parent owns at most 64 unique direct children.
Direct-child IDs are Runtime-generated, Agent names use the four delegated
identities, child Profiles and statuses use fixed enums, and titles are
non-blank and at most 80 Unicode code points. These existing write domains give
the projection a deterministic finite bound without extra per-field limits or
a second aggregate admission state.
Ordinary and explicit Skill packages
remain immutable for the logical Execution, while only the root Lead lifecycle
slot is reselected at each boundary (`orchestrate-work` without an active Goal,
`run-goal` with one). Local long-tail and all ready MCP descriptors remain deferred until a
deterministic local search loads their contract for the next model step. The
Prompt lists every deferred canonical name with only the first description
line, capped at 160 characters, grouped by local namespace or MCP server. Models
prefer `select:<exact-name>`; only a query without that prefix uses the local
BM25/trigram ranking. Search never calls another model, never grants permission,
and never falls back from an exact miss to ranking or to an eager/load-all
surface. New Execution writes always include their tool-authorization snapshot
and loaded refs. Persisted records that predate those fields read with
`{ extraTools: [], toolProjection: null }` and `[]`; values that are present but
malformed remain invalid. No data-format version or migration framework is
introduced for this additive read boundary.

**Config:** Only server-wide `~/.archcode/config.json` is authoritative; never search project directories for configuration. It contains Providers, required `principal`/`deep`/`fast` Profiles, and optional memory, GitHub integration, and MCP settings. Provider values are literal; MCP URL/header/STDIO environment values and GitHub token resolution retain environment-variable behavior. MCP transport rules are below.

**Model configuration** (`~/.archcode/config.json`):
- Provider ids and model ids combine as `provider:modelId` (example: `"local:glm-5"`). Do **not** use `provider/model`.
- All configured models use the same Prompt contracts. Provider and model differences stay in API call options rather than branching Prompt behavior.
- `provider.<id>.models.<modelId>.options` defines base AI SDK model-call options. Use AI SDK camelCase names.
- `provider.<id>.models.<modelId>.variants.<variantName>` defines named option variants for the same model. A Profile or Session override may reference one; the variant name is consumed during resolution and never passed to the AI SDK call.
- `profiles.principal`, `profiles.deep`, and `profiles.fast` are all required, and unknown configuration keys fail strict validation.
- Profile-default merge order is shallow: model `options` → selected `variants[variant]` → Profile `options`. A user-facing root Session override resolves independently and never inherits principal Profile options.
- `providerOptions` follows the same shallow merge rule as one top-level key: later layers replace the whole `providerOptions` object rather than deep-merging nested provider settings.
- Missing required Profile config and unknown model ids are invalid. A Profile
  may retain a removed Variant name for repair: Settings presents it as
  attention and the runtime resolves that Profile through the selected Model's
  default options until repaired. An explicit invalid Session override falls
  back to its selected Profile; it never passes the unknown Variant downstream.
- LLM execution is centralized in `packages/agent-core/src/llm/`. Non-LLM runtime code must not import `streamText` or `generateText` directly from `"ai"`; use `runLlmStream`, `runLlmText`, or `runLlmObject` instead.
- `maxRetries` is not a configuration field. Managed calls force AI SDK `maxRetries: 0` so ArchCode owns retry/recovery, including HTTP 200 stream-body EOF/truncated-SSE failures that AI SDK retries cannot recover.
- Retry constants are internal v1 implementation details. There is no global recovery retry config yet. Existing auto-compact behavior is preserved; emergency context-overflow compact automation is follow-up/out-of-scope.

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
- Role authorization and Core sets are hardcoded by `AgentDefinition`; typed RoleContract, Prompt, State activation, loaded refs, and search results never expand runtime permissions.
- Profiles route model resources only; Skills provide guidance only. Neither changes tools, delegation targets, or completion authority.
- `DELEGATION_CONTROL_TOOLS` is the fixed seven-tool package: `delegate`, `list_agents`, `send_message`, `background_output`, `wait_for_reminder`, `cancel_session`, and `resume_session`. Lead, Discussion, Analyst, and Build explicitly spread this package in their own `AgentDefinition`; Explore and Librarian do not configure it.
- `lead` uses `childPolicy.maxDepth = 3`; `discussion`, `analyst`, and `build` use `maxDepth = 2`. Discussion may delegate Explore/Librarian.
- Lead targets Analyst/Build/Explore/Librarian; Analyst targets Explore/Librarian; Build targets Explore.
- `explore` and `librarian` have no `delegateTargets`; they are terminal read-only support agents.
- `agents/factory.ts` owns one immutable current-Agent/depth delegation capability snapshot and only removes the explicitly configured delegation package at each definition's `childPolicy.maxDepth` or when no direct target exists; it never injects delegation tools. `extraTools` cannot restore that removed package. Prompt/Tool projection and SessionExecutionManager admission consume that same target/Profile/builtin-Skill authority; Provider-facing Tool schemas remain portable presentation contracts while strict internal schemas still validate execution input.
- `list_agents` and the Web Agent Tree use one backend projection of durable family topology plus live Execution/Link facts. `send_message` targets only a running direct child and uses `steer | queue`; `cancel_session` accepts any descendant and strongly cascades its subtree, while `wait_for_reminder` and `resume_session` remain direct-child operations. `delegate` persists Agent, Profile, Skills, title, objective, and background choice; `resume_session` preserves that identity. A parent may own at most 64 unique direct children, while resuming an existing child consumes no new identity slot. Delegated titles are non-blank and at most 80 Unicode code points; direct-child Current Context accepts only delegated `analyst | build | explore | librarian`, `deep | fast`, and fixed link statuses. Session/Execution IDs remain Runtime-generated, and objective/Skills retain their existing Delegation contract rather than acquiring unrelated capacity rules. Execution admission and every model boundary fail closed on malformed projected state. Multiple Builds share general Session concurrency; there is no owned-scope or Build lease subsystem.

**Workflow Skills:**
- At every model boundary, an ordinary root Lead activates `orchestrate-work` and a root Lead with an active Goal activates `run-goal`; this reserved lifecycle slot is separate from immutable ordinary/explicit Execution Skill snapshots. Root Discussion activates `shape-todo` from its formal Session identity.
- `plan-work` writes one ordinary Markdown Plan per Todo under `.archcode/plans/`. Plan has no independent service, state, ID, API, dedicated page, or Goal link; the Todo Plan endpoint only reads the fixed file. `execute-plan` is activated only by the Todo-to-work handoff when that file exists.
- `review-work` guides Lead review orchestration. Analyst analysis/review Skills include `analyze-work`, `review-change`, and the reserved `goal-review` final gate.
- A Skill is one package: required `SKILL.md`; optional `scripts/`, `references/`, `assets/`, and other contained resources. Its strict YAML frontmatter accepts `name`, `description`, optional `license`, `compatibility`, and `metadata`; `description` states both method and activation timing.
- Skill precedence is whole-package and strict: project `.archcode/skills/<name>/` > project `.agents/skills/<name>/` > user `~/.archcode/skills/<name>/` > user `~/.agents/skills/<name>/` > embedded builtin. Bodies and resources never merge or fall through. Reserved lifecycle builtins remain unshadowable and Agent-gated.
- Discovery (`skill_list` and available Prompt metadata) returns exactly name, description, and source. Prompt projection is bounded and reports omitted entries; the first page is `skill_list({})` or `skill_list({ agent_type })`, and continuation copies only the preceding successful page's digest-bound `nextCursor`. `skill_list({ agent_type })` may inspect one currently allowed direct child's catalog for exact `delegate.skills` names, but that target page grants no parent `skill_read` authority. Entry activation first copies an exact current-Agent name from the System Prompt or a successful `skill_list({})` result into `skill_read({ name })`; descriptions never assume one fixed Skill is valid in every runtime. That entry returns sorted resource descriptors, after which `skill_read({ name, resource })` may copy and read exactly one listed UTF-8 relative resource path. Guessed root, entry, resource, and cursor values are invalid and errors return scope-preserving retry instructions. Binary assets are valid package resources but are not returned by the text-only tool.
- Invalid package candidates are surfaced as `SKILL_INVALID_PACKAGE` diagnostics. A winning invalid package fails closed; resolution never falls through to a lower-precedence package. The same winning package is claimed once for one explicit `/skill use` logical Execution; an in-process resume reuses that snapshot, while process-restart recovery revalidates its persisted source/digest and fails closed on change.
- Skills remain guidance only: their package metadata and resources cannot grant tools or permissions, execute scripts automatically, change Agent/Profile/MCP/workspace scope/delegation, or grant completion authority. Scripts use only existing Bash permissions.

**Query loop lifecycle:**
```
beforeModelBuild (auto-compact) → toModelMessages → beforeModelCall (auto-inject-reminder)
  → runLlmStream → consumeFullStream → afterStepEnd (todo-continuation)
  → executeToolCalls (partition → guards → execute → settle batch → repeated-failure gate)
→ afterLoopEnd (todo-continuation)
```

The repeated-failure gate reconstructs one logical Execution from canonical
Tool batches ordered by model step and call ordinal. It counts only a closed
allowlist of deterministic Tool error codes for the same canonical Tool input,
clears that input after success, and fails the Execution after the third real
error only after every sibling call in the triggering batch settles. Timeout,
network, process, permission, abort, unknown, and otherwise unlisted failures
fail open. There is no pre-execution synthetic Doom result or continuation path.

Successful root Lead/Discussion terminals update the durable Memory cursor;
`MemoryIdleCoordinator` performs automatic learning outside the Query Loop after
10 minutes of inactivity.

## Tool Contracts

- `defineTool()` produces a `ToolDescriptor` with explicit `outputPolicy` and `ToolTraits { readOnly, destructive, concurrencySafe }`. `partitionToolCalls()` batches only concurrency-safe calls. Guards return `allow | deny | ask`; `ask_user` is interactive and serial.
- Preserve workspace/sensitive-file checks, read-before-edit snapshots, and file-exists write guards. `pdf_read` uses exact-path read authorization; search, AST, and LSP remain workspace-scoped. `ast_grep_replace` requires a preview first. Bash uses finite path-aware deny/ask analysis with default allow.
- GitHub connectors are registered globally but are not default Agent tools. Tool visibility never grants permission.
- `project_todo_update` derives the source Todo from the bound root Discussion and requires `expectedRevision`. `memory_write` rejects secrets.
- Raw after hooks (including edit recovery) precede Registry finalization; finalized global hooks run audit, then logger. All Agents recover output only through authorized, bounded `output_read` / `output_search` results.

## Session Store

Zustand vanilla store per Agent Session. `append(StreamEvent)` → `reduceStreamEvent()` → `toModelMessages()`. Strict Session identity includes `agentName`, immutable resolved `profile`, `activeSkillNames`, root/parent ids, cwd, delegated identity, and exactly one immutable `RootSessionSource` on every root: `direct`, `todo { todoId, entry }`, or `automation { automationId, invocationId, todoId }`, where Automation `todoId` is nullable; children never copy a root source. An optional `goal` belongs only to a root Lead Session. Strict identity validation requires Todo `discussion` entry ↔ Discussion Agent and every other root source ↔ Lead Agent. Persistent active Skill names are resolved when a new logical Execution is claimed; that Execution then uses immutable package snapshots through suspension and resume. Tool parts: `pending → running → completed | error`. `readSnapshots` (Map<path, mtime>) supports the edit guard. Reminders include todo continuation and child terminal notifications. Persisted under the project workspace at `.archcode/runtime/sessions/{id}/session.json`, validated by strict `SessionFileSchema` on load. `SessionExecutionManager` alone owns logical Execution start/suspend/resume/end, admission, live run resources, and recovery. Store load performs no lifecycle repair; it exposes only current-schema durable facts and reducer state.

## Context Compaction

ArchCode has two intentionally separate context-reduction paths. Dynamic DCP-like compression lives in `packages/agent-core/src/compression/`: it is an agent conversation/tool behavior where the model may call `compress` on visible `mNNNN`/`bN` refs, with soft/strong nudges injected from 55% up to the hard threshold. Its only protected range facts are `latest_tail`, `pending_tool`, `running_tool`, `unknown_result`, and explicit `protect_tag`; settled child links, Session Todos, and Reminders remain canonical domain state but do not veto an unrelated old range. Current Todos/direct-child visibility is supplied by Current Context, the complete descendant tree remains in `list_agents`, and Reminder owners retain their own injection/consumption behavior. Forced hard compact lives in `packages/agent-core/src/compact/`: every agent's query hook runs this path at `contextTokens ≥ limit × 0.85`, and `/compact` enters through the ordinary checked Session message path before QueryLoop command parsing. Hard compact is the last safety mechanism to avoid context collapse, not a model-selected tool action: `selectCompactablePrefix` preserves the current + last 2 rounds, `pruneToolOutputs` persists outputs, `summarizePrefix` produces the compact summary, `commitCompact` emits a `compact` event, and DCP compression projection state is cleared so the two mechanisms do not layer over each other. Hysteresis remains ≥ 5 new messages and the circuit breaker opens after 3 failures/skips.

## Memory System

Project: `.archcode/runtime/memory/`, User: `~/.archcode/memory/` (user-global, not under project runtime). Structure: `index.md` (generated topic index), `preferences.md`, `knowledge/{topic}.md` (frontmatter + Markdown). Types: `"user" | "feedback" | "project" | "reference"`. `MemoryService` is the sole mutation boundary over `MemoryFileManager`: it owns CAS revisions, secret rejection, 8 KiB preferences, 16 KiB complete topic documents, the 200-topic cap, legacy shrink-only edits, index rebuilds, and deterministic receipt replay. Existing `memory_write` remains the immediate explicit-write path. Automatic learning is owned by the runtime-scoped `MemoryIdleCoordinator`: successful root Lead/Discussion conversations wait for 10 minutes of inactivity, then use at most one `fast` extraction call and one full-file reconciliation call; durable cursors, receipts, policy epochs, and warnings make restart and opt-out behavior explicit. Injection: ConfiguredAgent resolves one immutable Execution snapshot containing complete in-capacity preferences and project index; PromptContractCompiler labels it non-authoritative and emits its source/status in the durable Prompt trace.

## Session Goal System

`Session.goal` is an optional persistent status record for a root Lead Session. `packages/agent-core/src/session-goal/` owns its strict schema, user/Agent authority checks, objective, status, budget, usage, timestamps, and durable model-context notices. `create_goal` accepts only `{ objective }`; before calling it, Lead uses ordinary `ask_user` and interprets the answer semantically. Goal creation never derives an initial token budget from objective text; users set or change budget through the Session API/UI. Plan is independent and never referenced by Goal. Goal creation and semantic changes append a durable pending notice that becomes an ordered internal `goal-notice` Session message at the next safe model boundary; Goal content is never rebuilt dynamically from live state into the System Prompt. `run-goal` treats the latest Goal notice as the objective/status/blocked-reason authority, while `get_goal` supplies accounting only. While an active Goal family is idle and runnable, the server continues the same Lead without a Goal-specific workflow engine. Lead owns the work loop and final fix/review decisions. Before completion, Lead creates a fresh direct `analyst + deep + goal-review`, reads its ordinary evidence report, fixes material findings and reviews again, or calls `update_goal({ status: "complete", reason })` when it judges the Goal achieved. Runtime does not parse verdict text or persist Review provenance; it only rejects completion for a non-active Goal, an active child, or an instance/generation race. Goal owns neither a dedicated Session nor a worktree.

## Project Todos

Project Todos are project-owned intent, separate from Session-local `todo_write` execution checklists. Global `/` is only a registry-backed entry resolver: it replaces to the current/last valid project's `/projects/:slug/todos`, falls back to the first registered project in server order, or renders the sole no-project registration state. `ProjectLayout` owns the persistent Todo navigator, New Todo capture, and project-scoped Inspector; there is no aggregate Home and no `Todos / Automations / Sessions` project toolbar. `/projects/:slug` redirects to `/projects/:slug/todos`, while Runs and Schedules remain independently creatable and recoverable operational destinations inside the Todo workbench. `ProjectTodoStateManager` owns strict Todo persistence, flat state updates (`idea`, `ready`, `in_progress`, `done`, `rejected`), archive state, revision checks, the canonical array order, ordered current `attachmentIds`, and narrow durable Run-now receipts. `ProjectTodoService` is the only Todo application boundary: it exposes list/create/flat-update, attachment operations, the composed `Run now` command, and root Session creation for `discussion`, `work`, and `automation`. A Todo never stores reverse Session, Plan, or Automation links.

A Todo can have any number of root Sessions with immutable `{ kind: "todo", todoId, entry }` source. Each root family resolves the Todo's current attachment set at model and tool boundaries; references are never copied into Session messages or storage. `discussion` roots activate `shape-todo`, may update only their source Todo, and may delegate only Explore/Librarian. **Generate / Improve Plan** reuses the latest Discussion only when it is idle, then invokes `plan-work` for the unique `.archcode/plans/<todo-id>.md`. If no Discussion exists, the latest one is busy or suspended, it was deleted, or an idle reuse loses the acceptance race, the action creates a new Discussion whose first accepted message is the Plan request; it never races a generic Discussion start with a second command. Plan existence is not persisted; the Todo Plan endpoint only performs a fixed-path, bounded Markdown read. `work` and `automation` roots may start only from Ready or In Progress. At work creation only, `ProjectTodoService` checks that Plan path: an existing file starts with `execute-plan`, while no file preserves ordinary implementation behavior. Starting from Ready moves the Todo to In Progress, while starting from In Progress leaves it there. A Todo-created Automation stores immutable `{ kind: "todo", todoId, sessionId }` origin; every `start_session` Invocation persists `{ kind: "automation", automationId, invocationId, todoId }`. Direct-origin Invocations persist `todoId: null`. Todo moves never create, stop, rebind, or delete Sessions or Automations.

Todo lifecycle does not encode live Session activity. The Web navigator derives
a separate Running group only from eligible Todo-linked root family activity
`running | resuming | stopping`; Needs-you wins, Direct Sessions and
rejected/archived Todos are excluded, and the target is the newest
`session.updatedAt` with `sessionId` as the stable tie break. Running rows expose
`Working` to assistive technology instead of reusing a historical terminal
Session state. Todo labels are presentation-only: ignore fenced code, prefer a
concrete H1, then the first concrete line after the finite builtin-template or
standalone HTTP(S) skip set. Legal ATX closing hashes require preceding
whitespace, so a heading like `C#` keeps its content. `Untitled Todo` is the
only fallback. No title field is persisted.

## HITL

HITL is a durable project-scoped approval/question queue backed by `.archcode/runtime/hitl-queue.json`. Server and Web routes expose redacted `displayPayload` data for exact approval/question destinations and Todo navigator attention views; raw sensitive payloads must not be rendered or persisted in UI state. Deferred permission/question flows resolve safely on timeout, cancellation, or shutdown so long-running agent execution is not left hanging. In the Session UI, the latest HITL-paused Work and the pending Question/Permission card are independent disclosures: paused Work defaults open unless the user already chose for that Segment, while each pending request defaults open and preserves a route-lifetime manual choice by `hitlId`. An answered request whose response could not be delivered remains visible as an expanded `Inspection · Manual inspection` card, but it is not pending: it does not retain collapsed state, advertise `Needs you`, or block ordinary Composer input and pickers. Composer input remains mounted; request removal clears obsolete disclosure state, and layout changes keep only an existing follow-latest transcript pinned rather than moving a historical reading position.

## Automation System

`packages/agent-core/src/automations/` owns schedule calculation, durable Invocation persistence, and dispatch to the ordinary Session API. An Automation has exactly one immutable origin: `direct`, `session { sessionId }`, or `todo { todoId, sessionId }`. Automations UI creation is direct; a root Lead Session may call `automation_create`, with Runtime deriving the Session/Todo origin; Discussion does not expose that capability. An Automation has exactly one `once`, `interval`, or `cron + timezone` trigger and one action: create a root Lead Session with the principal Profile or send a message to an existing Session without changing its identity/source. A `start_session` Invocation persists its origin Todo ID, if any, on the Session so live Todo references remain resolvable even after the Automation is deleted. Session execution, Agent behavior, permissions, HITL, Session Goal state, and worktree lifecycle remain outside Automation.

## LSP Integration

`LspClientPool` (acquire/release, 5min idle timeout, crash loop detection). `LspClient` (Content-Modified retry 3x). `StdioLspTransport` (Bun.spawn + vscode-jsonrpc). Auto-install: `resolveServerBinary` → PATH → npm install -g → `~/.cache/archcode/lsp-servers/`. 18 built-in servers, 50+ ext→language mappings.

## MCP

MCP is a process-global live integration. `McpRuntimeService` is the high-
cohesion owner for resolved configuration, HTTP/STDIO transports, discovery,
tool inventory, status, Test, Reconnect, hot apply, and shutdown. It has no
Session, Execution, Agent, Tool Registry, permission, retry, or persistence
ownership. Tool names are `mcp__{server}__{tool}`; failed discovery is a
per-server warning/failure, not a Runtime crash.

User servers are configured at `~/.archcode/config.json → mcp.servers`. Every
entry requires `type` (`http` or `stdio`) and `enabled`. HTTP uses `url` and
optional `headers`; STDIO uses `command`, optional `args`, and optional `env`.
`connectTimeoutMs`, `discoveryTimeoutMs`, and `callTimeoutMs` default to
10,000/30,000/60,000 ms. `mcp.disabledBuiltins` can disable fixed built-ins
(`context7`, `grep.app`, `exa`) but cannot replace them.

Initial activation is non-blocking: the server publishes `connecting` or
`disabled` before transport work completes. Per-server status is
`disabled → connecting → ready(toolCount, warningCount) | failed`; Prompt
projection maps these to `disabled`, `connecting`, `ready`, `ready-zero`,
`partial-warning`, and `failed`. Status and inventory are available through the
global MCP routes and SSE status events; Settings also offers draft Test and
Reconnect. A Config save commits once, then hot-applies the resolved MCP config;
the independent `mcpApply` result reports whether live apply succeeded.

At each model-call boundary, `ConfiguredAgent` takes a transient live MCP tool
descriptor/status projection for that call. Tool execution uses those exact
descriptors; a later reconnect, disable, or discovery change affects the next
boundary, not a call already handed to the model. The projection exists only
for that model-call boundary.

All six Agent identities receive every configured user-server descriptor at
their next model-call boundary, with no role filter and no additional MCP
approval. Built-in visibility remains the locked role matrix:

| Agent | Built-in MCP servers |
|-------|----------------------|
| `lead` | `context7`, `exa` |
| `discussion` | — |
| `analyst` | `context7` |
| `build` | — |
| `explore` | — |
| `librarian` | `context7`, `grep.app`, `exa` |

The matrix applies only to built-ins. A local read-only Agent can still invoke
a user MCP tool that writes to an external system; local tool read-only status
does not constrain external MCP side effects.

MCP status changes emit `GlobalSSEMcpStatusEvent` (`type: "mcp_status"`) via
`globalEventBus` → Web `useMcpStatusStore`. API routes are global (not
project-scoped): `GET /api/mcp/status`, `GET /api/mcp/inventory`,
`POST /api/mcp/test/:serverName`, and `POST /api/mcp/reconnect/:serverName`.
Web `GlobalSSEProvider` fetches the status snapshot on mount and after an SSE
`reset` so late subscribers still see the current live state.

## Conventions

- Communicate in Chinese; write code and comments in English.
- **When modifying the global config schema or defaults, must also update README.md config docs.**
- **Prefer Bun-native APIs** over `node:*` imports. Use `crypto.randomUUID()`, `Bun.file()`, `Bun.write()`, `Bun.SystemError`, `import.meta.dir`. Only use `node:*` when Bun has no native alternative (e.g. `node:path` join/resolve, `node:os` tmpdir/homedir, `node:fs/promises` mkdir/rename/readdir/rm, `node:fs` sync methods).
- Custom error classes: extend `Error`, typed constructor params, explicit `this.name = "ClassName"`, meaningful public fields.
- Barrel exports via `index.ts`. All Zod schemas use `.strict()`.

## Repository GitHub Workflow

Apply these gates when the task includes the corresponding branch, commit, push, PR, merge, or release action. A consultation, read-only audit, or local documentation edit does not by itself authorize a PR or release.

- `main` is protected and accepts changes through pull requests only. Never commit or push directly to `main`.
- Start repository work from the latest canonical `main` (`origin/main` for collaborators, `upstream/main` for forks) on a focused feature branch. Branch creation, commit, push, opening or marking a PR ready, and merge are distinct state-changing actions: perform only the actions the user requested, unless they explicitly requested the complete end-to-end PR lifecycle, and report each completed state precisely.
- Before opening a PR, inspect the staged scope and run the relevant local validation documented in `CONTRIBUTING.md`, including `git diff --check origin/main...HEAD` (or `upstream/main...HEAD` for forks). Open a ready PR against `main` and complete the repository PR template when the change is ready for review.
- The required GitHub gates are the `Verify` status check and the CodeQL code-scanning policy. `Verify` installs with the frozen lockfile, typechecks, runs tests with diagnostics, builds the production binary, and smoke-tests that binary.
- CodeRabbit and Cubic provide automatic advisory review on ready PRs and incremental pushes. After every pushed change, wait for checks and reviews on the new head SHA, inspect review conversations again, address or explain actionable findings, rerun relevant validation, and repeat until the latest head is clear. A pending AI reviewer is neither a failure nor permission to merge.
- Immediately before merge, record the current head SHA and confirm that it is still the reviewed head, the PR is mergeable, `Verify` and CodeQL pass, every review conversation is resolved, and the user has authorized the merge. Merge with squash only. Do not bypass repository rules, force-push shared branches, or weaken required checks to unblock a change.
- After merge, fetch the canonical remote, switch to local `main`, fast-forward it from that remote's `main`, and verify that both refs match with a clean worktree. Report the merge commit and synchronized state separately from PR creation.
- Release work follows the same PR loop, then verifies that the release tag points to the exact merged commit, the release workflow succeeds, the public Release and expected assets exist, and local `main` is synchronized. A green PR or a pushed tag alone is not a completed release.

## Validation and Testing

- Choose validation by changed behavior and risk. For a bug fix, prefer a regression test that demonstrates the defect. For behavior changes, cover meaningful contracts and failure cases; do not add tests that merely restate implementation details.
- Documentation, static assets, and upstream Skill synchronization usually need scope/diff checks, format/resource checks, and upstream equality checks as applicable. Do not run unrelated business-code suites for these changes.
- For code changes, run the relevant lanes and the checks required by `CONTRIBUTING.md` when preparing a PR. Preserve `typecheck` → `test` order. Once relevant checks pass, repeat or broaden them only for new changes, failures, or a specific unresolved concern.
- Use `bun:test` and `mock()` (not `jest.fn()`). Colocate `<name>.test.ts`; clean `__test_tmp__/` in `afterAll`. Preserve the isolated unit/integration/architecture lanes described under Commands; do not mask flakes with concurrency or retries.

Use these existing test seams when the task touches their subsystem:

- Mock LLM calls through `setLlmAdapterForTest()` from `packages/agent-core/src/llm`; do not reintroduce `__setStreamTextForTest`, `__setGenerateTextForTest`, or public `llmObject()` aliases.
- Mock LSP: `__setLspClientForTest`, `__setLspClientPoolForTest`, `__setLspTransportForTest` from `packages/agent-core/src/lsp/` respective modules
- Mock sessions dir: `__setSessionsDirForTest(dir)` from `packages/agent-core/src/store/sessions-dir.ts`
- Test stores: `createSessionStore(randomUUID())`. Empty registry: `createRegistry([])`
- Test project context: `createTestProjectContext(workspaceRoot)` from `packages/agent-core/src/tools/test-project-context.ts`
- Server HTTP tests: Hono's `app.request("/api/health")` pattern
- Test error names, not just messages (all custom errors have `this.name`)
- Architecture tests in `packages/agent-core/src/__arch__/`: enforce monorepo boundary rules and no `process.cwd()` in production code
