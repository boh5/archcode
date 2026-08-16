# Runs Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Runs is the Todo-first presentation
> of the project Session inventory and direct-work entry. It does not replace the Session detail
> workbench defined in [`session.md`](session.md).

## Purpose

Runs lets users recover every durable root Session, understand what needs
attention, and start work directly without manufacturing a Todo first.

## Structure

- Keep the project rail and Todo navigator; `Runs` is the active secondary
  destination.
- Use one compact command row: local Session filter, one source filter, and a
  quiet `New Session` action. `New Todo` remains the navigator's single primary
  creation action; direct Session creation remains fully available without
  competing with the Todo-first hierarchy.
- The list is centered at a maximum width of 1080px and grouped as **`Needs you`**,
  **`Running`**, then **`Recent`**. Group titles match the product lexicon in
  Master; do not title the first group `Needs attention`.
- Match the current prototype list geometry: 24px desktop inner padding (56px
  bottom), 18px/12px/40px at `≤760px`; each group has 2px top, 8px horizontal,
  and 10px bottom padding, with 28px only between adjacent non-empty groups.
  Group headers are 28px high with an uppercase 11px/720 label, 10px tabular
  count, and 8px bottom inset.
- Use flat rows and thin separators. Do not add summary cards, charts, runtime
  metrics, or a second dashboard above the list.
- `New Session` uses the shared quiet button primitive.

## Session Rows

- Row order is shared status orbit, Session title and source context, then action
  state or elapsed time.
- Desktop rows use a `14px / minmax(0,1fr) / auto` grid, 11px gaps, 12px
  padding, a 60px minimum height, and one bottom separator. Titles are
  13.5px/620; source context is 11.5px with a 9px/700 uppercase source label.
  At `≤520px`, the trailing state moves below the source context and rows use a
  74px minimum height.
- Rows use subtle hover micro-interactions (0.5px `translateY` lift) with
  background color change for perceived responsiveness without raised shadows.
- Every row identifies one source: `Todo`, `Automation`, or `Direct`.
- Todo and Automation sources include the durable parent name when it is still
  available, otherwise their stable parent ID. Direct Sessions show the root
  Agent identity instead of inventing a parent work item.
- **`Needs you`** group rows use the amber attention orbit plus product state
  text (`Needs you`, or more specific gate copy in the accessible name).
  **`Failed`** rows use the error orbit/tone and the word `Failed` — they may
  still sort under the Needs you *decision group* but must not look like amber
  HITL.
- **`Running`** uses the live orbit plus elapsed time; completed Recent rows use
  the shared **check** done orbit (same glyph language as Todos Done) or explicit
  completed text — not a CSS border-hack check.
- Running rows show elapsed time alone in the trailing column; Needs-you and
  failure rows show their decision state alone. Recent rows append relative time
  to their terminal state. Stable Session IDs remain searchable and in the
  accessible name, but do not clutter the visible source line.
- The whole row opens the exact Session URL. Destructive actions remain in an
  overflow menu or the Session detail and never compete with row navigation.

## Search and Filter

- `Filter Sessions` covers Session title, stable ID, source type, linked Todo
  content, and Automation name.
- Treat search and source as one left-aligned filter cluster with an 8px gap;
  keep `New Session` independently anchored to the far right. Never distribute
  the three controls as equal islands across the command row.
- The source filter is one compact, workbench-styled native single-select:
  `All sources`, `Todo`, `Automation`, `Direct`. It uses the shared control border, filter
  icon, explicit chevron, and focus ring while retaining platform option
  behavior. Do not build a second custom popover for this prototype. Do not add another
  state filter because the decision groups already expose state.
- A no-results state suggests another Session title or stable ID and keeps the
  source filter visible as the explicit way to narrow by origin.
- Project-rail `Search all work` is the only navigational search. The visible
  field only filters the Sessions inventory; do not duplicate search in the
  compact canvas header.

## New Session

- `New Session` immediately creates an untitled direct root Lead Session and
  opens the Session detail with the composer focused.
- Direct creation expresses `start executing now`; it does not imply that the
  work is quick, small, or unsuitable for a longer investigation. Use a Todo
  when the user wants a durable brief, PRD, Plan, or acceptance trail around
  one or more executions.
- Do not ask the user to choose between Todo and Session in a modal; choosing
  the Sessions surface already communicates direct-work intent.
- Do not create a Todo automatically. A later `Create Todo from Session` action
  may exist as quiet progressive disclosure, but it is not part of the primary
  creation flow.

## Responsive Behavior

- At `≤980px`, the project rail remains visible and the Todo navigator becomes
  its existing drawer. Do not recreate the removed project Tab row.
- At `≤720px`, search takes the full first row of the command surface; source
  filter and New Session remain 44px touch targets beneath it. Match the current prototype's
  10px top, 12px bottom, and 12px horizontal command-surface padding.
- Row metadata may wrap to two lines. Hide elapsed time before hiding source,
  title, or the action-required state.

## Sessions-Specific Avoidances

- restoring the old persistent Sessions sidebar beside this page;
- calling direct work `Quick Session`, `Work`, or `Legacy`;
- showing a `New Session` button inside Todo quick capture;
- treating the page as analytics or adding status summary cards;
- auto-creating Todos for direct Sessions;
- hiding Todo or Automation provenance on Session detail.
