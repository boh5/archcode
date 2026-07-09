# ArchCode

> **Not just a coding agent. An always-on workbench for AI engineering.**

ArchCode is a self-hosted workbench for long-running AI coding work. Deploy it on your server, connect it to your own models, add your projects, and let AI agents plan, build, review, and wait for your approval around the clock.

Unlike a coding CLI that runs a task and exits, ArchCode keeps the engineering workspace alive: projects, sessions, goals, approvals, reviews, evidence, memory, and agent activity are all available from a Web UI.

## What ArchCode gives you

- **Always-on server runtime** — run ArchCode on a local machine or remote server and keep coding work moving even when your terminal is closed.
- **Web workbench** — manage projects, sessions, goals, loops, approvals, and reviews from a browser.
- **AI engineering workflow** — describe a goal, let agents plan and build, then review evidence before accepting the result.
- **Human-in-the-loop control** — approve sensitive actions, answer agent questions, and inspect what changed.
- **Bring your own models** — configure OpenAI-compatible providers and choose models per agent role.
- **Self-hosted by default** — your workspaces stay on the machine where ArchCode runs.

## Quick start

### 1. Install dependencies

ArchCode uses [Bun](https://bun.sh/) and a Turborepo workspace.

```sh
bun install
```

### 2. Configure models

Create `.archcode.json` in the repository root. This minimal example uses an OpenAI-compatible local provider and assigns the same model to all six built-in agent roles:

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

Provider IDs and model IDs combine as `provider:modelId`, such as `local:glm-5`. Environment variable expansion supports `${VAR}` and `${VAR:-default}`.

### 3. Start ArchCode

For local development or a quick trial:

```sh
bun run dev
```

This starts the Hono API/SSE server and the React Web UI. By default, the server listens on port `4096`, and the Vite web app proxies API calls during development.

For a production build:

```sh
bun run build
./dist/archcode
```

Then open the Web UI in your browser and add a project workspace.

## Using the workbench

1. **Add a project** — register an existing workspace directory from the Web UI.
2. **Start a session or goal** — describe the engineering work you want done.
3. **Let agents work** — ArchCode coordinates planning, building, exploration, documentation lookup, and review.
4. **Approve when needed** — sensitive actions can pause for human approval instead of running silently.
5. **Review evidence** — inspect diffs, tool output, tests, reviewer summaries, and session history before accepting work.
6. **Keep it running** — leave ArchCode online so long-running coding work can continue across sessions.

## Agent roles

ArchCode ships with six specialized roles:

| Agent | Role |
|---|---|
| Orchestrator | Coordinates work, manages sessions, delegates to other agents |
| Plan | Analyzes requirements and creates execution plans |
| Build | Edits files, runs tools, and implements changes |
| Reviewer | Checks completed work and validates evidence |
| Explore | Searches and reads the local codebase |
| Librarian | Looks up documentation and external references |

You configure the model for each role in `.archcode.json`.

## Server settings

| Variable | Default | Description |
|---|---|---|
| `ARCHCODE_PORT` | `4096` | Hono server port. If unavailable, ArchCode falls back to an ephemeral port. |
| `ARCHCODE_SERVER_PASSWORD` | unset | Enables Basic auth for `/api/*` when set. Set this for remote deployments. |
| `ARCHCODE_HOST` | unset | Externally advertised host for deployments or clients that need it. |
| `ARCHCODE_OPEN_BROWSER` | unset | Reserved for opening the Web UI automatically when the server boots. |
| `ARCHCODE_PROJECTS_DIR` | unset | Base directory used by project-selection flows. |
| `GITHUB_TOKEN` | unset | Fallback token for GitHub integration when configured. |
| `GH_TOKEN` | unset | Secondary GitHub token fallback. `GITHUB_TOKEN` wins when both are set. |

## GitHub integration

GitHub support is optional and configured through `.archcode.json`:

```json
{
  "integrations": {
    "github": {
      "enabled": true,
      "tokenEnv": "ARCHCODE_GITHUB_TOKEN"
    }
  }
}
```

Authentication is environment-variable based. Do not put raw tokens in `.archcode.json`.

## Configuration notes

- `.archcode.json` uses strict validation; unknown fields are rejected.
- The `agents` section must include `orchestrator`, `plan`, `build`, `reviewer`, `explore`, and `librarian`.
- Model options use AI SDK-style camelCase names, such as `maxOutputTokens`, `temperature`, `topP`, `topK`, `timeout`, and `providerOptions`.
- Agent options are merged in this order: `model.options → variants[agent.variant] → agents[agent].options`.
- `providerOptions` is shallow-replaced by later layers, not deep-merged.

## Self-hosting notes

ArchCode can run on a remote server so it stays available while agents work. For any non-local deployment:

- Set `ARCHCODE_SERVER_PASSWORD`.
- Put ArchCode behind HTTPS or a trusted reverse proxy.
- Keep `.archcode.json` and environment variables private.
- Register only project directories you intend ArchCode to access.

## Contributing

Development setup, architecture notes, testing conventions, and pull request guidance live in [CONTRIBUTING.md](./CONTRIBUTING.md).
