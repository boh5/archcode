# Architecture Decision Record

> **Purpose:** Document monorepo package boundaries, dependency direction, forbidden imports, production binary strategy, and escalation rules for future maintainers.
>
> **Context:** This ADR captures decisions made during the monorepo migration from a flat `src/` layout to a workspace-based structure with `apps/` and `packages/`.

---

## Package Layout

```
archcode/
├── apps/
│   ├── server/      — @archcode/server — Hono/Bun host, binary entry point
│   └── web/         — @archcode/web    — React/Vite frontend
├── packages/
│   ├── protocol/    — @archcode/protocol — browser-safe session types + pure reducer
│   └── agent-core/  — @archcode/agent-core — runtime: agents, tools, store, config,
│                                            provider, MCP, LSP, memory, compact, etc.
├── scripts/
│   └── build.ts     — production binary build (Vite → temporary entrypoint → Bun.build)
├── docs/            — documentation (root-level per user decision)
└── dist/            — compiled output (binary + artifacts)
```

### Package scopes

| Package | `package.json` name | Entry | Purpose |
|---------|--------------------|-------|---------|
| `apps/server` | `@archcode/server` | `src/main.ts` | Hono HTTP server, API routes, SSE, web asset serving, binary target |
| `apps/web` | `@archcode/web` | Vite build | React SPA frontend with Tailwind |
| `packages/protocol` | `@archcode/protocol` | `src/index.ts` | Session protocol types, `StreamEvent` reducer — zero runtime deps |
| `packages/agent-core` | `@archcode/agent-core` | `src/index.ts` | Agent loop, tool system, config, providers, MCP, LSP, memory, store, context compaction |

---

## Startup and Authentication Boundary

`ServerConfigService` is the sole owner of the global Config file. It returns a
typed startup result instead of letting `AgentRuntime` read disk implicitly:

```text
missing Config -> restricted Setup Host
valid Config   -> Runtime activation -> Ready Host
invalid Config -> read-only Config Error Host
```

`ArchCodeServerHost` owns the single listener, bootstrap mode, one-time
process-local Setup Grant, optional Runtime lifecycle, and optional password
Session auth. `AgentRuntime` receives only a Config activation whose runtime
projection excludes the password hash. The hash is Argon2id-only and is
available exclusively to `ServerAuthService`; it is never sent through
Protocol DTOs, Web storage, Prompt, Tools, logs, or SSE.

Setup is one create-only transition, not a general installer framework. Config
initialization uses an OS-level no-replace commit; an invalid existing Config is
never replaced or treated as first run.

---

## Process Update Boundary

Direct update is a process-level Server capability, not an Agent tool or
project resource:

```text
GitHub tagged Release
  -> signed v3 manifest + offline Sigstore bundle
  -> Server UpdateService verification/download/install
  -> Host write gate + UpdateService + Runtime idle admission close
  -> graceful exit 75
  -> stable launcher re-executes the replaced binary
```

`apps/server/src/updater/` owns Release trust, the installer receipt, update
lock, atomic replacement, persisted check metadata, and the update state
machine. `@archcode/protocol` carries only the browser-safe status and global
SSE event. The Web UI renders that projection and requests transitions; it
never chooses an asset, verifies trust, writes an executable, or decides that
the Runtime is idle.

The Host first closes all new mutating HTTP requests, then closes automatic or
manual updater work, then asks `SessionExecutionManager` to close Runtime
execution and internal Automation mutation admission. Any busy layer reopens
the earlier layers and returns a conflict. The stable packaged parent launcher interprets only
exit code `75` as a re-exec request. Every other child exit remains terminal.

The official installer and direct updater share the same OS lock and managed
install transaction. The installer bootstraps a same-directory receipt bound
to the executable digest. There is no legacy unmanaged update
path and no unsigned or checksum-only trust fallback.

---

## Dependency Direction

```
┌──────────────────────────────────────────────────────────────┐
│                        apps/server                           │
│  @archcode/server                                              │
│    ↑                        ↑                                │
│    │                        │                                │
│    │ depends on             │ depends on                     │
│    ↓                        ↓                                │
│  @archcode/agent-core ──→  @archcode/protocol                    │
│       │                                                      │
│       │ depends on                                           │
│       ↓                                                      │
│  @archcode/protocol                                            │
│       ↑                                                      │
│       │ depends on                                           │
│       │                                                      │
│  apps/web                                                    │
│  @archcode/web                                                 │
└──────────────────────────────────────────────────────────────┘
```

### Allowed dependencies

| Source | Can import | Reason |
|--------|-----------|--------|
| `apps/web` | `@archcode/protocol` | Web only needs session types + pure reducer |
| `packages/agent-core` | `@archcode/protocol` | Runtime uses protocol types for store and events |
| `apps/server` | `@archcode/agent-core`, `@archcode/protocol` | Server wires runtime and serves protocol types over SSE |
| `packages/protocol` | _(none)_ | Standalone leaf — zero runtime dependencies |

---

## Forbidden Dependencies

| Source | Cannot import | Why |
|--------|--------------|-----|
| `apps/web` | `@archcode/agent-core` | Prevents browser bundle from pulling in Node/Bun runtime, AI SDK, LSP, MCP, Zustand runtime store, etc. |
| `apps/web` | `apps/server` | Web must never depend on server internals |
| `packages/protocol` | `@archcode/agent-core` | Protocol is the leaf — must stay runtime-free |
| `packages/agent-core` | `apps/server` | Runtime must not depend on HTTP server |
| `packages/agent-core` | `apps/web` | Runtime must not depend on browser UI |

### Enforced by architecture tests

Boundary rules are codified in `packages/agent-core/src/__arch__/architecture.test.ts` and run as part of `bun test`. The test scans all `.ts`/`.tsx` source files in each package and asserts no forbidden import patterns exist.

---

## Why `@archcode/protocol` Exists

The protocol package serves as the **shared type boundary** between the frontend and the runtime:

1. **Browser safety** — Contains only types and a pure reducer (`reduceStreamEvent()`). No `node:*`, `bun:*`, AI SDK, LSP, MCP, or any runtime-only import.
2. **Zero runtime dependencies** — Its `package.json` has `"dependencies": {}`. It depends on nothing.
3. **Single source of truth** — Session types (`StreamEvent`, `SessionStoreState`, etc.) live here and are consumed by both web and agent-core, preventing type drift.
4. **Runtime wrapper** — `packages/agent-core/src/store/reduce.ts` wraps the protocol reducer with runtime-specific guards (`BusyError`, `InvalidTodoStateError`, `lastTodoWriteStepIndex` tracking). The protocol reducer is the canonical pure projection logic; agent-core adds only runtime enforcement on top.

---

## Why Web Cannot Import `@archcode/agent-core`

The browser bundle must remain lightweight and runtime-independent:

- **Size** — agent-core pulls in AI SDK, `@modelcontextprotocol/sdk`, `vscode-languageserver-*`, `jsdom`, `turndown`, etc. Shipping these to the browser is unacceptable.
- **Environment** — agent-core depends on Node/Bun APIs (`Bun.spawn`, `node:fs`, `node:child_process`, etc.) that do not exist in the browser.
- **Security** — Web UI must never access tool execution, shell commands, or filesystem operations.
- **Constraint** — If web needs new types or a new reducer function, the change goes into `@archcode/protocol`, not `@archcode/agent-core`.

---

## Why Tools/Workflow/MCP/LSP/Utils Stayed in Agent-Core

During the monorepo migration we evaluated splitting `agent-core` into finer-grained packages (`packages/tools`, `packages/workflow`, `packages/lsp`, etc.). We decided **not to split** for these reasons:

- **Tight coupling** — Tool definitions call into LSP, memory, config, and store internals. Extracting them creates circular dependencies or forces premature abstraction.
- **No clear consumer** — No other package (web, server) needs LSP or tools independently. They all reach them through the runtime hosted by server.
- **Migration cost** — Splitting would require extensive refactoring of import paths, barrel exports, and test setup with no immediate benefit.
- **Future option** — If a future consumer genuinely needs a subset (e.g., a CLI plugin that only uses tools), the split can happen then with clearer boundaries.

## MCP Runtime Ownership

MCP is a process-global live integration owned by one high-cohesion
`McpRuntimeService`. It owns resolved HTTP/STDIO configuration, transport
connections, discovery, tool inventory, status publication, draft Test,
Reconnect, hot apply, and shutdown. The service does not own Sessions,
Executions, Agent definitions, the Tool Registry, permissions, retries, or
durable project data.

Each model-call boundary asks the live runtime for the current user-server
descriptors and the built-ins allowed by that Agent's fixed role matrix. The
result is a transient descriptor/namespace/status projection for the live
authorized catalog. MCP schemas are deferred behind `tool_search`; only a
compact directory enters the Prompt, grouped by server and containing each
canonical tool name plus only the first description line, capped at 160
characters. Once loaded, tool execution uses the exact run-local descriptor selected
at that model boundary. A later reconnect, disable, or discovery change takes
effect at the next boundary and does not mutate a call already handed to the
model.

User MCP servers are authorized for all six Agent identities and do not receive
an additional approval layer. This is separate from the built-in matrix:

| Agent | Built-in MCP servers |
| --- | --- |
| Lead | `context7`, `exa` |
| Discussion | none |
| Analyst | `context7` |
| Build | none |
| Explore | none |
| Librarian | `context7`, `grep.app`, `exa` |

The local read-only designation therefore does not make a user MCP call
read-only; an external MCP tool may still write to its remote system.

## Tool Authorization and Visibility

Tool permission and model visibility are separate. `AgentDefinition` owns a
role's `authorized` local names and a strict `core` subset. Execution overlays,
worktree eligibility, depth filtering, and the live MCP role projection produce
one authorized catalog. A pure visibility projection may only subtract from
that catalog:

```text
authorized local + eligible overlay/worktree + ready MCP
  -> live catalog
  -> Core + fixed runtime State + valid Execution-loaded refs
  -> model-visible ResolvedToolSet
```

When deferred entries remain, the model also receives `tool_search`. Search is
fed by a Prompt directory containing every current deferred canonical name and
a bounded first-line description. `select:<exact-name>` performs one exact
lookup and never falls back to ranking; only other queries use deterministic
local BM25/trigram ranking. Neither path calls a model, connects MCP, grants
permission, or executes the hit. Successful hits persist only
`{name, descriptorDigest}` on the owning logical Execution and expose full
schemas on the next model step. The Tool Batch stores the catalog digest that
the model saw, so normal execution and cold recovery reject changed catalogs
rather than silently binding a different contract. Registry, permission,
finalization, and MCP call ownership remain unchanged.

New Execution records always write their tool-authorization snapshot and loaded
refs. A persisted record that predates these fields is read as
`{ extraTools: [], toolProjection: null }` with no loaded refs; malformed values
that are present remain invalid. This additive read boundary uses no data-format
version or migration framework.

Configuration requires `type` + `enabled` for every user server. HTTP uses
`url`/`headers`; STDIO uses `command`/`args`/`env`. The independent
`connectTimeoutMs`, `discoveryTimeoutMs`, and `callTimeoutMs` deadlines default
to 10,000/30,000/60,000 ms. `disabledBuiltins` can disable fixed built-ins but
cannot replace them. Config saves commit once and hot-apply this live runtime;
the API reports the independent MCP apply result and global status/inventory.

---

## Why Root `start` Was Removed

The root `package.json` previously had:
```json
"start": "bun run apps/server/src/main.ts"
```

This was removed because production uses the **compiled binary** (`dist/archcode`) directly. The binary is built via `bun run build`:

| Step | Script | Output |
|------|--------|--------|
| 1. TypeCheck | `tsc --noEmit` | Pass/fail |
| 2. Vite build | `scripts/build.ts` → `runWebBuild()` | `apps/web/dist/` |
| 3. Generate entrypoint | `scripts/build.ts` → `writeProductionEntrypoint()` | `dist/.build/main.ts` (temporary) |
| 4. Compile binary | `scripts/build.ts` → `compileBinary()` | `dist/archcode` |

No `bun run start` script is needed because `dist/archcode` is the deployment artifact.

---

## Production Binary Build

```
bun run build
  ├── tsc --noEmit               (type check)
  └── scripts/build.ts
        ├── runWebBuild()         (Vite build → apps/web/dist/)
        ├── writeProductionEntrypoint()
        │                          (scan Web dist → dist/.build/main.ts)
        ├── compileBinary()       (Bun.build({ compile: true,
                                             entrypoints: ["dist/.build/main.ts"] }))
                                    → dist/archcode
        └── finally               (remove dist/.build/)
```

### Key details

1. **Vite build** (`runWebBuild`): Spawns `bun run --cwd apps/web build` and fails if exit code ≠ 0.
2. **Production entrypoint** (`writeProductionEntrypoint`): Scans `apps/web/dist/` and writes ignored `dist/.build/main.ts` with an `import ... with { type: "file" }` per asset. The entrypoint constructs the URL-to-file map and passes it to the dedicated production startup function, which rejects a map without `/index.html` before runtime initialization. The temporary entrypoint is always removed after compilation, including failure paths.
3. **Binary compilation** (`compileBinary`):
   - Entry: `dist/.build/main.ts`
   - Target: `bun` with `compile: true`
   - Minification: enabled
   - Plugin: `css-tree-patch` — inlines `mdn-data/css/*.json` imports and patches the `css-tree` library (used by Tailwind at runtime) to avoid dynamic `require()` calls that Bun compile cannot resolve.
4. **Asset serving** (`serve-web.ts`): The `createEmbeddedAssetHandler()` middleware:
   - Serves embedded assets from the `Map` by request path
   - Falls back to SPA mode (serves `index.html` for non-`/api`/`/assets/` paths)
   - API routes (`/api/*`) take precedence and skip asset handling
5. **Output**: Single portable binary at `dist/archcode`. CI starts this compiled artifact and verifies both `/api/health` and the embedded SPA root.

---

## Out of Scope (This Migration)

The following packages and concerns are **explicitly out of scope** for this migration and should not be created without explicit project-level decision:

| Package / Concern | Rationale |
|-------------------|-----------|
| `packages/tools` | Tightly coupled to agent-core internals; no independent consumer |
| `packages/workflow` | Workflow definitions live inside agent definitions; no separate boundary |
| `packages/utils` | Utility code is small and spread across packages; extracting adds overhead |
| `apps/docs` | No documentation app planned; `docs/` at root covers ADR and usage |
| SDK / OpenAPI / public plugin platform | No external consumer planned |
| npm publishing | All packages are `"private": true` |

---

## Escalation Rules

The following situations **require an architecture decision** (documented update to this file or a new ADR):

1. **Any new circular dependency** not covered by the current boundary rules.
2. **More than 10 new public exports** proposed for `@archcode/protocol` — indicates scope creep.
3. **Any proposal for `apps/web` to import `@archcode/agent-core`** — must be denied unless there is an extremely strong justification.
4. **Bun compile cannot embed or serve Web assets** — if the binary embedding strategy breaks, the production build needs re-architecting.
5. **Any new package proposal** (`packages/tools`, `packages/workflow`, `apps/docs`, etc.) — each requires scoping, boundary analysis, and ADR.
6. **A consumer genuinely needs a subset of agent-core independently** (e.g., a CLI plugin) — may justify splitting agent-core.
7. **Architecture boundary tests fail** — if a legitimate use case requires a previously forbidden import, update both the tests and this document.

---

## Related Files

| File | Purpose |
|------|---------|
| `package.json` (root) | Workspace definition, build/test scripts |
| `turbo.json` | Turborepo pipeline configuration |
| `tsconfig.base.json` | Shared TypeScript config |
| `packages/agent-core/src/__arch__/architecture.test.ts` | Enforced boundary rules |
| `apps/server/src/serve-web.ts` | Embedded web asset handler |
| `apps/server/src/main.ts` | Shared source entry and production startup function |
| `apps/server/src/updater/` | Signed Release verification and managed executable replacement |
| `apps/server/src/launcher.ts` | Stable packaged parent and update re-exec contract |
| `scripts/build.ts` | Production binary builder |
