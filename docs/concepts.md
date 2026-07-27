# Workbench concepts

ArchCode organizes AI coding work around Projects, Project Todos, and persistent
Sessions. Capture and shape an idea as a Todo, start the work in a Session, and
keep its execution history and human decisions together. You can also start
with an ordinary Session and adopt the other concepts only when they solve a
real need.

## Project

A Project registers an existing absolute workspace directory on the machine
running ArchCode. It keeps that workspace's ideas, active work, history, and
control surfaces together through Sessions, Todos, Automations, approvals, and
project-scoped memory.

## Session

A Session is the durable conversation and execution history for one Agent.
Ordinary user work starts in a root Lead Session. The Session keeps its model
Profile, working directory, messages, tool activity, approvals, and terminal
state.

## Execution

An Execution is one active or queued run inside a Session. You can add a message
while work is running, queue follow-up work, stop the current Execution, and
return to the same Session later.

## Todo

Project Todos are optional, project-owned entries for anything you may want to
build, fix, investigate, or improve. A new Todo starts as an Idea. You can open
a dedicated Discussion to clarify and shape it, then mark it Ready or Rejected.

A Ready Todo can start a fresh ordinary Lead Session or an Automation. The
resulting work stays linked to the Todo, which can be marked Done or returned to
Ready. You can also start a Session directly without creating a Todo.

## Goal

A Goal is an optional persistent objective attached to a root Lead Session. It
starts only after explicit user authorization. While active, the same Lead can
continue toward the objective across multiple Executions, pause for human
input, and finish only after the required review gate.

Ordinary requests do not create Goals automatically.

## Automation

An Automation is a durable schedule that starts ordinary Sessions for a
project. It is useful for recurring work; it does not replace a Session or own
the conversation.

## Agent identities

ArchCode ships with five stable Agent identities:

| Agent | Responsibility |
|---|---|
| Lead | User entry point, direct work, delegation, integration, and delivery |
| Analyst | Read-only deep analysis, planning support, and review |
| Build | File changes, commands, and implementation |
| Explore | Local codebase search and inspection |
| Librarian | Documentation and external reference research |

The Lead works directly when possible and delegates bounded work when a
specialized responsibility is useful.

## Profiles and Skills

Profiles choose model resources. ArchCode requires `principal`, `deep`, and
`fast` Profiles so different kinds of work can use intentional model budgets.
Root Lead defaults to `principal`; Analyst uses `deep`; Explore and Librarian
use `fast`; Build can use `deep` or `fast`. Profiles do not change Agent tools
or authority.

Skills provide task-specific working methods. They guide behavior without
granting additional tools or permissions.

## Approvals and questions

Sensitive actions can pause for explicit approval. Agents can also ask a
question when a decision or missing context blocks useful progress. Both flows
are visible in the Web workbench and return control to the same Session.

## Worktrees

An ordinary root Lead Session can enter or exit a Git worktree when explicitly
requested. The Session still belongs to its Project while its tools operate in
the selected working directory.

Worktrees provide Git branch and working-directory separation, not
operating-system isolation. See [security and trust boundaries](security.md).
