# Workbench concepts

ArchCode is an open-source, self-hosted workbench for AI coding. Projects
contain Todos, Sessions, and Automations. A Todo records project work you want
done. A Session is where an Agent discusses or carries out that work. An
Automation starts work once or on a recurring schedule. Use these concepts
together, or start an ordinary Session directly.

## Project

A Project is an existing workspace directory registered on the machine running
ArchCode. Its Todos, Sessions, Automations, approvals, history, and
project-scoped memory stay together in the workbench.

## Todo

A Project Todo records one piece of work you may want to build, fix,
investigate, or improve. A new Todo starts as an Idea. You can open a dedicated
Discussion to clarify it, attach an optional Plan, and move it among Idea,
Ready, In Progress, and Done. Rejected and Archived remain outside the main
workflow.

When a Todo needs a Plan, **Generate / Improve Plan** reuses its latest
Discussion only when that Session is idle and maintains one ordinary Markdown
file at `.archcode/plans/<todo-id>.md`. If no Discussion exists, the latest one
is busy or suspended, it was deleted, or an idle reuse loses the acceptance
race, ArchCode creates a new Discussion with Plan work as its first message.
The UI never races a generic Discussion execution with a second Plan command.
A Ready or In Progress Todo can start any number of fresh ordinary Lead work
Sessions or an Automation setup Session. At that one start boundary, ArchCode
checks whether the Plan file exists: if it does, the Lead begins with
`execute-plan`; otherwise it follows the ordinary work path. Starting work from
Ready moves the Todo to In Progress; opening or continuing an existing Session
does not change the Todo. Each direct root Session keeps its own immutable Todo
source, while an Automation keeps its own optional Todo association. The Todo
itself never stores Session, Plan, or Automation IDs.

**Run now** creates a minimal In Progress Todo and its first bound Lead Session
in one step. It skips Discussion and Plan without preventing you from adding
either later. You can also start a Session directly without creating a Todo.

## Session

A Session contains one Agent's conversation and execution history. Ordinary
user work starts in a root Lead Session. A Todo Discussion starts in a root
Discussion Session dedicated to shaping that Todo and its optional Plan. The
Session keeps its model Profile, working directory, messages, tool activity,
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

## Automation

An Automation starts or resumes project work once or on a recurring schedule.
It creates a root Lead Session or sends a message to an existing Session; it
does not replace a Session or own the conversation.

## Goal

A Goal is an optional persistent objective attached to a root Lead Session. It
starts only after explicit user authorization. Each distinct Goal continuation
can start a new Execution; an in-progress Execution may suspend for human input
or a synchronous child and later resume with the same ID. The Goal finishes
only after the required review gate.

Ordinary requests do not create Goals automatically.

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
