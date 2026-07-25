# ArchCode

> **Not just a coding agent. An always-on workbench for AI engineering.**

ArchCode is a self-hosted workbench for long-running AI coding work. Deploy it on your server, connect it to your own models, add your projects, and let AI agents plan, build, review, and wait for your approval around the clock.

Unlike a coding CLI that runs a task and exits, ArchCode keeps the engineering workspace alive: projects, sessions, their optional persistent Goals, approvals, reviews, evidence, memory, and agent activity are all available from a Web UI.

## What ArchCode gives you

- **Always-on server runtime** — run ArchCode on a local machine or remote server and keep coding work moving even when your terminal is closed.
- **Web workbench** — capture project Todos, discuss them with a restricted Lead, and manage Sessions, Goal progress, Automations, approvals, and reviews from a browser.
- **AI engineering workflow** — describe the outcome naturally; Lead works directly or coordinates bounded specialists and can run an explicitly authorized persistent Session Goal through independent review.
- **Human-in-the-loop control** — approve sensitive actions, answer agent questions, and inspect what changed.
- **Bring your own models** — configure official AI SDK language Providers or custom OpenAI-compatible/Responses endpoints and route work through `principal`, `deep`, and `fast` Profiles.
- **Self-hosted by default** — your workspaces stay on the machine where ArchCode runs.

## Install from a GitHub Release

The Release workflow publishes an immutable installer alongside versioned
archives. It detects macOS/Linux and arm64/x64, verifies the archive against
`SHA256SUMS`, checks the extracted binary version, and installs it to
`~/.local/bin/archcode` without `sudo`:

```sh
curl -fsSL https://github.com/boh5/archcode/releases/latest/download/install.sh | sh
```

The installer only installs the executable: it does not edit `~/.archcode`,
modify your shell, create a service, or change server authentication. If
`~/.local/bin` is not on `PATH`, it prints the exact export to add.

Installer options can select a release or installation prefix:

```sh
curl -fsSL https://github.com/boh5/archcode/releases/latest/download/install.sh \
  | sh -s -- --version 0.0.3 --prefix "$HOME/.local"
```

Use `--dry-run` to inspect the resolved platform, asset, and destination
without downloading or changing files.

Each new Release contains these archives:

| System | Architecture | Release asset pattern |
|---|---|---|
| macOS 13 or newer | Apple silicon (arm64) | `archcode-macos-arm64-vVERSION.tar.gz` |
| macOS 13 or newer | Intel (x64) | `archcode-macos-x64-vVERSION.tar.gz` |
| Linux with glibc 2.17 or newer | arm64 | `archcode-linux-arm64-vVERSION.tar.gz` |
| Linux with glibc 2.17 or newer | x64 | `archcode-linux-x64-vVERSION.tar.gz` |
| Windows 10/11 | WSL2 | Use the Linux archive matching the WSL architecture |

To install an archive manually, download it from the
[GitHub Releases page](https://github.com/boh5/archcode/releases), then verify
and extract it. For example, for the Apple silicon release:

```sh
version=0.0.3
asset="archcode-macos-arm64-v${version}.tar.gz"
curl -fLO "https://github.com/boh5/archcode/releases/download/v${version}/${asset}"
curl -fLO "https://github.com/boh5/archcode/releases/download/v${version}/SHA256SUMS"
grep "  ${asset}$" SHA256SUMS | shasum -a 256 -c -
tar -xzf "$asset"
mkdir -p "$HOME/.local/bin"
install -m 755 archcode "$HOME/.local/bin/archcode"
"$HOME/.local/bin/archcode" --version
```

Linux users can replace `shasum -a 256` with `sha256sum`. Each Release also
includes `release-manifest.json`, which records the platform, architecture,
archive size/digest, and embedded binary size/digest.

The macOS binary is a command-line server, not an app bundle, and is not
currently signed or notarized. The installer downloads it with `curl`, verifies
the official checksum, and extracts it in the terminal. It does not bypass
Gatekeeper or remove quarantine attributes.

On Windows, install WSL2 and run ArchCode inside the Linux environment. Its
configuration lives at `~/.archcode/config.json` inside WSL, while a Windows
browser can open `http://localhost:4096`. Keep registered repositories in the
WSL Linux filesystem for reliable permissions and better filesystem
performance. Native Windows execution is not supported in this release.

### First run

Run `archcode` without preparing a configuration file. When
`~/.archcode/config.json` is missing, the server prints a one-time Setup URL.
Open that URL to configure the first Provider, Model, all three required
Profiles, and an optional server password. ArchCode then activates the full
workbench on the same port without restarting.

If a Config already exists but is invalid, ArchCode shows a read-only error
instead of reopening Setup or overwriting the file.

For advanced or automated provisioning, you may still create the single
server-wide `~/.archcode/config.json` before startup. Project directories are
never searched for configuration. This minimal example uses a custom
OpenAI-compatible local endpoint and assigns the same model to all three
required Profiles:

```json
{
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Local GLM",
      "options": {
        "baseURL": "http://localhost:8090/v1",
        "apiKey": "local-dev-key"
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
  "profiles": {
    "principal": { "model": "local:glm-5" },
    "deep": { "model": "local:glm-5" },
    "fast": { "model": "local:glm-5" }
  }
}
```

Provider IDs and model IDs combine as `provider:modelId`, such as `local:glm-5`. The ID is the runtime namespace; `provider.name` is display-only. Provider factory options are literal JSON values and are not expanded from environment-variable expressions. See [provider configuration](docs/configuration.md) for all supported packages, secret handling, and custom endpoints.

You can download the versioned `config.example.json` from the source tag as a
starting point:

```sh
version=0.0.3
mkdir -p ~/.archcode
curl -fL "https://raw.githubusercontent.com/boh5/archcode/v${version}/config.example.json" \
  -o ~/.archcode/config.json
chmod 600 ~/.archcode/config.json
```

Replace the placeholder endpoint, API key, model ID, and limits before starting
ArchCode.

The Web UI edits the same global file from **Settings → Models / Profiles**. Saving validates, prepares, atomically writes, and immediately applies Models and Profile defaults. MCP, Memory, and GitHub integration changes are reported as the precise restart-required sections. Direct edits to the file have no watcher; save through Settings or restart to load them.

The optional password is configured only through first-run Setup or
**Settings → Security**. ArchCode stores an Argon2id password hash in the Config
and uses an HttpOnly, process-local Session cookie. No password means no login;
there is no local-versus-remote behavior branch.

### Start ArchCode

```sh
archcode
```

By default, ArchCode listens on port `4096`. Open
`http://localhost:4096` in your browser and add a project workspace.
Choose another port with:

```sh
archcode --port 5096
```

`--port` takes precedence over `ARCHCODE_PORT`. If the selected port is already
in use, startup fails with an actionable error instead of silently switching to
a random port.

## Develop from source

ArchCode uses [Bun](https://bun.sh/) and a Turborepo workspace.

```sh
bun install
bun run dev
```

For a local production build:

```sh
bun run build
./dist/archcode
```

Development mode starts the Hono API/SSE server and the React Web UI through
Vite. The Vite app proxies API calls to the server.

## Using the workbench

1. **Add a project** — register an existing workspace directory; ArchCode opens its Todos board by default.
2. **Capture and shape intent** — record an Idea, enter its restricted Lead Discussion, then mark it Ready or Rejected.
3. **Start a Session** — hand a Ready Todo to a fresh Lead Session or an Automation, or start directly without a Todo.
4. **Let agents work** — describe the desired result in conversation. Lead works directly on simple tasks and delegates bounded analysis, implementation, local exploration, or documentation research when useful. A persistent Goal starts only after explicit user authorization.
5. **Approve when needed** — sensitive actions can pause for human approval instead of running silently.
6. **Review evidence** — inspect diffs, tool output, tests, Analyst review summaries, and Session history before accepting work.
7. **Keep it running** — leave ArchCode online so long-running coding work can continue across sessions.

## Worktree isolation

ArchCode keeps project ownership separate from execution location: a Session is
always stored under its registered project, while its working directory can be
the canonical checkout or a registered worktree from the same Git repository.
All file, shell, Git, Skill, and LSP tools use that Session working directory;
the Session Goal, Automation, HITL, memory, and Session state remain owned by the project root.
This is working-directory and Git-branch isolation, not an operating-system
sandbox: the normal permission policy still governs commands and explicit path
access outside the worktree.

- An ordinary root Session can enter or exit a worktree when the user explicitly
  asks. The Agent capability surface exposes only enter/exit transitions; it
  does not provide worktree list or remove tools.
- An Automation may create an ordinary Session in a dedicated worktree. That
  worktree remains owned by the Session and follows the normal Session lifecycle.
- Git worktree lifecycle changes go through ArchCode's shared worktree service,
  so ownership checks and cleanup policy stay centralized. Agent shell policy
  additionally denies direct worktree enumeration/lifecycle commands and direct
  filesystem writes to Git metadata as defense in depth; this is not an OS
  sandbox boundary.

## Agent roles

ArchCode ships with five stable Agent identities. Profiles choose model resources; Skills provide task-specific methods without changing permissions.

| Agent | Role |
|---|---|
| Lead | Owns the user relationship, direct work, delegation, Goal control, integration, and delivery |
| Analyst | Performs source-read-only deep analysis, planning support, and independent review |
| Build | Edits files, runs tools, and implements changes |
| Explore | Searches and reads the local codebase |
| Librarian | Looks up documentation and external references |

Root Lead defaults to `principal`; Analyst uses `deep`; Explore and Librarian use `fast`; Lead chooses `deep` or `fast` for each Build delegation. A root Lead Session can override its next model selection without changing Agent identity.

## Server settings

| Variable | Default | Description |
|---|---|---|
| `ARCHCODE_PORT` | `4096` | Hono server port. `--port` takes precedence; startup fails if the selected port is unavailable. |
| `ARCHCODE_LOG_LEVEL` | `info` | Minimum structured log level: `debug`, `info`, `warn`, or `error`. |
| `ARCHCODE_ACCESS_LOG` | `on` | Enables (`on`) or disables (`off`) HTTP access logs without hiding other application logs. |
| `ARCHCODE_HOST` | unset | Externally advertised host for deployments or clients that need it. |
| `ARCHCODE_OPEN_BROWSER` | unset | Reserved for opening the Web UI automatically when the server boots. |
| `ARCHCODE_PROJECTS_DIR` | unset | Base directory used by project-selection flows. |
| `GITHUB_TOKEN` | unset | Fallback token for GitHub integration when configured. |
| `GH_TOKEN` | unset | Secondary GitHub token fallback. `GITHUB_TOKEN` wins when both are set. |

HTTP `2xx`, `3xx`, and `4xx` access records are Info events; `5xx` records are
Error events. To keep application Info logs while disabling only request
records, start ArchCode with:

```sh
ARCHCODE_ACCESS_LOG=off archcode
```

Invalid logging values fail startup before the Runtime is initialized.

## GitHub integration

GitHub support is optional and configured through `~/.archcode/config.json`:

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

GitHub authentication is environment-variable based. Do not put raw GitHub tokens in `~/.archcode/config.json`.

Custom MCP servers use the current HTTP-only configuration shape without a transport selector:

```json
{
  "mcp": {
    "servers": {
      "internal-docs": {
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer ${MCP_TOKEN}" },
        "timeout": 30000
      }
    }
  }
}
```

## Configuration notes

- `~/.archcode/config.json` uses strict validation; unknown fields are rejected.
- The `profiles` section must contain exactly the required `principal`, `deep`, and `fast` entries.
- All configured models use the same Prompt contracts. Provider and model differences stay in API call options rather than branching Prompt behavior.
- Model options use AI SDK-style camelCase names, such as `maxOutputTokens`, `temperature`, `topP`, `topK`, `timeout`, and `providerOptions`.
- Settings edits model options, complete variant maps, and per-Profile overrides as validated JSON objects; provider-specific call settings belong under `providerOptions`.
- ArchCode owns LLM recovery and disables AI SDK retries internally.
- Profile-default options are merged in this order: `model.options → variants[profile.variant] → profiles[profile].options`. A Session override resolves independently and does not inherit Profile options.
- `providerOptions` is shallow-replaced by later layers, not deep-merged.
- MCP URLs and headers retain their existing `${VAR}` / `${VAR:-default}` expansion; Provider options do not use this expansion.
- Provider factory options are generic JSON for the selected package. Provider secrets, including API keys and custom header/query values declared by that adapter, are redacted by Settings and must be explicitly preserved, replaced, or deleted.
- A Composer or root Lead Session model choice applies to the next Execution only. A running Execution keeps its immutable binding and model-runtime revision. When a queued Execution starts, an invalid requested selection falls back to a valid Session override, then that Session's Profile default. ArchCode never changes a running or failed model call to another model automatically.

Prompt live evaluation is explicit and opt-in. Copy `packages/agent-core/src/prompt/live-eval-manifest.example.json`, list only the configured `provider:model` IDs to run, then execute:

```sh
ARCHCODE_PROMPT_LIVE_EVAL=1 bun run prompt:live-eval -- --manifest ./prompt-live-eval.json
```

The command compiles the same real Prompt V2 for each explicitly listed model and writes machine-readable results to the manifest's `resultPath`. It never guesses or automatically selects models.

## Self-hosting notes

ArchCode can run on a remote server so it stays available while agents work. For any non-local deployment:

- Enable **Require login** during Setup, or set a password later in
  **Settings → Security**.
- Put ArchCode behind HTTPS or a trusted reverse proxy. Preserve the browser's
  original `Host` header (for Nginx: `proxy_set_header Host $http_host;`);
  ArchCode deliberately does not trust `X-Forwarded-*`. If the proxy replaces
  `Host` with its upstream address, same-origin Setup, login, and mutation
  requests fail with `403`.
- Keep `~/.archcode/config.json` and environment variables private. The configuration file should be readable and writable only by the server user (`0600`).
- Register only project directories you intend ArchCode to access.
- Use a single ArchCode server process as the writer for a registered project.
  Repository lifecycle and durable queue locks are process-local in this version.

## Contributing

Development setup, architecture notes, testing conventions, and pull request guidance live in [CONTRIBUTING.md](./CONTRIBUTING.md).
