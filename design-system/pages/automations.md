# Schedules Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Automations defines recurring or
> repeatable project work. Each `start_session` invocation opens its own durable
> Automation-source Session; `send_message` targets an existing Session without
> changing its source. The Automation definition never replaces Session
> execution history.

## Purpose

Schedules lets users define repeated Automation work once, inspect whether it needs
attention, and recover the exact Session associated with every dispatched run.
Missed or pre-dispatch failures remain Automation events and may not yet own a
Session.

`Schedules` is the presentation label for the Automation inventory at
`/automations`; the canonical entity remains `Automation`. It is not a third
sibling page beside a separate Automations surface.

## Structure

- Keep the project rail and Todo navigator; `Schedules` is the active secondary
  destination.
- The compact canvas header shows the `OPERATIONS` eyebrow, `Schedules`, and the
  canonical Automation-definition total. It is orientation, not a metric card.
- Use one page-local command row with `Filter Automations` on the left and an
  `All / Active / Paused` status control plus quiet `New Automation` on the
  right. `New Todo` remains the navigator's single primary creation action;
  Automation creation stays fully available. Status buttons expose
  `aria-pressed` and never act as navigation Tabs. They use a neutral pressed
  control treatment, not the shared selected-entity field and edge.
- At `721–760px`, keep the filter on the left while stacking the status control
  and `New Automation` in the right action group. At `≤720px`, stack the filter,
  status control, and creation action into full-width rows. Keep the interactive
  controls at least 44px high and reduce `New Automation` horizontal padding to
  10px.
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
- At `≤720px`, the detail back action and both title actions are 44px tall. A
  list selection moves focus to the detail title; the back action restores the
  exact originating row.

## Empty States

- First-use exists only when the canonical project Automation-definition
  inventory is zero. Explain scheduled or repeatable work in one concise line
  and point toward the existing quiet command-row `New Automation` action; do
  not add a second button of the same weight. Do not auto-select or manufacture
  an empty detail; the navigator `New Todo` remains the dominant
  project-creation primary.
- When definitions exist but the query or status control produces no rows, keep
  those controls visible and name the filtering cause. Query-only filtering uses
  `Clear filter`, status-only filtering uses `Show all`, and combined filtering
  uses `Reset filters`. Do not reuse first-use copy or make creation the recovery
  action.
- Omit an empty decision group; do not render a decorative group shell merely
  to show its zero count.

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
  tone. Completed/successful recent cues use the shared check done orbit
  when an orbit is shown. `dispatched` is not `Completed`; the final execution
  result is read from the linked Session. Use a flat row with separators, not a
  summary card.
- A scheduled definition uses a static neutral orbit. The green rotating orbit
  is reserved for an Invocation whose linked Session is actually running; do
  not animate a definition merely because its next run is scheduled.
- Rows use subtle hover micro-interactions (0.5px `translateY` lift) with
  background color change for perceived responsiveness without raised shadows.
- Selection uses `--selection-field` plus a 2px inset brand edge without
  changing row bounds or vertical rhythm and without turning the row into a
  floating card. Needs-you state keeps explicit text in addition to amber color.
- `Filter Automations` matches stable ID, name, instruction, schedule, linked
  Todo canonical content, and visible run state. Follow the Empty States
  recovery contract without hiding the filter, status control, or `New
  Automation` action.
- `New Automation` uses the shared quiet button primitive on this secondary
  surface. The selected detail's `Run now` remains its local primary action;
  spatial separation keeps that detail decision distinct from the persistent
  navigator's project-level `New Todo` primary.

## Selected Detail

- Preserve name, status, stable ID, updated time, instructions, schedule,
  action and its read-only runtime binding, workspace, optional linked Todo, and
  recent runs. Do not expose Agent/Profile as Automation definition fields.
- Present an enabled definition as **Scheduled** in the detail kicker; `active`
  remains the canonical stored definition state. Format a real `nextFireAt` as
  compact human time (`Today`, `Tomorrow`, or weekday plus time) instead of a
  browser-native full date string.
- The detail footer contains exactly secondary `Edit` and primary `Run now`.
  `Run now` dispatches one new Invocation without changing the Automation
  definition; `start_session` creates its Automation-source Session and
  `send_message` targets its existing Session. Definition lifecycle controls do
  not compete in this title row: `Pause / Resume` and confirmed `Delete` belong
  to the Edit dialog's `Definition controls` section.
- Every dispatched recent-run row opens its exact Session URL. A missed or
  pre-dispatch failed Invocation has no Session link. Never reuse one generic
  Session URL for multiple invocations.
- Automation and Invocation identities are UUIDs. Recent-run rows use truthful
  time/state copy and exact UUID-backed links; do not invent `Run #18`-style
  sequential identities.
- A selected Automation with no Invocations keeps the Recent runs region and
  reads `No runs yet`. `Run now` remains the local primary action; do not add
  an empty illustration, synthesized run, or disabled placeholder row.
- A linked Todo opens its stable Todo detail URL. Absence of a linked Todo is
  valid and does not make the Automation incomplete.

## New Automation

- Use one focused editor dialog with a visible close action, name, instructions,
  structured trigger/action fields, and timezone when relevant. Do not expose
  an Agent/Profile choice. For `start_session`, show a read-only `Lead +
  principal` binding; `send_message` keeps the target Session's existing
  identity.
- Match the current prototype editor geometry: 840px maximum width with 18px
  viewport gutters, 12px radius, 18px horizontal padding, 36px text fields,
  icon-free choice labels and Definition controls, and a two-column body only
  above 760px. At `≤760px`, every 2- or 3-choice grid and structured input pair
  stacks into one column and the complete form uses one continuous scroll area;
  do not create independent Schedule and Action scroll panes.
- Keep advanced schedule detail progressively disclosed. Do not turn creation
  into a multi-step wizard or require a Todo.
- Fixed intervals use the canonical minimum of 30 seconds. When the unit is
  seconds, the amount control clamps to `30`; minutes and hours retain a minimum
  of `1`. The prototype and production validator must reject any effective
  interval below `30_000ms` rather than showing a successful save.
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
- The effective prototype keeps one representative row in every decision group
  and includes an exact failed-Invocation Session link. These fixtures validate
  the same group precedence and status language; they do not introduce a second
  Automation state model.

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
- sharing one Session identity across multiple `start_session` Invocations;
  `send_message` intentionally reuses its exact target Session and preserves
  that Session's original source;
- requiring every Automation to originate from a Todo.
