# Sessions Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Sessions is the project execution
> inventory and direct-work entry. It does not replace the Session detail
> workbench defined in [`session.md`](session.md).

## Purpose

Sessions lets users recover every durable root execution, understand what needs
attention, and start work directly without manufacturing a Todo first.

## Structure

- Keep the project rail and project toolbar; `Sessions` is the active project
  tab.
- Do not repeat a visible `Sessions` page title below the toolbar.
- Use one compact command row: local Session filter, one source filter, and the
  single primary `New Session` action.
- The list is centered at a maximum width of 1080px and grouped as `Needs you`,
  `Running`, then `Recent`.
- Use flat rows and thin separators. Do not add summary cards, charts, runtime
  metrics, or a second dashboard above the list.

## Session Rows

- Row order is status orbit, Session title and source context, then action state
  or elapsed time.
- Every row identifies one source: `Todo`, `Automation`, or `Direct`.
- Todo and Automation sources include the durable parent name when it is still
  available, otherwise their stable parent ID. Direct Sessions show the root
  Agent identity instead of inventing a parent work item.
- `Needs you` uses an amber icon plus `Inspection`, `Permission`, `Question`, or `Failed` text;
  `Running` uses the live orbit plus elapsed time; completed Recent rows use a
  green check or explicit `Completed` text.
- The whole row opens the exact Session URL. Destructive actions remain in an
  overflow menu or the Session detail and never compete with row navigation.

## Search and Filter

- `Filter Sessions` covers Session title, stable ID, source type, linked Todo
  content, and Automation name.
- Treat search and source as one left-aligned filter cluster with an 8px gap;
  keep `New Session` independently anchored to the far right. Never distribute
  the three controls as equal islands across the command row.
- The source filter is one compact, workbench-styled select: `All sources`,
  `Todo`, `Automation`, `Direct`. It uses the shared control border, filter
  icon, explicit chevron, and focus ring instead of the browser-default chrome.
  Do not add another state filter because the decision groups already expose
  state.
- A no-results state suggests another Session title or stable ID and keeps the
  source filter visible as the explicit way to narrow by origin.
- Project-rail `Search all work` is the only navigational search. The visible
  field only filters the Sessions inventory; do not duplicate search in the
  project toolbar.

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

- At `≤760px`, the project toolbar becomes two rows: project identity/actions
  first and all three project tabs second.
- Search takes the full first row of the command surface; source filter and New
  Session remain 44px touch targets beneath it.
- Row metadata may wrap to two lines. Hide elapsed time before hiding source,
  title, or the action-required state.

## Sessions-Specific Avoidances

- restoring the old persistent Sessions sidebar beside this page;
- calling direct work `Quick Session`, `Work`, or `Legacy`;
- showing a `New Session` button inside Todo quick capture;
- treating the page as analytics or adding status summary cards;
- auto-creating Todos for direct Sessions;
- hiding Todo or Automation provenance on Session detail.
