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
- The compact canvas header shows the `OPERATIONS` eyebrow, `Runs`, and the
  active Session count as `{N} active`. It is orientation, not a KPI card.
- Use one compact command row: local Session filter, one source filter, and a
  quiet `New Session` action. `New Todo` remains the navigator's single primary
  creation action; direct Session creation remains fully available without
  competing with the Todo-first hierarchy.
- The list is centered at a maximum width of 1080px and grouped as **`Needs you`**,
  **`Running`**, then **`Recent`**. Group titles match the product lexicon in
  Master; do not title the first group `Needs attention`.
- Match the current prototype list geometry: 24px desktop horizontal gutters,
  28px top and 64px bottom; at `≤720px` use 12px horizontal gutters, 18px top,
  and 64px bottom. Adjacent non-empty groups use 26px separation. Group headers
  have a 29px minimum height with `0 7px 8px` padding, an uppercase 11px/700
  label, and a 10.5px tabular count.
- Use flat rows and thin separators. Do not add summary cards, charts, runtime
  metrics, or a second dashboard above the list.
- `New Session` uses the shared quiet button primitive.

## Session Rows

- Every desktop group uses the same four row tracks: 30px status orbit,
  flexible Session copy, one shared fixed-width trailing state/time track, and
  a fixed chevron track. The trailing track has one width across `Needs you`,
  `Running`, and `Recent`; its copy is right-aligned and uses tabular figures so
  state and time do not drift horizontally between groups.
- Desktop rows use 12px gaps, `10px 8px` padding, a 66px minimum height, and one
  bottom separator. Titles are 13.5px/600 at 1.35 line-height; source context is
  11.5px at 1.35 line-height with 4px top spacing and a compact uppercase source
  label.
- At `≤720px`, rows use a 72px minimum height and a 27px status column. Keep an
  explicit action-required or failed state in the trailing position; hide
  secondary running/recent time and the chevron first. The source-context line
  keeps source, durable parent context, and owner metadata in document order,
  then naturally ellipsizes as one line according to the remaining width. At
  390px this means retaining as much of that line as fits rather than explicitly
  hiding either source or owner.
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
- The source filter is one compact workbench single-select trigger for
  `All sources`, `Todo`, `Automation`, and `Direct`. It uses the shared control
  border, filter icon, explicit chevron, and focus ring, then opens one anchored
  ArchCode listbox using the shared popover elevation. Do not expose a browser-
  native select or system option sheet in this prototype.
- Its current compact geometry is an explicit Runs-page exception: the trigger
  uses a 7px radius, the anchored menu an 8px radius, and each option a 5px
  radius. On coarse pointers, every option must expose at least a 44px hit
  target; keep the compact visual treatment while the shared CSS implements
  that approved interaction rule.
- The selected source option uses `--selection-field`, a 2px inset brand edge,
  and a check glyph. Arrow keys, Home/End, Enter/Space, Escape, outside click,
  and Tab departure all behave predictably; Escape and committed selection
  return focus to the trigger. Do not add another state filter because the
  decision groups already expose state.
- A no-results state suggests another Session title or stable ID and keeps the
  source filter visible as the explicit way to narrow by origin.
- When the canonical Session inventory is truly empty, show the quiet first-use
  copy `No Sessions yet` beneath the unchanged command row. Point users to the
  existing `New Session` action or to Todo/Automation entry; do not add a second
  creation button inside the canvas. Filter no-results never masquerades as
  first-use, and canonical first-use takes precedence over any stale controls.
- Project-rail `Search all work` is the only navigational search. The visible
  field only filters the Sessions inventory; do not duplicate search in the
  compact canvas header.

## New Session

- `New Session` immediately creates an untitled direct root Lead Session and
  opens the Session detail with the composer focused.
- Direct creation expresses `start executing now`; it does not imply that the
  work is quick, small, or unsuitable for a longer investigation. Use a Todo
  when the user wants durable Todo content, references, a Plan, or an acceptance
  trail around one or more executions. A PRD is an optional Todo reference.
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
- Keep title and source context on their respective single lines. Hide elapsed
  time before truncating the source-context line; let its source, parent, and
  owner copy ellipsize naturally instead of applying field-specific hiding.

## Sessions-Specific Avoidances

- restoring the old persistent Sessions sidebar beside this page;
- calling direct work `Quick Session`, `Work`, or `Legacy`;
- showing a `New Session` button inside Todo quick capture;
- treating the page as analytics or adding status summary cards;
- auto-creating Todos for direct Sessions;
- hiding Todo or Automation provenance on Session detail.
