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
Ordinary user work starts in a root Lead Session. A Todo Discussion starts in a
root Discussion Session dedicated to shaping that Todo and its optional Plan.
The Session keeps its model Profile, working directory, messages, tool activity,
approvals, and terminal state.

## Execution

An Execution is one accepted unit of logical work inside a Session. It begins
with a new user, Goal, or child-task input and keeps the same `executionId`
until it truly completes, fails, or is stopped. A permission/question pause and
a synchronous child pause suspend that Execution; answering or finishing the
child resumes it instead of creating a continuation Execution.

One Execution can have several active run spans. A span owns live resources and
one resolved model binding, which stays fixed for that span. A later resume may
resolve the current Session/Profile model again and therefore use a new binding
without changing the logical Execution. Queued new input waits for the current
Execution to end, then starts a new one.

The workbench may show one Execution as several Work Segments. Each canonical
UserMessage (including Steer) starts exactly one Segment in persisted message
order, even when adjacent inputs have no intervening work. Commentary,
Reasoning, and tools remain ordered inside that Segment's Work disclosure;
only persisted `outputPhase: "final_answer"` output appears below Work.
Reasoning usage belongs to its individual model attempt, never to a synthetic
Execution-wide Reasoning item. Segments are independent display and navigation
projections only: they do not create, persist, or schedule Executions.

## Todo

Project Todos are optional, project-owned entries for anything you may want to
build, fix, investigate, or improve. A new Todo starts as an Idea. You can open
a dedicated Discussion to clarify and shape it, then freely organize it among
Idea, Ready, In Progress, and Done; Rejected and Archived are separate from the
main board.

When a Todo needs a Plan, **Generate / Improve Plan** opens or reuses its latest
Discussion and maintains one ordinary Markdown file at
`.archcode/plans/<todo-id>.md`. A newly created Discussion accepts Plan work as
its first message, so the UI does not race a generic Discussion execution with
a second Plan command. A Ready or In Progress Todo can start any number of fresh
ordinary Lead work Sessions or an Automation setup Session. At that one start
boundary, ArchCode checks whether the Plan file exists: if it does, the Lead
begins with `execute-plan`; otherwise it follows the ordinary work path.
Starting work from Ready moves the Todo to In Progress; opening or continuing
an existing Session does not change the Todo. Each direct root Session keeps
its own immutable Todo source, while an Automation keeps its own optional Todo
association. The Todo itself never stores Session, Plan, or Automation IDs. You
can also start a Session directly without creating a Todo.

## Goal

A Goal is an optional persistent objective attached to a root Lead Session. It
starts only after explicit user authorization. Each distinct Goal continuation
can start a new Execution; an in-progress Execution may suspend for human input
or a synchronous child and later resume with the same ID. The Goal finishes
only after the required review gate.

Ordinary requests do not create Goals automatically.

## Automation

An Automation is a durable schedule that starts ordinary Sessions for a
project. It is useful for recurring work; it does not replace a Session or own
the conversation.

## Agent identities

ArchCode ships with five execution and collaboration identities plus a dedicated
user-facing Discussion identity:

| Agent | Responsibility |
|---|---|
| Lead | User entry point, direct work, delegation, integration, and delivery |
| Discussion | Shapes one bound Todo and its optional Plan; does not implement the work |
| Analyst | Read-only deep analysis, planning support, and review |
| Build | File changes, commands, and implementation |
| Explore | Local codebase search and inspection |
| Librarian | Documentation and external reference research |

The Lead works directly when possible and delegates bounded work when a
specialized responsibility is useful.

## Profiles and Skills

Profiles choose model resources. ArchCode requires `principal`, `deep`, and
`fast` Profiles so different kinds of work can use intentional model budgets.
Root Lead and Discussion default to `principal`; Analyst uses `deep`; Explore
and Librarian use `fast`; Build can use `deep` or `fast`. Profiles do not change
Agent tools or authority.

Skills provide task-specific working methods. They guide behavior without
granting additional tools or permissions.

## Approvals and questions

Sensitive actions can pause for explicit approval. Agents can also ask a
question when a decision or missing context blocks useful progress. Both flows
are visible in the Web workbench; their response is applied to the original
tool call and resumes the same logical Execution.

## Worktrees

An ordinary root Lead Session can enter or exit a Git worktree when explicitly
requested. The Session still belongs to its Project while its tools operate in
the selected working directory.

Worktrees provide Git branch and working-directory separation, not
operating-system isolation. See [security and trust boundaries](security.md).
