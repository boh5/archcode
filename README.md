# Specra

Long-running coding CLI agent with two-tier agent architecture (Orchestrator + Explorer sub-agents), structured tool execution, LSP integration, persistent memory, and context compaction.

## Quick Start

```sh
bun install
bun run dev          # Run CLI entry point
bun run typecheck    # Type check
bun test             # Run tests
```

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
src/main.ts                         # CLI entry: createSpecraRuntime() → config → providers → tools → MCP → agent → Ink render
src/config/                         # Config loading (JSON), Zod validation (.strict() on all schemas)
src/provider/                        # Provider registry & ModelInfo (wraps AI SDK instances)
src/agents/definitions/              # AgentDefinition records for orchestrator, explore, and workflow roles
src/agents/factory.ts                # Agent creation and delegation through ConfiguredAgent
src/agents/model-resolver.ts         # Agent → model + resolved options (fail-fast)
src/agents/query/loop.ts             # streamText + tool execution cycle (max 50 steps)
src/compact/                         # 3-phase context compaction pipeline
src/memory/                          # Persistent memory (atomic writes, frontmatter, index)
src/lsp/                             # LSP client pool (18 language servers, 50+ ext mappings)
src/tools/                           # 21 builtin tools with guard/hook pipeline
```

**Data flow:**
```
.specra.json → config → resolveAgentModel() → ModelInfo + resolvedOptions
  → OrchestratorAgent → query loop → store → TUI
```

## Development

```sh
bun run dev          # Run CLI
bun run typecheck    # Type check (run first)
bun test             # Run tests
```

### Testing Patterns

- Test runner: `bun:test`. Import from `"bun:test"`. Use `mock()` not `jest.fn()`.
- Custom errors: test `err.name` and constructor fields.
- All Zod schemas use `.strict()`.
- Mock `streamText`: `__setStreamTextForTest(fn)` from `agents/query/loop.ts`
- Mock `generateText`: `__setGenerateTextForTest(fn)` from `llm/llm-object.ts`
