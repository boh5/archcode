# Todos Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Todos contains three distinct
> list surfaces: Board, Rejected, and Archived, plus an independent Todo detail
> route. All list surfaces remain reachable from the header switcher.

## Purpose

Project Todos capture intent, shape it in Discussion, and connect it to execution.
They are project-owned lifecycle entities, not Session-local checklists.

## Shared Structure

- Context Inspector is absent on Todos.
- Keep the project rail and project toolbar; `Todos` is the active project tab.
- Do not repeat a visible `Todos` page title or product slogan below the toolbar.
  The Todo surface begins with a shared `Filter Todos` field and the three-way
  `Board / Rejected / Archived` switcher.
- Keep that command header as a stable two-column grid on desktop: the filter
  occupies `minmax(240px, 420px)`, while the view switcher is `202px` wide with
  three equal columns. At `≤760px`, stack them into two full-width rows. Do not
  let the filter flex-grow beyond 420px or let the switcher size itself from its
  labels.
- Place quick capture directly below the header.
- Main Todo content may use up to 1500px because Board lanes need horizontal
  working space.
- A Todo opens `/projects/:slug/todos/:todoId`. The Board does not retain a
  parallel drawer or selected-card detail state.
- Returning from a Todo opened on the Board preserves the list query, selected
  view, and scroll position.

## Search and Filter

- Project-rail `Search all work` is the only navigational search. The visible
  Todo field is only an in-place filter for the selected Todo view; do not add
  another search icon to the project toolbar.
- `Filter Todos` matches stable ID, canonical content/PRD text, and visible
  runtime metadata without changing lifecycle state or opening the detail page.
- Filtering the Board keeps all four lanes visible and updates lane counts to
  the visible matches. Rejected and Archived filter only their selected lists.
- Follow the shared filter visual/interaction contract while keeping the filter
  page-local; do not introduce a generic `EntityFilter` component. Show a
  no-results message without replacing quick capture or the active view
  switcher.

## Board Surface

Desktop uses four lanes:

1. Ideas — captured intent that still needs shaping.
2. Ready — clear enough to start or hand off.
3. In Progress — work has started, even when its current processing is idle.
4. Done — completed intent that may be reopened or archived.

Responsive columns:

| Width | Columns |
|---|---:|
| `≥1100px` | 4 |
| `700–1099px` | 2 |
| `<700px` | 1 |

Lane rules:

- Lanes are open structural columns, not card containers. At four columns the
  drop target still spans at least 500px; stacked lanes remain content-sized
  with a 160px minimum. Do not draw a permanent lane perimeter, radius, or
  large filled empty box. A current drag target may use one temporary quiet
  field.
- Lane headers use a status orbit, title, short explanation, one bottom rule,
  and a plain tabular count. Do not box the count as a badge. The Done lane
  orbit uses the shared **circle-check** glyph (`data-icon="circle-check"`);
  other inventory done orbits must match this glyph, not invent a CSS check.
- Todo cards are the Board's only persistent card layer. Use one quiet border,
  6px radius, and no elevation.
- Cards use subtle hover micro-interactions (1px `translateY` lift) with
  background color change for perceived responsiveness without raised shadows.
- Preserve the dedicated full-height drag activator and its 44px minimum hit
  area. Keep the grip visible but quiet; do not make the activator look like a
  frozen table column with a permanent vertical divider.
- A Todo has no title. Each card shows only the first 80 characters of its
  canonical Markdown after mechanically removing line-leading Markdown markers
  and collapsing whitespace. Clamp this content excerpt to two lines; do not add
  a second preview, artifact metadata, or linked-work counts.
- The lane header owns the visible lifecycle label for Board cards. Preserve the
  lifecycle state in data, drag announcements, and accessible context rather
  than repeating `Idea`, `Ready`, `In Progress`, or `Done` inside every card.
- Only In Progress cards may show the compact derived operational line. It is
  not another Todo lifecycle state and is never persisted. Derive it from the
  linked Work Session, Todo-origin Automation run, unresolved HITL, Goal,
  Execution, and Automation inventory already loaded by the page.
- Do not render a provisional operational line until Session and Automation
  inventory plus runtime and HITL snapshots are authoritative. Once ready, use
  this precedence: **`Needs you`** for unresolved HITL or blocked/budget-limited
  Goals (product phrase; pair with attention tone); **`Failed`** for the latest
  terminal failed/stopped attempt with **error** tone — never amber attention;
  **`Working`** for live work (signal tone); **`Ready to review`** for the latest
  completed result awaiting acceptance; **`Scheduled`** for a future active
  Automation; otherwise **`Idle`**. A newer active or terminal attempt supersedes
  an older failure, while an Automation dispatch alone is never completion. The
  Board prototype demonstrates Needs you, Failed, Working, and Ready to review
  operational lines.
- The operational line uses one shared status cue (orbit or icon) plus visible
  text and an optional short detail after a separator. Keep it inside the existing
  card boundary without a badge stack, nested card, action, lifecycle control, or
  full-width internal divider.
- Empty-lane guidance stays close to the lane header and aligns with card text;
  do not center it inside the full desktop drop target.
- Pointer and touch dragging target the lane under the pointer rather than the
  dragged card rectangle; keyboard dragging retains geometric collision
  fallback.

## Rejected Surface

- Use a flat list at a maximum width of 980px.
- Every row preserves the compact content excerpt and rejection reason.
- Primary recovery is `Restore to Idea`.
- Use amber for the rejected/reconsideration signal, never destructive red.
- Do not mix Rejected items back into the active Board.

## Archived Surface

- Use the same flat-list structure as Rejected for visual continuity.
- Show the compact content excerpt and a quiet `Archived` state label.
- Primary recovery is `Restore`.
- Archived work remains recoverable but visually quiet.
- Do not replace the list with a hidden archive menu.

## Quick Capture

- Use one compact Markdown input surface with two explicit outcomes:
  `plus icon → content textarea → Save / Run now`.
- On desktop keep the surface approximately 60–68px tall, with a quiet border
  and no resting elevation. It is a compact workbench composer, not the page's
  dominant card.
- `Save` creates one Idea and starts no Agent work. Its confirmation says the
  Todo was saved, never that work started.
- `Run now` creates the minimal Todo, places it in In Progress, creates one bound
  Lead Session, and opens that Session. It skips Discussion and Plan without
  preventing the user from adding either later.
- `Run now` is the single dominant action; `Save` remains a quiet secondary
  action. Do not add `New Session` or a Todo-vs-Session chooser to capture.
- At narrow widths the input keeps its full row and the two actions share the
  row below it; both remain at least 44px touch targets.

## Todo Detail Route

The route preserves:

- lifecycle state and stable Todo ID;
- canonical Todo Markdown and one editing control;
- linked Discussions, work Sessions, and Automations;
- lifecycle-appropriate primary and secondary actions.

Use a two-region responsive layout: the readable main column is one continuous
document work surface owning `Brief / PRD`, `References`, `Plan`, and any
`Result`; the secondary column is one continuous context rail owning `Work`,
linked Sessions and Automations, and `Lifecycle`. Separate regions inside each
column with typography and horizontal rules rather than individual rounded
cards. Stack the two columns on narrower screens. Do not introduce tabs,
collapsible groups, or a second Todo summary model.

Keep `Edit` with the canonical content. Editing uses one Markdown textarea and
one Save/Cancel pair. Do not render a content-derived Todo title in the route
header; keep only lifecycle state and the stable ID there. Render the complete
canonical Markdown, including its first line, in `Brief / PRD`. A one-line
capture therefore remains visible as the complete document rather than
producing an empty-detail state. Demote rendered Brief and Plan headings beneath
the route heading; fenced code content is never rewritten. Detail actions remain
grouped by intent:

- `Discuss & Plan` contains Continue Discussion when available and New Discussion;
- `Plan` exposes Generate / Improve Plan beside the Plan itself;
- `Execution` has one state-aware primary action and appears only in lifecycle
  states where execution actions are valid. With no linked Work Session, show
  primary `Start Work`. Once a Work Session exists, replace it with primary
  `Continue Work` and expose secondary `New Work Session`; `Create Automation`
  remains secondary. Never show `Start Work` and `Continue Work` together;
- `Lifecycle` contains state movement, Reject/Restore, and Archive/Restore.

Plan shaping remains one fixed secondary action inside `Plan`:

- label it `Generate / Improve Plan` without probing whether a Plan file exists;
- reuse the most recently updated linked Discussion and send
  `/skill use plan-work` when it is idle;
- when none exists, create the Discussion with Plan work as its first accepted
  message; never start a generic Discussion and then race it with a second
  command;
- when the latest Discussion has an unfinished Execution, including a suspended
  tool batch, create a new Plan Discussion instead of disabling the action or
  injecting a command into the busy Session;
- if an apparently idle Discussion is deleted or becomes busy before the Plan
  command is accepted, fall back to a new Plan Discussion instead of surfacing
  the Session conflict as the user's failure;
- while this action is resolving, keep the detail route in place, show explicit
  `Opening…` feedback, prevent only a duplicate Plan action, and place any
  unrecoverable error directly inside the Plan section;
- open the resulting Discussion;
- keep Plan generation independent from lifecycle state changes, Start Work,
  Goal creation, Automation creation, and persistent Plan-specific workflow
  state.

The entity and its actions are mandatory. Visual redesign may reorder or
reweight actions, but must not silently remove them.

Route behavior:

- direct deep links render the same complete entity surface;
- a visible back action returns to the originating Todo view when available;
- the main content remains readable at approximately 820px while the whole
  route may expand to 1280px;
- use one continuous document surface plus one context rail, not a modal,
  scrim, repeated full-boundary panels, or nested card stack;

### References

- Todo detail places one flat `References` region in the main column between
  `Brief / PRD` and `Plan`. It is not a Board card, drawer, tab, or separate
  attachment page, and it does not add a count badge to the project surfaces.
- `Add files` opens the native multi-file picker and the surrounding drop target
  accepts drag-and-drop. The button remains the keyboard/touch alternative and
  all uploads activate serially using the latest Todo revision from the prior
  mutation response.
- Rows preserve server order and show a file icon or safe image thumbnail, file
  name, size, and an inline `Uploading…`, `Retry`, or error state. Images and
  native PDFs expose one `Open` action; HTML/SVG and other active or unknown
  content expose one `Download` action. Do not inline active content.
- `Remove` requires confirmation and explains that the reference is unavailable
  to associated Sessions on their next model or tool call. Archive, Reject, and
  Session deletion do not remove Todo references; only this explicit action does.
- Keep the helper copy visible but quiet: files stay in the local project,
  current references can be read by Agent work, and images may be sent to the
  selected model provider. Preserve keyboard focus rings, 44px coarse-pointer
  targets, responsive stacking, and light/dark semantic tokens.

## Todos-Specific Avoidances

- omitting Rejected or Archived because Board is the primary surface;
- treating Todos as a generic Kanban clone;
- drag-and-drop as the only way to change state;
- large rounded lane containers;
- boxed lane counts or a permanent divider around the drag activator;
- rendering every Todo detail section as an equal rounded card;
- hiding linked work or lifecycle actions;
- restoring a Board drawer or another competing detail surface;
- presenting capture as an AI prompt.
