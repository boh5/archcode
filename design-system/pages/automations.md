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
- At `≤760px`, match the current prototype's compact single row exactly: use
  14px vertical / 12px horizontal header padding, keep both controls 44px high,
  and reduce `New Automation` horizontal padding to 10px.
- On wide screens, use a list/detail split: the left side selects one Automation
  and the right side shows its definition, schedule, linked Todo, and recent
  invocation Sessions. When the unselected inventory first opens at `≥841px`
  and has visible results, replace the URL with the first item in decision-group
  order (`Needs you → Scheduled → Paused → Inactive`) so the split is populated
  immediately. Preserve the current filter query. Do not auto-select at
  `≤840px` or when the filter has no results.
- At `≤840px`, show the list first; selecting one Automation replaces it with
  the detail in the same canvas and exposes a visible back-to-list action. Do
  not introduce a second navigation rail or a modal merely to inspect an
  existing Automation.
- At `≤760px`, the detail back action and both title actions are 44px tall. A
  list selection moves focus to the detail title; the back action restores the
  exact originating row.

## Automation List

- Group rows by decision value: **`Needs you`**, **`Scheduled`**, **`Paused`**,
  then **`Inactive`**. Groups are mutually exclusive. Prefer the product phrase
  `Needs you` for the attention group title and primary row state. Do not parse
  or render the retired `Needs attention` label.
- A latest Invocation with `failed` or `missed` always belongs in `Needs you`,
  even when the Automation definition is disabled. Otherwise, an exact pending
  HITL request in a linked Session family also belongs in `Needs you`. Map
  `start_session` only through the Automation/Invocation source on the root
  Session; map `send_message` only through its explicit target Session family.
  Read those relationships from one project Session inventory rather than
  fetching per Automation. When neither condition overrides it, active
  definitions belong in `Scheduled`, paused definitions in `Paused`, and
  disabled definitions in `Inactive`.
- Both `failed` and `missed` are terminal dispatch errors and use the red error
  orbit. Preserve the exact mechanism label: render `Failed` for `failed` and
  `Missed` for `missed`; do not rewrite either one as generic `Needs you`.
- List and detail consume one presentation rule with strict precedence:
  **latest `failed`/`missed` error → exact linked HITL `Needs you` → actual
  linked run state → definition state**. Each row shows the shared status orbit,
  name, concise schedule or latest-run context, and exactly one trailing state
  signal. Do not append a second definition/Invocation label, raw Automation
  ID, or redundant `Start Session` / `Send message` copy to the row. Terminal failures show
  **`Failed`** with error tone; human gates show **`Needs you`** with attention
  tone. Completed/successful recent cues use the shared circle-check done orbit
  when an orbit is shown. `dispatched` is not `Completed`; the final execution
  result is read from the linked Session. Use a flat row with separators, not a
  summary card.
- A scheduled definition uses a static neutral orbit. The green rotating orbit
  is reserved for an Invocation whose linked Session is actually running; do
  not animate a definition merely because its next run is scheduled.
- Rows use subtle hover micro-interactions (0.5px `translateY` lift) with
  background color change for perceived responsiveness without raised shadows.
- Selection uses the shared indigo selected treatment. Needs-you state keeps
  explicit text in addition to amber color.
- `Filter Automations` matches stable ID, name, instruction, schedule, linked
  Todo canonical content, and visible run state. Show a
  helpful no-results state in place of the list without hiding the filter or
  New Automation action.
- `New Automation` / primary detail actions use the shared primary button
  primitive where a single dominant CTA is required.

## Selected Detail

- Preserve name, status, stable ID, updated time, instructions, schedule,
  action and its read-only runtime binding, workspace, optional linked Todo, and
  recent runs. Do not expose Agent/Profile as Automation definition fields.
- Present an enabled definition as **Scheduled** in the detail kicker; `active`
  remains the canonical stored definition state. Format a real `nextFireAt` as
  compact human time (`Today`, `Tomorrow`, or weekday plus time) instead of a
  browser-native full date string.
- The detail title row contains exactly secondary `Edit` and primary `Run now`.
  `Run now` dispatches one new Invocation without changing the Automation
  definition; `start_session` creates its Automation-source Session and
  `send_message` targets its existing Session. Definition lifecycle controls do
  not compete in this title row: `Pause / Resume` and confirmed `Delete` belong
  to the Edit dialog's `Definition controls` section.
- Every dispatched recent-run row opens its exact Session URL. A missed or
  pre-dispatch failed Invocation has no Session link. Never reuse one generic
  Session URL for multiple invocations.
- A linked Todo opens its stable Todo detail URL. Absence of a linked Todo is
  valid and does not make the Automation incomplete.

## New Automation

- Use one focused editor dialog with a visible close action, name, instructions,
  structured trigger/action fields, and timezone when relevant. Do not expose
  an Agent/Profile choice. For `start_session`, show a read-only `Lead +
  principal` binding; `send_message` keeps the target Session's existing
  identity.
- Match the current prototype editor geometry: 840px maximum width with 18px
  viewport gutters, 12px radius, 18px horizontal padding, 34px text fields,
  icon-free choice labels and Definition controls, and a two-column body only
  above 760px. At `≤760px`, every 2- or 3-choice grid and structured input pair
  stacks into one column and the complete form uses one continuous scroll area;
  do not create independent Schedule and Action scroll panes.
- Keep advanced schedule detail progressively disclosed. Do not turn creation
  into a multi-step wizard or require a Todo.
- Editing an existing Automation appends one `Definition controls` section.
  It shows the current dispatch status, `Pause` or `Resume`, and `Delete` with
  a controlled confirmation layer inside the same editor. Opening deletion
  never closes or resets the editor. Cancel preserves every draft field and
  returns focus to `Delete`; pending and failed requests keep the confirmation
  visible, and only a successful deletion closes the editor. Do not use a
  browser-native confirmation. Deleting the definition does not delete durable
  Sessions. Creation does not show these controls.
- The dialog may demonstrate creation with prototype feedback; that feedback and
  any simplified input are reference-only. Production uses the canonical
  once/interval/cron structure and does not parse natural-language schedules.

## Automations-Specific Avoidances

- restoring the old Automations sidebar beside the page;
- summary metrics, charts, or run-count KPI cards;
- treating an Automation definition as if it were the execution transcript;
- hiding failed or missed invocations behind schedule state, including for
  disabled definitions;
- titling the attention group `Needs attention` instead of product `Needs you`;
- painting `Failed` invocations with amber attention styling;
- deriving `Completed` from a `dispatched` Invocation instead of showing the
  real Invocation state and linked Session result;
- sharing one Session identity across multiple runs;
- requiring every Automation to originate from a Todo.
