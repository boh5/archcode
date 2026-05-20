# Architecture Decision Record

> **Purpose:** Document monorepo package boundaries, dependency direction, forbidden imports, production binary strategy, and escalation rules for future maintainers.
>
> **Context:** This ADR captures decisions made during the monorepo migration from a flat `src/` layout to a workspace-based structure with `apps/` and `packages/`.

---

## Package Layout

```
specra/
├── apps/
│   ├── server/      — @specra/server — Hono/Bun host, binary entry point
│   └── web/         — @specra/web    — React/Vite frontend
├── packages/
│   ├── protocol/    — @specra/protocol — browser-safe session types + pure reducer
│   └── agent-core/  — @specra/agent-core — runtime: agents, tools, store, config,
│                                            provider, MCP, LSP, memory, compact, etc.
├── scripts/
│   └── build.ts     — production binary build (Vite → web-manifest → Bun.build)
├── docs/            — documentation (root-level per user decision)
└── dist/            — compiled output (binary + artifacts)
```

### Package scopes

| Package | `package.json` name | Entry | Purpose |
|---------|--------------------|-------|---------|
| `apps/server` | `@specra/server` | `src/main.ts` | Hono HTTP server, API routes, SSE, web asset serving, binary target |
| `apps/web` | `@specra/web` | Vite build | React SPA frontend with Tailwind |
| `packages/protocol` | `@specra/protocol` | `src/index.ts` | Session protocol types, `StreamEvent` reducer — zero runtime deps |
| `packages/agent-core` | `@specra/agent-core` | `src/index.ts` | Agent loop, tool system, config, providers, MCP, LSP, memory, store, context compaction |

---

## Dependency Direction

```
┌──────────────────────────────────────────────────────────────┐
│                        apps/server                           │
│  @specra/server                                              │
│    ↑                        ↑                                │
│    │                        │                                │
│    │ depends on             │ depends on                     │
│    ↓                        ↓                                │
│  @specra/agent-core ──→  @specra/protocol                    │
│       │                                                      │
│       │ depends on                                           │
│       ↓                                                      │
│  @specra/protocol                                            │
│       ↑                                                      │
│       │ depends on                                           │
│       │                                                      │
│  apps/web                                                    │
│  @specra/web                                                 │
└──────────────────────────────────────────────────────────────┘
```

### Allowed dependencies

| Source | Can import | Reason |
|--------|-----------|--------|
| `apps/web` | `@specra/protocol` | Web only needs session types + pure reducer |
| `packages/agent-core` | `@specra/protocol` | Runtime uses protocol types for store and events |
| `apps/server` | `@specra/agent-core`, `@specra/protocol` | Server wires runtime and serves protocol types over SSE |
| `packages/protocol` | _(none)_ | Standalone leaf — zero runtime dependencies |

---

## Forbidden Dependencies

| Source | Cannot import | Why |
|--------|--------------|-----|
| `apps/web` | `@specra/agent-core` | Prevents browser bundle from pulling in Node/Bun runtime, AI SDK, LSP, MCP, Zustand runtime store, etc. |
| `apps/web` | `apps/server` | Web must never depend on server internals |
| `packages/protocol` | `@specra/agent-core` | Protocol is the leaf — must stay runtime-free |
| `packages/agent-core` | `apps/server` | Runtime must not depend on HTTP server |
| `packages/agent-core` | `apps/web` | Runtime must not depend on browser UI |

### Enforced by architecture tests

Boundary rules are codified in `packages/agent-core/src/__arch__/architecture.test.ts` and run as part of `bun test`. The test scans all `.ts`/`.tsx` source files in each package and asserts no forbidden import patterns exist.

---

## Why `@specra/protocol` Exists

The protocol package serves as the **shared type boundary** between the frontend and the runtime:

1. **Browser safety** — Contains only types and a pure reducer (`reduceStreamEvent()`). No `node:*`, `bun:*`, AI SDK, LSP, MCP, or any runtime-only import.
2. **Zero runtime dependencies** — Its `package.json` has `"dependencies": {}`. It depends on nothing.
3. **Single source of truth** — Session types (`StreamEvent`, `SessionStoreState`, etc.) live here and are consumed by both web and agent-core, preventing type drift.
4. **The `reduce.ts` file** in `agent-core/src/store/reduce.ts` is explicitly tested (`reduce isomorphism` test) to contain zero `node:*` imports and zero `Bun.*` usage — ensuring it could be moved to protocol if needed.

---

## Why Web Cannot Import `@specra/agent-core`

The browser bundle must remain lightweight and runtime-independent:

- **Size** — agent-core pulls in AI SDK, `@modelcontextprotocol/sdk`, `vscode-languageserver-*`, `jsdom`, `turndown`, etc. Shipping these to the browser is unacceptable.
- **Environment** — agent-core depends on Node/Bun APIs (`Bun.spawn`, `node:fs`, `node:child_process`, etc.) that do not exist in the browser.
- **Security** — Web UI must never access tool execution, shell commands, or filesystem operations.
- **Constraint** — If web needs new types or a new reducer function, the change goes into `@specra/protocol`, not `@specra/agent-core`.

---

## Why Tools/Workflow/MCP/LSP/Utils Stayed in Agent-Core

During the monorepo migration we evaluated splitting `agent-core` into finer-grained packages (`packages/tools`, `packages/workflow`, `packages/lsp`, etc.). We decided **not to split** for these reasons:

- **Tight coupling** — Tool definitions call into LSP, memory, config, and store internals. Extracting them creates circular dependencies or forces premature abstraction.
- **No clear consumer** — No other package (web, server) needs LSP or tools independently. They all reach them through the runtime hosted by server.
- **Migration cost** — Splitting would require extensive refactoring of import paths, barrel exports, and test setup with no immediate benefit.
- **Future option** — If a future consumer genuinely needs a subset (e.g., a CLI plugin that only uses tools), the split can happen then with clearer boundaries.

---

## Why Root `start` Was Removed

The root `package.json` previously had:
```json
"start": "bun run apps/server/src/main.ts"
```

This was removed because production uses the **compiled binary** (`dist/specra`) directly. The binary is built via `bun run build`:

| Step | Script | Output |
|------|--------|--------|
| 1. TypeCheck | `tsc --noEmit` | Pass/fail |
| 2. Vite build | `scripts/build.ts` → `runWebBuild()` | `apps/web/dist/` |
| 3. Generate manifest | `scripts/build.ts` → `generateManifest()` | `apps/server/src/web-manifest.ts` |
| 4. Compile binary | `scripts/build.ts` → `compileBinary()` | `dist/specra` |

No `bun run start` script is needed because `dist/specra` is the deployment artifact.

---

## Production Binary Build

```
bun run build
  ├── tsc --noEmit               (type check)
  └── scripts/build.ts
        ├── runWebBuild()         (Vite build → apps/web/dist/)
        ├── generateManifest()    (scan dist/ → web-manifest.ts with Bun.file() imports)
        └── compileBinary()       (Bun.build({ compile: true, plugins: [cssTreePatchPlugin] }))
                                    → dist/specra
```

### Key details

1. **Vite build** (`runWebBuild`): Spawns `bun run --cwd apps/web build` and fails if exit code ≠ 0.
2. **Web manifest** (`generateManifest`): Scans `apps/web/dist/`, emits `apps/server/src/web-manifest.ts` with an `import ... with { type: "file" }` per asset and a `Map<string, string>` lookup. This embeds all frontend assets into the binary at compile time.
3. **Binary compilation** (`compileBinary`):
   - Entry: `apps/server/src/main.ts`
   - Target: `bun` with `compile: true`
   - Minification: enabled
   - Plugin: `css-tree-patch` — inlines `mdn-data/css/*.json` imports and patches the `css-tree` library (used by Tailwind at runtime) to avoid dynamic `require()` calls that Bun compile cannot resolve.
4. **Asset serving** (`serve-web.ts`): The `createEmbeddedAssetHandler()` middleware:
   - Serves embedded assets from the `Map` by request path
   - Falls back to SPA mode (serves `index.html` for non-`/api`/`/assets/` paths)
   - API routes (`/api/*`) take precedence and skip asset handling
5. **Output**: Single portable binary at `dist/specra`.

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
2. **More than 10 new public exports** proposed for `@specra/protocol` — indicates scope creep.
3. **Any proposal for `apps/web` to import `@specra/agent-core`** — must be denied unless there is an extremely strong justification.
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
| `apps/server/src/web-manifest.ts` | Auto-generated asset manifest (do not hand-edit) |
| `scripts/build.ts` | Production binary builder |
