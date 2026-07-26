# Security and trust boundaries

ArchCode is a self-hosted coding Agent runtime with access to registered source
workspaces. Treat the process as a powerful development tool, not as an
untrusted public Web application.

## Intended deployment

The current product is designed for a single private operator. It provides an
optional instance password and bounded browser Sessions, but it does not
provide multi-user accounts, teams, SSO, RBAC, or tenant isolation.

For remote access:

- require login;
- use HTTPS or a trusted reverse proxy;
- restrict network access;
- preserve the original `Host` header;
- run only one ArchCode writer process for a registered project.

## Authentication

Set, change, or remove the optional password through first-run Setup or
**Settings → Security**. ArchCode stores an Argon2id password hash in the
server Config and uses an HttpOnly, process-local Session cookie.

No password means no login. ArchCode does not automatically enable different
authentication behavior merely because a connection is remote.

## Workspace access

Register only project directories that ArchCode should access. Agent file,
shell, Git, Skill, and LSP tools run against the active Session working
directory and are governed by ArchCode's permission and path policies.

Project runtime authority state lives under `.archcode/runtime`. Agent mutation
tools deny writes to that tree and to Git metadata; system services use their
own writers.

## Worktrees are not sandboxes

A Session can work in the canonical checkout or an explicitly registered Git
worktree. This separates working directories and branches. It does not provide
container, virtual-machine, user-account, or operating-system isolation.

Shell commands still execute on the host under the ArchCode process user.
Review sensitive approvals and use OS-level isolation when the project or model
requires a stronger boundary.

## Model data flow

Registered workspace files remain on the machine running ArchCode. Model calls
still send the Prompt, selected code context, and tool results required by the
Agent to the configured model provider.

Using an external provider therefore does not mean that all code context stays
on the host. Use a provider and data policy appropriate for the repository.
Custom local or private endpoints can be configured when required.

## Secrets

Keep `~/.archcode/config.json` and its environment variables private. The Config
should be readable and writable only by the server user (`0600`).

Provider credentials are literal private Config values. Settings redacts
adapter-declared secrets in API snapshots and requires explicit preservation,
replacement, or deletion. GitHub and MCP integrations can resolve tokens and
headers from environment variables.

Do not register repositories containing secrets that the selected model
provider is not permitted to receive.

## Runtime continuity

Closing a browser does not stop an active Execution while the ArchCode process
and machine remain running. A server process restart currently interrupts the
active Execution. Persisted Session history and durable project state remain
available after restart.

ArchCode does not currently provide a browser-closed Web Push service. Open the
workbench to view pending questions and approvals.
