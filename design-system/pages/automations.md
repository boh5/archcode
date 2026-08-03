# Automations Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Automations defines recurring or
> repeatable project work. Each `start_session` invocation opens its own durable
> Automation-source Session; `send_message` targets an existing Session without
> changing its source. The Automation definition never replaces Session
> execution history.

## Purpose

Automations lets users define repeated work once, inspect whether it needs
attention, and recover the exact Session associated with every run.

## Structure

- Keep the project rail and project toolbar; `Automations` is the active project
  tab. Do not repeat an `Automations` page title below the toolbar.
- Use one page-local command row with `Filter Automations` on the left and the
  single primary `New Automation` action on the right.
- On wide screens, use a list/detail split: the left side selects one Automation
  and the right side shows its definition, schedule, linked Todo, and recent
  invocation Sessions.
- At `≤840px`, show the list first; selecting one Automation replaces it with
  the detail in the same canvas and exposes a visible back-to-list action. Do
  not introduce a second navigation rail or a modal merely to inspect an
  existing Automation.

## Automation List

- Group rows by decision value: `Needs attention`, `Scheduled`, `Paused`, then
  `Inactive`. Groups are mutually exclusive.
- A latest Invocation with `failed` or `missed` always belongs in `Needs
  attention`, even when the Automation definition is disabled. When no failed or
  missed Invocation overrides it, active definitions belong in `Scheduled`,
  paused definitions in `Paused`, and disabled definitions in `Inactive`.
- Each row shows status orbit, name, concise schedule or latest-run context, and
  the real definition/Invocation state. `dispatched` is not `Completed`; the
  final execution result is read from the linked Session. Use a flat row with
  separators, not a summary card.
- Selection uses the shared indigo selected treatment. Needs-attention state
  keeps explicit text in addition to amber color.
- `Filter Automations` matches stable ID, name, instruction, schedule, linked
  Todo display label or canonical content, and visible run state. Show a
  helpful no-results state in place of the list without hiding the filter or
  New Automation action.

## Selected Detail

- Preserve name, status, stable ID, updated time, instructions, schedule,
  action and its read-only runtime binding, workspace, optional linked Todo, and
  recent runs. Do not expose Agent/Profile as Automation definition fields.
- `Edit` is secondary. `Run now` is the primary action because it dispatches one
  new Invocation without changing the Automation definition; `start_session`
  creates its Automation-source Session and `send_message` targets its existing
  Session.
- Every recent-run row opens its exact Session URL. Never reuse one generic
  Session URL for multiple invocations.
- A linked Todo opens its stable Todo detail URL. Absence of a linked Todo is
  valid and does not make the Automation incomplete.

## New Automation

- Use one focused editor dialog with a visible close action, name, instructions,
  structured trigger/action fields, and timezone when relevant. Do not expose
  an Agent/Profile choice. For `start_session`, show a read-only `Lead +
  principal` binding; `send_message` keeps the target Session's existing
  identity.
- Keep advanced schedule detail progressively disclosed. Do not turn creation
  into a multi-step wizard or require a Todo.
- The dialog may demonstrate creation with prototype feedback; that feedback and
  any simplified input are reference-only. Production uses the canonical
  once/interval/cron structure and does not parse natural-language schedules.

## Automations-Specific Avoidances

- restoring the old Automations sidebar beside the page;
- summary metrics, charts, or run-count KPI cards;
- treating an Automation definition as if it were the execution transcript;
- hiding failed or missed invocations behind schedule state, including for
  disabled definitions;
- deriving `Completed` from a `dispatched` Invocation instead of showing the
  real Invocation state and linked Session result;
- sharing one Session identity across multiple runs;
- requiring every Automation to originate from a Todo.
