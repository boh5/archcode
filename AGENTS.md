## Project

Specra — long-running coding CLI agent that orchestrates AI roles (PM, backend, frontend, QA, PR review) from the terminal.

## Runtime & Toolchain

- **Runtime**: Bun (not Node). All scripts use `bun run` / `bun test`.
- **Package manager**: Bun (bun.lock present, not package-lock).
- **TypeScript**: strict mode, ES2022 target, NodeNext module resolution with `.js` extensions in imports.

## Commands

```sh
bun run dev          # Run CLI entry point (src/index.ts)
bun run typecheck    # tsc --noEmit
bun test             # Run tests (bun:test runner)
```

Validation order: `typecheck` → `test`.

## Architecture

```
src/
  index.ts       # Ink React terminal UI entry point
  config/        # Config loading, validation, provider schema
  provider/      # Provider registry & model metadata (wraps AI SDK instances)
  commands/      # CLI commands (not yet implemented)
  core/          # Core agent orchestration logic (not yet implemented)
  agents/        # Agent role definitions (not yet implemented)
```

**Data flow:**
```
.specra.json → config/ (load + validate) → provider/ (registry + ModelInfo) → agents/ (LLM calls)
```

## Key Dependencies

- `ai` + `@ai-sdk/openai-compatible` — LLM calls via Vercel AI SDK. Only OpenAI-compatible provider supported.
- `ink` + `react` — Terminal UI.
- `zod` (v4) — Schema validation with `.strict()` on all objects.

## Conventions

- Talk in chinese, code in english (include comments).
- If u have any questions or choices, feel free to ask user.
- Use TDD development.
- Custom error classes extend `Error` with typed constructor params and explicit `this.name` assignment.
- Barrel exports via `index.ts` files in each module.
- All Zod schemas use `.strict()` — no passthrough of unknown properties.
- Test runner: `bun:test` (not Jest/Vitest). Import from `"bun:test"`.
- Test file convention: `<name>.test.ts` colocated with source.
- Tests create temp files in `__test_tmp__/` relative to test file dir, cleaned up in `afterAll`.
