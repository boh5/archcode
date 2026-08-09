# ArchCode

> **An open-source cloud workbench for AI coding.**

Self-host it on your own machine or server. Capture ideas as Todos, run
specialized Agents, and manage their work from any browser.

[![ArchCode project workbench demo](docs/assets/archcode-readme-demo.gif)](docs/assets/archcode-readme-demo.mp4)

*A 15-second tour from Project Todos to multiple Sessions, human decisions, and
verified results. Click for the full-resolution MP4.*

## Give every project idea somewhere to go

1. **Capture an idea** — save anything you may want to build, fix, investigate,
   or improve as a Project Todo.
2. **Shape the work** — discuss the Todo with an Agent until the scope and
   expected outcome are clear; generate or refine its single Markdown Plan when
   the work needs one.
3. **Mark it Ready** — keep rough ideas separate from work that is ready to run.
4. **Start the work** — launch a fresh Lead Session or an Automation from the
   Todo.
5. **Review the result** — follow the work, handle decisions, inspect the
   evidence, and mark the Todo Done.

Project Todos are optional. You can always start an ordinary Session directly.

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

Choose an existing project directory. Capture an idea as a Todo or start a
Session directly. ArchCode works with the files and Git repository already on
the machine where it runs.

Need another platform, manual verification, or a remote deployment? See the
[installation](docs/installation.md) and [deployment](docs/deployment.md)
guides.

## Keep multiple pieces of work moving

Register multiple existing workspaces and return to them from the same Web
workbench. Within each Project, keep multiple Sessions for different pieces of
work. Each Session retains its own conversation, model selection, working
directory, tool activity, approvals, execution state, and history.

Work on a feature, investigate a bug, review a change, and shape the next idea
without mixing everything into one conversation.

## Specialized Agents, clear responsibilities

| Agent | Responsibility | Model Profile |
|---|---|---|
| Lead | Owns the outcome, works directly, and coordinates other Agents | `principal` |
| Discussion | Shapes one Todo and its optional Plan without implementing it | `principal` |
| Analyst | Deep analysis, planning support, and review | `deep` |
| Build | Implementation and verification | `deep` or `fast` |
| Explore | Fast codebase investigation | `fast` |
| Librarian | Documentation and external research | `fast` |

The Lead delegates bounded responsibilities when specialized work is useful.
Each Agent identity has its own tools, delegation rules, and authority.

## Different jobs. Different models.

ArchCode separates Agent responsibility from model choice. Configure
`principal`, `deep`, and `fast` Profiles, then use stronger models where
judgment matters and fast or local models for exploration and routine work.

Connect official AI SDK providers, custom OpenAI-compatible endpoints, or
Responses-compatible endpoints. A user-facing root Session can also override
its model without changing the Agent's tools or responsibility. See [provider and model
configuration](docs/configuration.md).

## Stay in control

Follow active work from the Web workbench, add instructions while it runs, queue
the next message, answer questions, approve sensitive actions, or stop an
Execution.

Before accepting the result, inspect file changes, tool output, test results,
review summaries, and the complete Session history. Work runs on the ArchCode
host rather than in the browser, so closing the page does not cancel an active
Execution while the process and machine remain running.

## Goals and Automations

Use a Goal when the same Lead needs to stay focused on an objective across
multiple Executions and human checkpoints. A Goal completes only after its
required review gate.

Use an Automation when work should start once or on a recurring schedule. Goals
and Automations are optional; both remain visible through Sessions inside the
same workbench.

## Durable, inspectable memory

ArchCode keeps personal preferences and project knowledge as ordinary Markdown.
Explicit requests to remember something are saved immediately through the
Memory tool. Other durable context is considered only after a successful root
conversation has been idle for 10 minutes, then reconciled against the complete
Memory files it actually affects. Settings → Memory lets you inspect, edit,
delete, disable recall, or opt out of automatic learning without deleting data.

## Run it your way

| Where ArchCode runs | Good for | How you open it |
|---|---|---|
| Laptop | The fastest way to try ArchCode and work with local projects | `http://localhost:4096` |
| Workstation or Mac mini | More compute, local-network access, or an always-on personal machine | A browser on the same machine or trusted network |
| Home server or VPS | Remote access and long-running work on a machine that stays online | HTTPS or a trusted reverse proxy |

ArchCode uses the same server runtime and Web UI in every deployment. You
choose where it runs.

## A native Agent runtime

ArchCode runs its own Agent loop rather than remotely controlling an existing
Claude Code, Codex, or another coding CLI process. Its server owns Agent
execution, projects, Sessions, tools, approvals, memory, and durable state. The
browser is the control interface, not the place where the Agent runs.

ArchCode does not claim to make the underlying model smarter. It gives models a
self-hosted runtime, specialized responsibilities, and a persistent project
workbench.

## Built in

- Structured file, shell, Git, search, LSP, Web, memory, and MCP tools
- Built-in and project workflow Skill packages for Todo shaping, planning,
  review, and repeatable working methods
- Project memory and context compaction
- Optional Git worktree execution
- GitHub and custom MCP integrations
- Signed direct updates with an idle-only graceful restart

Learn the product vocabulary in [workbench concepts](docs/concepts.md).

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
- [Security vulnerability reporting](SECURITY.md)
- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Contributing

Contributions are welcome. Development setup, architecture notes, testing
conventions, and pull request guidance live in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

ArchCode is available under the [MIT License](LICENSE).
