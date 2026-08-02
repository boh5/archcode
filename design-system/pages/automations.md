# Automations Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Automations defines recurring or
> repeatable project work. Each invocation opens its own durable Session; the
> Automation definition never replaces Session execution history.

## Purpose

Automations lets users define repeated work once, inspect whether it needs
attention, and recover the exact Session produced by every run.

## Structure

- Keep the project rail and project toolbar; `Automations` is the active project
  tab. Do not repeat an `Automations` page title below the toolbar.
- Use one command row with `Filter Automations` on the left and the single
  primary `New Automation` action on the right.
- On wide screens, use a list/detail split: the left side selects one Automation
  and the right side shows its definition, schedule, linked Todo, and recent
  invocation Sessions.
- At `≤840px`, show the list first; selecting one Automation replaces it with
  the detail in the same canvas and exposes a visible back-to-list action. Do
  not introduce a second navigation rail or a modal merely to inspect an
  existing Automation.

## Automation List

- Group rows by decision value: `Needs attention`, `Scheduled`, then `Paused`.
- Each row shows status orbit, name, concise schedule or latest-run context, and
  the next actionable state. Use a flat row with separators, not a summary card.
- Selection uses the shared indigo selected treatment. Needs-attention state
  keeps explicit text in addition to amber color.
- `Filter Automations` matches stable ID, name, instruction, schedule, linked
  Todo title, and visible run state. Show a helpful no-results state in place of
  the list without hiding the filter or New Automation action.

## Selected Detail

- Preserve name, status, stable ID, updated time, instructions, schedule,
  Agent/Profile, workspace, optional linked Todo, and recent runs.
- `Edit` is secondary. `Run now` is the primary action because it creates one
  new invocation Session without changing the Automation definition.
- Every recent-run row opens its exact Session URL. Never reuse one generic
  Session URL for multiple invocations.
- A linked Todo opens its stable Todo detail URL. Absence of a linked Todo is
  valid and does not make the Automation incomplete.

## New Automation

- Use one focused editor dialog with a visible close action, name, instructions,
  one schedule mode, timezone when relevant, and Agent/Profile choice.
- Keep advanced schedule detail progressively disclosed. Do not turn creation
  into a multi-step wizard or require a Todo.
- The dialog may demonstrate creation with prototype feedback; it must not add
  another persistent workflow state to the page.

## Automations-Specific Avoidances

- restoring the old Automations sidebar beside the page;
- summary metrics, charts, or run-count KPI cards;
- treating an Automation definition as if it were the execution transcript;
- hiding failed invocations behind schedule state;
- sharing one Session identity across multiple runs;
- requiring every Automation to originate from a Todo.
