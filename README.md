# ArchCode

> **You architect. AI codes.**

Programming is splitting into two jobs: **architecting intent** and **writing code**. ArchCode is the workbench where the architect hands the blueprint to AI for execution — not another tool to help you *write code faster*, but one that lets you **stop writing code**.

The name carries two meanings at once: **arch**itect (your role) and **arch** (the oldest bridge form) — the bridge between your intent and AI's execution.

## How It Works

Work happens through six specialized agents, each with a distinct role:

1. **Orchestrator** — Plans and coordinates work, delegates to sub-agents, owns the session store.
2. **Plan** — Analyzes requirements and creates structured execution plans.
3. **Build** — Writes code, runs tools, implements features.
4. **Reviewer** — Reviews code quality, runs tests, validates against requirements.
5. **Explore** — Read-only research agent for searching, browsing, and gathering information.
6. **Librarian** — Documentation and knowledge management agent.

```
[Orchestrator → Plan → Build → Reviewer]  ==  AI codes.
[Explore + Librarian]                      ==  Supporting research & docs.
```

ArchCode is a long-running coding agent with a Hono server + React Web UI, two-tier agent architecture (Orchestrator + Explorer sub-agents), structured tool execution, LSP integration, persistent memory, and context compaction.

## Quick Start

```sh
bun install
bun run typecheck    # Type check
bun test             # Run tests
```

| Scenario | Command | Description |
|---|---|---|
| Development | `bun run dev` | Starts both server and web via Turborepo |
| Production | `bun run build` | Build production binary at dist/archcode |

`bun run dev` starts the Hono API/SSE server (from `apps/server/src/main.ts`) and the Vite React frontend (from `apps/web`) in parallel via Turborepo.

### Server Environment

| Variable | Default | Description |
|---|---|---|
| `ARCHCODE_PORT` | `4096` | Hono server port. If the preferred port is unavailable, the server falls back to an ephemeral port. |
| `ARCHCODE_SERVER_PASSWORD` | unset | Enables Basic auth for `/api/*` when set. Unset means development mode with permissive CORS. |
| `ARCHCODE_HOST` | unset | Host value for deployments or clients that need an externally advertised host. |
| `ARCHCODE_OPEN_BROWSER` | unset | Reserved for opening the Web UI automatically when the server boots. |
| `ARCHCODE_PROJECTS_DIR` | unset | Base directory used by project-selection flows that need a projects root. |

### Projects and Web UI

ArchCode is multi-project: the server keeps a project registry, each project maps to a workspace root, and each workspace gets its own root Orchestrator agent, memory, workflow state, approvals, and artifacts. The Web UI talks to project-scoped routes such as `/api/projects/:slug/sessions/...`.

Use the Web UI **Add Project** flow to register an existing workspace directory. The server validates that the path is an absolute existing directory, stores it in the registry, assigns a stable slug, and then opens project-specific sessions against that workspace.

## Configuration (`.archcode.json`)

ArchCode is configured via `.archcode.json` in the project root. The config uses strict validation — unknown fields are rejected to catch typos.

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
    "plan": { "model": "local:glm-5" },
    "build": { "model": "local:glm-5" },
    "reviewer": { "model": "local:glm-5" },
    "explore": { "model": "local:glm-5" },
    "librarian": { "model": "local:glm-5" }
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
    "plan": {
      "model": "local:glm-5",
      "variant": "deep",
      "options": { "temperature": 0.3 }
    },
    "build": {
      "model": "local:glm-5",
      "variant": "fast",
      "options": { "temperature": 0.1 }
    },
    "reviewer": {
      "model": "local:glm-5",
      "variant": "deep",
      "options": { "temperature": 0.2 }
    },
    "explore": {
      "model": "local:glm-5",
      "variant": "fast",
      "options": { "temperature": 0, "maxOutputTokens": 12000 }
    },
    "librarian": {
      "model": "local:glm-5",
      "variant": "fast",
      "options": { "temperature": 0, "maxOutputTokens": 8000 }
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
| `maxRetries` | number | AI SDK provider-call retry hint only; ArchCode-managed LLM runtime calls force this to `0` and run their own recovery path |
| `timeout` | number | Request timeout in milliseconds |
| `providerOptions` | object | Provider-specific settings (e.g., `{ "openai": { "reasoningEffort": "high" } }`) |

> **Note:** Do **not** use snake_case names like `top_p` or `maxTokens`. They will be rejected by validation.

#### LLM Retry and Recovery Boundary

ArchCode routes model execution through `packages/agent-core/src/llm/` (`runLlmStream`, `runLlmText`, and `runLlmObject`). Application code outside that runtime must not import `streamText` or `generateText` directly from `"ai"`; architecture tests enforce this boundary.

`maxRetries` in `.archcode.json` remains an AI SDK-style model option, but it is **not** ArchCode's managed retry mechanism. Managed LLM calls intentionally pass `maxRetries: 0` to the AI SDK so ArchCode owns retry classification, recovery notices, interrupted-output handling, and durable session state.

This matters for streaming: AI SDK `maxRetries` only applies before a successful response is established. It cannot recover failures that happen inside an HTTP 200 streaming response body, such as EOF, truncated SSE, or stream parser failures after partial output has already arrived. ArchCode handles those cases at the runtime/query-loop layer instead.

Retry constants are internal v1 implementation details. There is currently **no** `.archcode.json` recovery retry configuration, and the config schema must not grow retry fields until that behavior is intentionally productized. Existing auto-compaction behavior is preserved; automated emergency compaction specifically for context-overflow recovery is a follow-up and out of scope for the current refactor.

#### Manual Streaming Recovery Test Server

For local manual testing, `scripts/mock-llm-server.ts` starts a Bun/OpenAI-compatible mock server that can intentionally break SSE streams by destroying the HTTP socket after writing partial SSE data:

```sh
MOCK_LLM_SCENARIO=partial-eof-once bun run scripts/mock-llm-server.ts
```

When testing through ArchCode, prefer failing the first two streamed requests so provider/client-level connection retries cannot hide the failure from ArchCode's query loop:

```sh
MOCK_LLM_SCENARIO=partial-eof-once \
MOCK_LLM_FAIL_STREAM_ATTEMPTS=2 \
bun run scripts/mock-llm-server.ts
```

Point a temporary provider config at the mock server:

```json
"options": {
  "baseURL": "http://localhost:19998/v1",
  "apiKey": "mock-key"
}
```

Supported scenarios:

| Scenario | Behavior |
|---|---|
| `normal` | Always returns a normal streamed answer |
| `zero-eof-once` | First request aborts before any output, next request recovers |
| `partial-eof-once` | First request streams partial text then aborts, next request recovers |
| `tool-eof-once` | First request streams a tool call then aborts before final tool-call data, next request recovers |
| `always-zero-eof` | Every request aborts before output, useful for observing session retry escalation |
| `always-partial-eof` | Every request aborts after partial output |

Reset or switch scenarios without restarting:

```sh
curl -s -X POST http://localhost:19998/__mock/reset \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"zero-eof-once","failStreamAttempts":2}'
```

For EOF scenarios, `curl` may only show a truncated response. The meaningful signal is in ArchCode/AI SDK behavior: the first failed streamed request should surface a stream error such as “socket connection was closed unexpectedly”, and ArchCode should then emit retry/recovery events and recover on the next streamed request for the `*-once` scenarios.

The server logs both total requests and `streamAttempt`. Non-streaming background calls such as title generation do not consume `streamAttempt` and will not use up the intentional EOF failures.

### Variants

Variants are named option profiles under a model. An agent references a variant by name to inherit its options.

```json
"variants": {
  "fast": { "maxOutputTokens": 16000, "temperature": 0.1 },
  "deep": { "maxOutputTokens": 128000, "temperature": 0.3 }
}
```

The `variant` field is consumed during resolution — it is **never** passed to the AI SDK call.

### Memory Configuration

Memory extraction runs automatically after each query loop on the root orchestrator agent. Sub-agents (explore, etc.) do not trigger memory extraction. You can control its behavior via the `memory` section in `.archcode.json`:

```json
{
  "memory": {
    "enabled": true,
    "minMessages": 5,
    "minContentLength": 1000,
    "cooldownMs": 300000
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `enabled` | `true` | Set to `false` to disable memory extraction entirely |
| `minMessages` | `5` | Minimum number of user messages required before extraction triggers |
| `minContentLength` | `1000` | Minimum total text content length (in characters) required before extraction triggers |
| `cooldownMs` | `300000` | Minimum time (ms) between successive extractions (5 minutes) |

Memory extraction also applies smart message filtering: only user messages and read-only tool outputs are sent to the extraction LLM. Assistant reasoning, write operations, and delegation results are excluded to reduce noise and token cost.

### Agent Configuration

The `agents` section is **required** and must contain exactly six agent entries. Unknown agent keys are rejected.

| Field | Required | Description |
|-------|----------|-------------|
| `model` | Yes | `provider:modelId` format (e.g., `"local:glm-5"`) |
| `variant` | No | Named variant profile from the model config |
| `options` | No | Per-agent option overrides |

**Required agents:**

| Agent | Role |
|-------|------|
| `orchestrator` | Plans and coordinates work, delegates to sub-agents |
| `plan` | Analyzes requirements and creates structured execution plans |
| `build` | Writes code, runs tools, implements features |
| `reviewer` | Reviews code quality, runs tests, validates against requirements |
| `explore` | Read-only research agent for searching and gathering information |
| `librarian` | Documentation and knowledge management agent |

> **Important:** All six agents must have a `model` configured. Missing any agent fails fast with an actionable error naming the missing role.

### Option Merge Order

Options are merged in three layers, with later layers overriding earlier ones:

```
model.options → variants[agent.variant] → agents[agent].options
```

**`providerOptions` is shallow-replaced**, not deep-merged. If model options set `providerOptions: { a: 1, b: 2 }` and agent options set `providerOptions: { c: 3 }`, the result is `{ c: 3 }` — not `{ a: 1, b: 2, c: 3 }`.

### Error Behavior

| Scenario | Error | Details |
|----------|-------|---------|
| Missing `agents` section | `ConfigValidationError` | Schema validation rejects configs without `agents` |
| Missing required agent key | `ConfigValidationError` | Error message names the missing role (e.g., `reviewer`) |
| Unknown agent key | `ConfigValidationError` | Strict object rejects extra keys like `"product"` |
| Missing `agents.<name>.model` | `MissingAgentModelConfigError` | Includes agent name and available agents |
| Unknown model ID | `UnknownQualifiedIdError` | Includes the invalid ID and available models |
| Unknown variant name | `UnknownModelVariantError` | Includes agent name, model ID, requested variant, and available variants |

All errors fail fast at agent creation time — not mid-stream.

## Architecture

```
apps/server/src/main.ts                           # Headless server entry: createRuntime() → config → providers → tools → MCP → boot Hono
packages/agent-core/src/config/                   # Config loading (JSON), Zod validation (.strict() on all schemas)
packages/agent-core/src/provider/                  # Provider registry & ModelInfo (wraps AI SDK instances)
packages/agent-core/src/agents/definitions/        # AgentDefinition records for orchestrator, explore, and workflow roles
packages/agent-core/src/agents/factory.ts          # Agent creation and delegation through ConfiguredAgent
packages/agent-core/src/agents/model-resolver.ts   # Agent → model + resolved options (fail-fast)
packages/agent-core/src/agents/query/loop.ts       # runLlmStream + tool execution cycle (max 50 steps)
packages/agent-core/src/projects/                  # Multi-project registry and per-workspace context resolver
apps/server/src/                                   # Hono REST + SSE server with auth, CORS, errors, lifecycle
apps/web/                                          # Vite + React + Tailwind frontend
packages/agent-core/src/compact/                   # 3-phase context compaction pipeline
packages/agent-core/src/memory/                    # Persistent memory (atomic writes, frontmatter, index)
packages/agent-core/src/lsp/                       # LSP client pool (18 language servers, 50+ ext mappings)
packages/agent-core/src/llm/                       # Managed LLM runtime boundary, retry/recovery, adapter test seam
packages/agent-core/src/tools/                     # 21 builtin tools with guard/hook pipeline
```

**Data flow:**
```
.archcode.json → config → resolveAgentModel() → ModelInfo + resolvedOptions
  → Hono server → project-scoped OrchestratorAgent → query loop → store → SSE → Web UI
```

## Development

```sh
bun run dev          # Start server + web together via Turborepo
bun run build        # Type check + build Web UI assets + compile binary
bun run typecheck    # Type check all packages (via Turborepo)
bun test             # Run tests (via Turborepo)
```

### Testing Patterns

- Test runner: `bun:test`. Import from `"bun:test"`. Use `mock()` not `jest.fn()`.
- Custom errors: test `err.name` and constructor fields.
- All Zod schemas use `.strict()`.
- Mock LLM calls through `setLlmAdapterForTest()` from `packages/agent-core/src/llm`; do not use per-module AI SDK seams.
