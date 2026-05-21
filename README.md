# Specra

Long-running coding agent with a Hono server, React Web UI, two-tier agent architecture (Orchestrator + Explorer sub-agents), structured tool execution, LSP integration, persistent memory, and context compaction.

## Quick Start

```sh
bun install
bun run typecheck    # Type check
bun test             # Run tests
```

| Scenario | Command | Description |
|---|---|---|
| Debug (recommended): separate logs | Terminal 1 `bun run server` + Terminal 2 `bun run web` | Hono and Vite as separate processes, logs don't interfere |
| One-click dev (merged logs) | `bun run dev` | concurrently starts both, output with `[server]` / `[web]` prefix |
| Production | `bun run build` | Build production binary at dist/specra |

`bun run server` starts the Hono API/SSE server from `apps/server/src/main.ts`; `bun run web` starts the Vite React frontend from `apps/web`. They can run separately for cleaner logs while developing. `bun run dev` runs both at once through `concurrently`.

### Server Environment

| Variable | Default | Description |
|---|---|---|
| `SPECRA_PORT` | `4096` | Hono server port. If the preferred port is unavailable, the server falls back to an ephemeral port. |
| `SPECRA_SERVER_PASSWORD` | unset | Enables Basic auth for `/api/*` when set. Unset means development mode with permissive CORS. |
| `SPECRA_HOST` | unset | Host value for deployments or clients that need an externally advertised host. |
| `SPECRA_OPEN_BROWSER` | unset | Reserved for opening the Web UI automatically when the server boots. |
| `SPECRA_PROJECTS_DIR` | unset | Base directory used by project-selection flows that need a projects root. |

### Projects and Web UI

Specra is multi-project: the server keeps a project registry, each project maps to a workspace root, and each workspace gets its own root Orchestrator agent, memory, workflow state, approvals, and artifacts. The Web UI talks to project-scoped routes such as `/api/projects/:slug/sessions/...`.

Use the Web UI **Add Project** flow to register an existing workspace directory. The server validates that the path is an absolute existing directory, stores it in the registry, assigns a stable slug, and then opens project-specific sessions against that workspace.

## Configuration (`.specra.json`)

Specra is configured via `.specra.json` in the project root. The config uses strict validation — unknown fields are rejected to catch typos.

### Minimal Example

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
          "modalities": { "input": ["text"], "output": ["text"] }
        }
      }
    }
  },
  "agents": {
    "orchestrator": { "model": "local:glm-5" },
    "explore": { "model": "local:glm-5" }
  }
}
```

### Full Example with Options and Variants

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
              "temperature": 0.1,
              "providerOptions": {
                "local": { "reasoningEffort": "low" }
              }
            },
            "deep": {
              "maxOutputTokens": 128000,
              "temperature": 0.3,
              "topP": 0.9,
              "providerOptions": {
                "local": { "reasoningEffort": "high" }
              }
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

### Provider Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `npm` | Yes | AI SDK provider package name |
| `name` | Yes | Provider display name |
| `options` | Yes | Provider connection options (`baseURL`, `apiKey`, `headers`, `queryParams`) |
| `models` | Yes | Map of model ID → model config |

Environment variable expansion is supported in string values: `${VAR}` or `${VAR:-default}`.

### Model Configuration

Each model under `provider.<id>.models` has:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Model display name |
| `limit` | Yes | `{ context, output }` token limits |
| `modalities` | Yes | `{ input: [...], output: [...] }` supported modalities |
| `options` | No | Base AI SDK call options (see below) |
| `variants` | No | Named option profiles (see below) |

### Model Call Options (`options`)

AI SDK-style camelCase option names. Unknown fields are rejected to prevent typos.

| Option | Type | Description |
|--------|------|-------------|
| `maxOutputTokens` | number | Maximum tokens in model response |
| `temperature` | number | Sampling temperature (0–2) |
| `topP` | number | Nucleus sampling threshold |
| `topK` | number | Top-K sampling |
| `presencePenalty` | number | Presence penalty (-2–2) |
| `frequencyPenalty` | number | Frequency penalty (-2–2) |
| `stopSequences` | string[] | Sequences that stop generation |
| `seed` | number | Deterministic sampling seed |
| `maxRetries` | number | Maximum retry attempts |
| `timeout` | number | Request timeout in milliseconds |
| `providerOptions` | object | Provider-specific settings (e.g., `{ "openai": { "reasoningEffort": "high" } }`) |

> **Note:** Do **not** use snake_case names like `top_p` or `maxTokens`. They will be rejected by validation.

### Variants

Variants are named option profiles under a model. An agent references a variant by name to inherit its options.

```json
"variants": {
  "fast": { "maxOutputTokens": 16000, "temperature": 0.1 },
  "deep": { "maxOutputTokens": 128000, "temperature": 0.3 }
}
```

The `variant` field is consumed during resolution — it is **never** passed to the AI SDK call.

### Agent Configuration

| Field | Required | Description |
|-------|----------|-------------|
| `model` | Yes | `provider:modelId` format (e.g., `"local:glm-5"`) |
| `variant` | No | Named variant profile from the model config |
| `options` | No | Per-agent option overrides |

> **Important:** Every instantiated agent must have a `model` configured. Currently the required agents are `orchestrator` and `explore`. Missing agent config fails fast with an actionable error.

### Option Merge Order

Options are merged in three layers, with later layers overriding earlier ones:

```
model.options → variants[agent.variant] → agents[agent].options
```

**`providerOptions` is shallow-replaced**, not deep-merged. If model options set `providerOptions: { a: 1, b: 2 }` and agent options set `providerOptions: { c: 3 }`, the result is `{ c: 3 }` — not `{ a: 1, b: 2, c: 3 }`.

### Error Behavior

| Scenario | Error | Details |
|----------|-------|---------|
| Missing `agents.<name>.model` | `MissingAgentModelConfigError` | Includes agent name and available agents |
| Unknown model ID | `UnknownQualifiedIdError` | Includes the invalid ID and available models |
| Unknown variant name | `UnknownModelVariantError` | Includes agent name, model ID, requested variant, and available variants |

All errors fail fast at agent creation time — not mid-stream.

## Architecture

```
apps/server/src/main.ts                           # Headless server entry: createSpecraRuntime() → config → providers → tools → MCP → boot Hono
packages/agent-core/src/config/                   # Config loading (JSON), Zod validation (.strict() on all schemas)
packages/agent-core/src/provider/                  # Provider registry & ModelInfo (wraps AI SDK instances)
packages/agent-core/src/agents/definitions/        # AgentDefinition records for orchestrator, explore, and workflow roles
packages/agent-core/src/agents/factory.ts          # Agent creation and delegation through ConfiguredAgent
packages/agent-core/src/agents/model-resolver.ts   # Agent → model + resolved options (fail-fast)
packages/agent-core/src/agents/query/loop.ts       # streamText + tool execution cycle (max 50 steps)
packages/agent-core/src/projects/                  # Multi-project registry and per-workspace context resolver
apps/server/src/                                   # Hono REST + SSE server with auth, CORS, errors, lifecycle
apps/web/                                          # Vite + React + Tailwind frontend
packages/agent-core/src/compact/                   # 3-phase context compaction pipeline
packages/agent-core/src/memory/                    # Persistent memory (atomic writes, frontmatter, index)
packages/agent-core/src/lsp/                       # LSP client pool (18 language servers, 50+ ext mappings)
packages/agent-core/src/tools/                     # 21 builtin tools with guard/hook pipeline
```

**Data flow:**
```
.specra.json → config → resolveAgentModel() → ModelInfo + resolvedOptions
  → Hono server → project-scoped OrchestratorAgent → query loop → store → SSE → Web UI
```

## Development

```sh
bun run server       # Start Hono API/SSE server with hot reload
bun run web          # Start Vite Web UI dev server
bun run dev          # Start server + web together with prefixed merged logs
bun run build        # Type check + build Web UI assets + compile binary
bun run typecheck    # Type check (run first)
bun test             # Run tests
```

### Testing Patterns

- Test runner: `bun:test`. Import from `"bun:test"`. Use `mock()` not `jest.fn()`.
- Custom errors: test `err.name` and constructor fields.
- All Zod schemas use `.strict()`.
- Mock `streamText`: `__setStreamTextForTest(fn)` from `agents/query/loop.ts`
- Mock `generateText`: `__setGenerateTextForTest(fn)` from `llm/llm-object.ts`
