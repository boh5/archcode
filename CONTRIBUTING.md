# Contributing to ArchCode

Thanks for helping improve ArchCode. This document is for contributors and maintainers. If you only want to install and use ArchCode, start with [README.md](./README.md).

## Project overview

ArchCode is a Bun/Turborepo monorepo with a Hono server, React Web UI, shared protocol package, shared utilities, and core agent runtime.

```
archcode/
├── apps/server/          # Hono API/SSE server
├── apps/web/             # Vite + React Web UI
├── packages/agent-core/  # Agent runtime, tools, memory, goals, automations, LSP, MCP
├── packages/protocol/    # Shared protocol types and reducers
├── packages/utils/       # Shared utility helpers
└── scripts/build.ts      # Production build pipeline
```

Dependency direction matters:

```text
@archcode/server → @archcode/agent-core → @archcode/protocol
@archcode/server → @archcode/utils
@archcode/agent-core → @archcode/utils
@archcode/web → @archcode/protocol
```

The Web app must not depend on `@archcode/server` or `@archcode/agent-core`.

## Development setup

Install dependencies:

```sh
bun install
```

Run server and web together:

```sh
bun run dev
```

Useful commands:

| Command | Description |
|---|---|
| `bun run dev` | Start server and web through Turborepo |
| `bun run typecheck` | Type check all workspaces |
| `bun run test` | Run the Bun test suite through Turborepo |
| `bun run web:build` | Build the Vite Web UI only |
| `bun run build` | Type check, build web assets, generate a temporary production entrypoint, and compile `dist/archcode` |

Validation order is `typecheck` before `test`.

## Pull request workflow

1. Open an issue or describe the problem clearly in the PR.
2. Keep changes focused. Separate unrelated refactors from feature work.
3. Add or update tests for behavior changes.
4. Update user-facing documentation when behavior, setup, or configuration changes.
5. Run the relevant checks before opening the PR:

```sh
bun run typecheck
bun run test
```

For changes that affect the production package or Web UI, also run:

```sh
bun run build
```

## Code conventions

- TypeScript is strict. Do not suppress type errors with `as any`, `@ts-ignore`, or `@ts-expect-error`.
- Use Bun-native APIs where practical. Use `node:*` only when Bun has no native equivalent.
- Do not use `.js` extensions in TypeScript imports.
- Custom errors should extend `Error`, set `this.name`, and expose meaningful typed fields.
- Zod schemas should use `.strict()`.
- Keep package boundaries intact; architecture tests enforce important dependency rules.
- Do not commit secrets. GitHub tokens are resolved from environment variables; Provider credentials are literal values in the private server config file.

## Testing conventions

- Tests use `bun:test`; import from `"bun:test"`.
- Use `mock()` instead of `jest.fn()`.
- Prefer colocated test files named `<name>.test.ts`.
- Temporary test directories should live under `__test_tmp__/` and be cleaned in `afterAll`.
- Test custom error `name` values and typed fields, not only message text.
- Mock LLM calls through `setLlmAdapterForTest()` from `packages/agent-core/src/llm`.
- Mock LSP through the test seams exposed from `packages/agent-core/src/lsp/`.
- Server HTTP tests should use Hono's `app.request()` pattern.

## Configuration changes

If you change the `~/.archcode/config.json` schema, defaults, validation behavior, model option semantics, or user-facing configuration, update [README.md](./README.md) in the same PR.

Configuration is strict on purpose: unknown fields should fail fast so users catch typos early.

## Architecture notes

High-level runtime flow:

```text
~/.archcode/config.json
  → config loading and validation
  → provider and model resolution
  → builtin tools and MCP discovery
  → Hono server
  → project-scoped agents, goals, automations, HITL, memory
  → query loop and tool execution
  → session store
  → SSE
  → Web UI
```

Important areas:

| Path | Purpose |
|---|---|
| `apps/server/src/main.ts` | Headless server entry point |
| `apps/server/src/app.ts` | Hono app, routes, auth, errors, CORS |
| `apps/web/src/` | React workbench UI |
| `packages/agent-core/src/runtime.ts` | Runtime creation and wiring |
| `packages/agent-core/src/agents/` | Agent definitions, factory, delegation, model resolution |
| `packages/agent-core/src/tools/` | Tool descriptors, registry, guards, hooks, permissions |
| `packages/agent-core/src/goals/` | Goal state, review checks, retry, budget, evidence |
| `packages/agent-core/src/hitl/` | Durable approval/question queue |
| `packages/agent-core/src/automations/` | Schedule, durable Invocation state, and Session dispatch |
| `packages/agent-core/src/lsp/` | LSP client pool and language server integration |
| `packages/agent-core/src/llm/` | Managed LLM runtime and retry/recovery boundary |
| `packages/protocol/src/` | Shared event and protocol types |

## Documentation style

- README is for users: what ArchCode is, how to install it, how to configure it, and how to use it.
- CONTRIBUTING is for contributors: development setup, architecture, testing, and PR guidance.
- Planning docs and design notes belong under `docs/`.

## Reporting security issues

Do not open public issues for secrets, authentication bypasses, or vulnerabilities that expose private workspaces. Contact the maintainer privately until a security policy is published.
