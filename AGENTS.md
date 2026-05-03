talk in chinese, code in english(include comments).
if u have any questions or choices, feel free to ask user.

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

Run order when validating changes: `typecheck` → `test`.

## Architecture (early stage)

```
src/
  index.ts       # Ink React terminal UI entry point
  config/        # Config loading, validation, provider instantiation (implemented)
  commands/      # CLI commands (empty — not yet implemented)
  core/          # Core agent orchestration logic (empty — not yet implemented)
  agents/        # Agent role definitions (empty — not yet implemented)
```

- Only `src/config/` has real implementation so far.
- Config module uses Zod 4 for validation, Vercel AI SDK for LLM provider abstraction.

## Key Dependencies

- `ai` + `@ai-sdk/openai-compatible` — LLM calls via Vercel AI SDK. Currently only OpenAI-compatible provider is supported.
- `ink` + `react` — Terminal UI.
- `zod` (v4) — Schema validation. Uses `.strict()` on all objects (rejects unknown keys).

## Config File

- `.specra.json` at project root (gitignored). Contains provider definitions (baseURL, apiKey, models).
- Schema: `{ $schema?, provider: { [id]: { npm, name, options: { baseURL, apiKey?, headers?, queryParams? }, models: { [id]: { name, limit: { context, output }, modalities: { input, output } } } } } }`.
- Loaded via `src/config/load.ts` → parsed with Zod → provider instance created in `src/config/provider.ts`.

## Testing

- Test runner: `bun:test` (not Jest/Vitest). Import from `"bun:test"`.
- Test file convention: `<name>.test.ts` colocated with source.
- Tests create temp files in `__test_tmp__/` relative to test file dir, cleaned up in `afterAll`.
- Only one test file exists: `src/config/config.test.ts`.

## Conventions

- Custom error classes extend `Error` with typed constructor params and explicit `this.name` assignment.
- Barrel exports via `index.ts` files in each module.
- All Zod schemas use `.strict()` — no passthrough of unknown properties.
