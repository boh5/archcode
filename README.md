# ArchCode

> **Not just a coding agent. An always-on workbench for AI engineering.**

Plan project work, run native coding Agents, and manage Todos, Sessions,
approvals, and results from one Web UI.

ArchCode is open-source and self-hosted. Run it on any machine you control —
your laptop, workstation, home server, or VPS. The Agent runtime and workbench
live together where ArchCode runs: this is not a remote wrapper around Claude
Code or Codex.

**Run locally or on an always-on machine. Same Web workbench.**

[![ArchCode always-on workbench demo](docs/assets/archcode-readme-demo.gif)](docs/assets/archcode-readme-demo.mp4)

*A 15-second tour of real Todos, multiple Sessions, human control points, and
verified results. Click for the full-resolution MP4.*

## Quick start

### 1. Install

```sh
curl -fsSL https://github.com/boh5/archcode/releases/latest/download/install.sh | sh
```

The installer downloads the correct macOS or Linux binary, verifies its
checksum, and installs it without `sudo`. Installer-managed copies can later
update from **Settings → About & Updates** or `archcode update`. If
`~/.local/bin` is not on `PATH`, follow the exact instruction printed by the
installer.

### 2. Start

```sh
archcode
```

### 3. Open the workbench

Open [http://localhost:4096](http://localhost:4096). On first run, the browser
setup guides you through connecting a model and optionally protecting the
workbench with a password.

### 4. Add a project

Choose an existing project directory and start a Session. ArchCode works with
the files and Git repository already on the machine where it runs.

Need another platform, manual verification, or a remote deployment? See the
[installation](docs/installation.md) and [deployment](docs/deployment.md)
guides.

## Why ArchCode

- **Organize project work** — capture Todos, shape ideas, and keep multiple
  Sessions moving without reducing the project to one chat.
- **Keep the workbench available** — projects, Sessions, approvals, results,
  memory, and Agent activity stay together while ArchCode remains online.
- **Run it where you want** — use ArchCode on your laptop, workstation, home
  server, or VPS.
- **Open it from a browser** — return to the same workbench from any device that
  can securely reach the machine running ArchCode.
- **Use a native Agent runtime** — ArchCode runs its own Agent loop instead of
  remotely controlling another coding CLI.
- **Stay in control** — monitor work, add instructions, answer questions,
  approve sensitive actions, or stop an Execution.
- **Bring your own models** — connect official AI SDK providers, custom
  OpenAI-compatible endpoints, or Responses-compatible endpoints.
- **Self-host the workbench** — the runtime, registered workspaces, Session
  state, and memory stay on infrastructure you control.

## Run it your way

| Where ArchCode runs | Good for | How you open it |
|---|---|---|
| Laptop | The fastest way to try ArchCode and work with local projects | `http://localhost:4096` |
| Workstation or Mac mini | More compute, local-network access, or an always-on personal machine | A browser on the same machine or trusted network |
| Home server or VPS | Remote access and long-running work on a machine that stays online | HTTPS or a trusted reverse proxy |

ArchCode uses the same server runtime and Web UI in every deployment. You
choose where it runs.

## How the workbench works

1. **Add a project** — register an existing project directory.
2. **Start a Session** — describe the outcome you want in ordinary language.
3. **Let the Lead work** — it works directly or delegates bounded analysis,
   implementation, codebase exploration, or documentation research when useful.
4. **Stay involved** — inspect progress, add instructions, answer questions,
   approve sensitive actions, or stop the current Execution.
5. **Review the result** — inspect diffs, tool output, tests, review summaries,
   and Session history before accepting the work.

For work that needs a durable objective, an explicitly authorized Session Goal
can keep the same Lead focused across continuations. Automations can start
Sessions on a schedule. Both are optional; ordinary Sessions remain the default.

Learn the product vocabulary in [workbench concepts](docs/concepts.md).

## Native Agent runtime, not a remote CLI wrapper

Some remote coding tools connect a mobile or Web client to an existing Claude
Code or Codex process. ArchCode takes a different approach: its server owns the
Agent runtime, projects, Sessions, tools, approvals, memory, and execution
state. The browser is the control interface, not the place where the Agent runs.

ArchCode does not claim to make the underlying model smarter. Its role is to
give coding Agents a self-hosted runtime and a persistent Web workbench.

## What is included

- Project Todos and a multi-Session workbench
- Native Lead, Analyst, Build, Explore, and Librarian Agent identities
- Structured file, shell, Git, search, LSP, Web, memory, and MCP tools
- Human approval and question flows
- Session steering, queued messages, stopping, and durable history
- Optional persistent Goals and scheduled Automations
- Diffs, tool evidence, test output, and review summaries
- Project memory, context compaction, and model Profiles
- Git worktree execution when explicitly requested
- Signed direct updates with an idle-only graceful restart

## Know before you self-host

- ArchCode is currently designed for a single private operator, not a
  multi-user team deployment.
- Remote deployments require authentication and HTTPS or a trusted reverse
  proxy.
- Git worktrees provide Git-level separation, not an operating-system sandbox.
- Registered workspace files stay on the machine running ArchCode, but external
  model providers receive the context required for model calls.
- ArchCode can continue work while a browser is closed as long as its process
  and machine remain running. An active Execution does not survive a server
  process restart in the current release.
- macOS binaries are not currently signed or notarized. Windows is supported
  through WSL2; native Windows execution is not yet available.

Read the full [security and trust boundaries](docs/security.md) before exposing
ArchCode outside a trusted machine or network.

## Documentation

- [Installation and platform support](docs/installation.md)
- [Local and remote deployment](docs/deployment.md)
- [Provider and model configuration](docs/configuration.md)
- [Workbench concepts](docs/concepts.md)
- [GitHub and MCP integrations](docs/integrations.md)
- [Security and trust boundaries](docs/security.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Contributing

Contributions are welcome. Development setup, architecture notes, testing
conventions, and pull request guidance live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

ArchCode is available under the [MIT License](LICENSE).
