# Todos Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Todos contains three inventory
> surfaces: Active, Rejected, and Archived. Active opens as a centered List and
> retains Board as a secondary layout. A lightweight preview connects those
> inventory layouts to the independent Todo detail route.

## Purpose

Project Todos capture intent, shape it in Discussion, and connect it to execution.
They are project-owned lifecycle entities, not Session-local checklists.

## Shared Structure

- Context Inspector is absent on Todos.
- Keep the project rail and project toolbar; `Todos` is the active project tab.
- Do not repeat a visible `Todos` page title or product slogan below the toolbar.
  The Todo command header owns `Filter Todos`, the `List / Board` layout toggle,
  the `Active / Rejected / Archived` surface switcher, and one `New Todo` action.
- Keep that command header as a stable two-column grid on desktop. The lead group
  contains the filter, capped at 420px, plus the compact icon-only layout toggle;
  the action group contains the three equal surface choices and `New Todo`. At
  `≤760px`, stack the two groups into full-width rows. Match the current
  prototype values exactly: the filter and `New Todo` are 44px high, the two
  icon-only layout controls are 36px square, and the surface switcher remains
  38px high with 30px inner buttons. Above 760px, `New Todo` is the page-level
  36px exception to the shared 32px inventory primary-button height. Enabled
  layout and surface buttons use the pointer cursor.
- Do not reserve permanent canvas space for Todo capture. `New Todo` opens the
  transient capture dialog specified below. Its visible close control is the
  prototype's 34px square icon button.
- Active List uses a centered 980px maximum reading width. Board may expand to
  1500px because its lanes need horizontal working space. Opening preview never
  changes either width or horizontal alignment.
- Selecting an Active row or Board card opens the lightweight preview. `Open
  details` enters `/projects/:slug/todos/:todoId`; direct links enter that route
  without requiring preview first.
- Closing preview or returning from detail preserves the filter query, selected
  surface, Active layout, focused item, and scroll position.

## Search and Filter

- Project-rail `Search all work` is the only navigational search. The visible
  Todo field is only an in-place filter for the selected Todo view; do not add
  another search icon to the project toolbar.
- `Filter Todos` matches stable ID, canonical content/PRD text, and visible
  runtime metadata without changing lifecycle state or opening the detail page.
- Filtering Active updates the visible List groups and Board lanes from the same
  match set. Board keeps all four lanes visible and both layouts update their
  group/lane counts. Rejected and Archived filter only their selected lists.
- Follow the shared filter visual/interaction contract while keeping the filter
  page-local; do not introduce a generic `EntityFilter` component. Show a
  no-results message without replacing the layout toggle, surface switcher, or
  `New Todo` action.

## Active List Surface

- Active List is the default project Todo surface. Group it by Ideas, Ready, In
  Progress, and Done so lifecycle remains scannable without four wide lanes.
- Keep the List centered at a 980px maximum width with equal outer gutters. Its
  header, rows, dividers, and preview state must never drift to one side of the
  work canvas.
- The inventory filter uses the prototype's 4px control radius at every
  breakpoint; it does not inherit the 6px card radius.
- Match the current prototype workspace padding: 16px top, 20px horizontal,
  40px bottom on desktop; 14px top, 12px horizontal, 32px bottom at `≤760px`.
  Active groups use a 22px vertical gap. Group headers are 36px high with 10px
  item gaps, 12px/700 uppercase titles, 12px hints, and 11px tabular counts.
- Each row shows the prototype's display-only lead: the first Markdown heading
  when present, otherwise the first normalized content, capped at 80
  characters. This never adds a persisted Todo title. Quiet relative update
  metadata remains `Updated {relative time}`. Only In Progress rows may add the
  same derived operational line as Board cards.
- List rows use an `18px / minmax(0,1fr) / auto` grid, 12px gaps, 10px/12px
  padding, a 56px minimum height, and one bottom rule. Excerpts are 14px/500 at
  1.35 line-height; metadata is 11px with an 8px gap. Focus/selection uses the
  prototype's hover field plus a 2px inset brand rule without changing bounds.
- Use flat rows separated by rules. Do not turn every row into a floating card,
  repeat its lifecycle label, or show linked-work counts.
- The row itself is the single inventory action and opens Preview or canonical
  detail according to the responsive rule below. Do not add row-end
  `Discuss`, `Plan`, or duplicate `Open` shortcuts; those workflows belong to
  Preview or full detail.
- `j` and `k` may move focus through visible rows. When preview is open, moving
  focus updates the preview without changing its mode; `Enter` opens the full
  detail route.

## Board Surface

Board is the secondary Active layout. Desktop uses four lanes:

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
  drop target still spans at least 500px. The base lane minimum is 168px,
  `≤760px` uses 160px, and `≥1100px` uses 500px. Do not draw a permanent lane
  perimeter, radius, or large filled empty box. A current drag target may use
  one temporary quiet field.
- Lane headers use a status orbit, title, short explanation, one bottom rule,
  and a compact tabular count pill. Headers use a 52px minimum height, 10px
  grid gap, 14px bottom padding, an 11px/720 uppercase title, an 11.5px hint,
  and a count with 22px minimum width, 2px/7px padding, a quiet border, and a
  full radius. The Done lane orbit uses the shared **circle-check** glyph
  (`data-icon="circle-check"`); other inventory done orbits must match this
  glyph, not invent a CSS check.
- Lane contents use 14px top padding and an 11px card gap. Todo cards are the
  Board's only persistent card layer. Use a subtle border, surface background,
  6px radius, 56px minimum height, and no elevation.
- Cards use the prototype hover response: border/background emphasis and a
  `translateY(-0.5px)` lift; pressed cards return to the baseline at 0.995
  scale without shifting surrounding layout.
- Preserve the dedicated full-height drag activator. Its precise-pointer width
  is 36px to match the current prototype; on coarse/touch pointers it expands
  to 44px. Keep the grip visible at 35% opacity, raise it to 72% with card
  hover/focus and 100% on direct hover, and do not add a permanent divider.
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
- Card content uses 10px vertical, 14px right, and zero left padding. Its excerpt
  is 14px/500 at 1.5 line-height with `-0.012em` tracking. The operational line
  uses a 6px status dot plus visible 11.5px/520 text and an optional short detail
  after a separator; the running dot alone may pulse. Keep it inside the existing
  card boundary without a badge stack, nested card, action, lifecycle control,
  or full-width internal divider.
- Empty-lane guidance stays close to the lane header and aligns with card text;
  do not center it inside the full desktop drop target.
- Pointer and touch dragging target the lane under the pointer rather than the
  dragged card rectangle; keyboard dragging retains geometric collision
  fallback.

## Rejected Surface

- Use a centered flat list at a maximum width of 980px.
- Keep the same 12px uppercase section heading and rule as the Active List.
  Rows use an `18px / minmax(0,1fr) / auto` grid, 12px gaps, 10px/12px
  padding, and a 56px minimum height. The display lead is 13px/500 at 20px
  line-height and clamps to two lines; the state line is 11px with 4px top
  spacing. Recovery controls are 32px high for precise pointers and 44px for
  coarse pointers.
- Every row preserves the compact content excerpt and rejection reason.
- Primary recovery is `Restore to Idea`.
- Use amber for the rejected/reconsideration signal, never destructive red.
- Do not mix Rejected items back into the active Board.

## Archived Surface

- Use the same centered flat-list structure as Rejected for visual continuity.
- Show the compact content excerpt and a quiet `Archived` state label.
- Primary recovery is `Restore`.
- Archived work remains recoverable but visually quiet.
- Do not replace the list with a hidden archive menu.

## New Todo Dialog

- The command header exposes one primary `New Todo` action. `C` is its keyboard
  shortcut when focus is not inside another editable control.
- Open one compact modal dialog containing a visible `Todo content` label,
  Markdown textarea, helper copy, and three explicit outcomes:
  `Save / Start discussion / Run now`.
  Center it against the viewport, including the project rail, over a 58% black
  backdrop. Desktop geometry is a 560px maximum width, 12px radius, 52px
  header, 18px body inset, 126px default textarea, and `12px 18px` footer.
  Entry uses the prototype's 200ms scale/fade and reduced motion removes it.
- `Save` creates one Idea and starts no Agent work. Its confirmation says the
  Todo was saved, never that work started.
- `Start discussion` is one idempotent operation: it creates one Idea, creates
  one bound Discussion Session, and opens that Session. The Todo remains in
  Ideas while Discussion shapes it. The client reuses one stable request ID for
  every retry of unchanged content. An indeterminate response retains and links
  the exact Todo and Session when known; retrying the same operation never
  duplicates either resource.
- `Run now` creates the minimal Todo, places it in In Progress, creates one bound
  Lead Session, and opens that Session. It skips Discussion and Plan without
  preventing the user from adding either later.
- `Run now` is the single dominant action; `Save` and `Start discussion` remain
  quiet secondary actions. Do not add `New Session`, References, Plan controls,
  or a Todo-vs-Session chooser to capture.
- Escape and the visible close action dismiss an unchanged dialog and restore
  focus to `New Todo`. Submission keeps the dialog in place while pending,
  marks it busy, announces the current operation, disables duplicate actions
  and dismissal, and presents errors beside the failed action. Failure moves
  focus to the exact Retry action when retry is safe, otherwise to the inline
  error/recovery notice.
- At narrow widths the dialog uses the available viewport, the input keeps its
  full row at `16px` type and 180px minimum height. Preserve the prototype's
  effective 10px phone side inset and hide the redundant Cancel action. Place
  `Save / Start discussion` in two equal columns, then span `Run now` across
  both columns; keep Close and all three actions 44px high. At every viewport,
  coarse-pointer Close, Save, Start discussion, and Run now remain 44px high.

## Inventory Preview

- Selecting an Active List row or Board card opens a right-side preview up to
  420px wide. It overlays rather than compresses or re-centers the inventory.
- The preview starts below the Todo command header and covers only the inventory
  canvas. It uses the prototype's 420px maximum width, 52px header, 30px close
  control, 18px body inset, gradient surface, left divider, directional shadow,
  200ms horizontal entry, and 180ms quiet scrim fade. Reduced motion removes
  both animations.
- Preview is non-editing. It may show a bounded content excerpt, current
  lifecycle state, derived runtime signal, and a short linked-work list, plus
  navigation or workflow-launch actions. It never edits canonical Markdown,
  changes lifecycle, manages References or Plan, or reproduces the complete
  detail document.
- `Open details` is the explicit path to the canonical Todo route. Keep direct
  deep links valid; preview is never a routing prerequisite.
- Preview hierarchy is `18px display lead → five-line 13px plain-text body excerpt → Updated/state
  chips → optional operational field → optional linked-work rows → footnote`.
  Linked work uses one 52px minimum row with a status orbit, title/context, and
  trailing state. The footer gives the lifecycle-appropriate primary action one
  full 36px row; `Open details` and an additional Discussion action share a
  second row only when both exist. Coarse-pointer actions remain at least 44px.
  That second-row Discussion action is borderless with 10px horizontal padding;
  it does not inherit the 13px bordered-action geometry.
- Use a quiet scrim without decorative blur so users retain their scanning
  context. Clicking the scrim, using the visible close control, or pressing
  Escape closes preview and restores focus to the originating item.
- On open, move focus to the prototype's visually hidden `Todo detail` heading,
  which names the dialog without drawing an initial focus ring. The first
  forward Tab moves to the visible Close control; reverse Tab moves to the last
  footer action. Focus remains trapped until dismissal.
- `j` / `k` may move between visible items while preview stays open. On desktop,
  `Enter` promotes preview to full detail. At `≤720px`, skip the narrow drawer
  and open full detail directly.

## Todo Detail Route

The route preserves:

- lifecycle state and stable Todo ID;
- canonical Todo Markdown and one editing control;
- linked Discussions, work Sessions, and Automations when they exist;
- lifecycle-appropriate primary and secondary actions.

The full-detail header follows the prototype's two-line chrome. Its first line
contains the `Todos` back action and `Updated {relative time} · {stable Todo ID}`;
these read as one continuous left-aligned trail without a decorative back icon;
the freshly updated state is exactly `Updated now · {stable Todo ID}` (not
`Updated just now`);
the ID uses the compact monospace identifier style. Its second line contains
the four clickable `Ideas / Ready / In Progress / Done` lifecycle segments and
the current lane explanation. Selecting a non-current segment performs the
canonical Todo status mutation; the current segment is a no-op, all segments
show the pending state during mutation, and archived Todos must be restored
before the band can change status. At `≤760px`, every segment is a 44px touch
target and only the current segment retains its text label.

Use a two-region responsive layout: above 1040px, the readable main column is one continuous
document work surface owning `Brief / PRD`, `References`, `Plan`, and any
`Result`; the secondary column is one continuous context rail owning `Work`,
linked Sessions and Automations, and `Lifecycle`. Separate regions inside each
column with typography and horizontal rules rather than individual rounded
cards. At `≤1040px`, stack the context rail below the document column; at
`≤760px`, also apply the 12px horizontal document gutter and 24px region gap.
The stacked context rail starts 24px below its top divider, reduced to 20px at
`≤760px`. Page, lifecycle, starter, and work actions at that narrow breakpoint
are 44px high. The Brief header's quiet `Edit` control is the prototype's one
32px detail-action exception. The full-detail scroll surface preserves the
prototype's 15px scrollbar width instead of inheriting the product-global 6px
scrollbar. Compact inline Reference row actions remain 30px on precise
pointers and expand to 44px on coarse/touch pointers, matching the prototype.
Do not introduce tabs,
collapsible groups, or a second Todo summary model.

Use progressive disclosure without hiding capability:

- `Brief / PRD`, state-aware Work actions, and `Lifecycle` remain visible for
  every Todo.
- Show the full `References` region only when References exist, the full `Plan`
  region only when a Plan exists, linked Sessions only when at least one exists,
  and Automations only when at least one exists. `Result` remains conditional on
  an actual result.
- When References or Plan is absent, show one compact `Add context when it helps`
  row. It exposes only the missing `Add files` and/or `Generate Plan` actions;
  never replace empty optional data with several full-height empty panels.
- This disclosure is presentational only. It does not change Todo lifecycle,
  create a new entity, or make Discussion/Plan mandatory before execution.

Linked active Automations use the prototype's neutral 11px outline marker and
tertiary `Scheduled` label in Todo detail. The Automation remains active; brand
color is reserved for selection and review state, not future scheduling.

Keep `Edit` with the canonical content. Editing uses one Markdown textarea and
one Save/Cancel pair. Do not render a content-derived Todo title in the route
header; keep only lifecycle state and the stable ID there. Render the complete
canonical Markdown, including its first line, in `Brief / PRD`. A one-line
capture therefore remains visible as the complete document rather than
producing an empty-detail state. Demote rendered Brief and Plan headings two
levels beneath the route `h1` and their owning section `h2` (`#` renders as
`h3`, `##` as `h4`, and deeper headings retain their hierarchy capped at `h6`);
fenced code content is never rewritten. Detail actions remain
grouped by intent:

- `Discuss & Plan` contains Continue Discussion when available and New Discussion;
  it remains available for Done and Rejected Todos so completed work can be
  reviewed and rejected intent can be reshaped. Archived Todos alone hide it;
- Plan exposes `Generate Plan` through the compact starter when absent and
  `Improve` beside the Plan when present. Its header metadata is exactly
  `Ordinary Markdown · .archcode/plans/<Todo ID>.md`; its body is ordinary
  rendered Markdown. Do not derive progress counts, interactive checkboxes, or
  persistent step state from Markdown list items. Archived Todos retain the
  Plan document but hide both `Generate Plan` and `Improve`, because those
  controls launch or continue Agent work; `Edit` and `Add files` remain
  available as direct document maintenance;
- `Execution` has one state-aware primary action and appears only in lifecycle
  states where execution actions are valid. With no linked Work Session, show
  primary `Start Work`. Once a Work Session exists, replace it with primary
  `Continue Work` and expose secondary `New Work Session`; `Create Automation`
  remains secondary. Never show `Start Work` and `Continue Work` together;
- the header's four lifecycle segments are the only normal status-movement
  controls. The right-side `Lifecycle` region contains only `Reject` and
  `Archive` (`Restore` while archived); it never repeats `Move status`,
  `Move to …`, or `Restore to Ideas` controls. The right-side Work region also
  never adds a second `Complete / Mark done` path; selecting the header's
  `Done` segment is the sole completion control.

`Reject` first opens one inline rejection-reason textarea with `Cancel / Reject
Todo`; an empty reason cannot be submitted. Rejected detail keeps the prototype's
amber header notice but has no duplicate Restore action. `Archive` applies
directly, and only Archived detail exposes `Restore` in the right-side Lifecycle
region.

Plan shaping remains one fixed secondary capability. Place `Generate Plan` in
the compact starter while no Plan exists and `Improve` beside the rendered Plan:

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

Linked Session and Automation history in the full detail context rail uses the
prototype's flat three-column rows: 13px status column, 9px gap, title/context,
and trailing state, with 13px vertical and 2px horizontal padding plus one
bottom divider. Titles are 12px/630, context is 10px/1.4, and trailing state is
9px/650. Completed rows use the shared 11px `circle-check`; running, attention,
failed, scheduled, paused, and idle rows use their canonical status glyph and
tone without a card container.

Route behavior:

- direct deep links render the same complete entity surface;
- the inventory command header belongs only to List, Board, Rejected, and
  Archived surfaces. Full Todo detail does not retain `Filter Todos`, layout or
  surface switches, or `New Todo` above the document;
- `Open details` from preview reaches this route, and a visible back action
  returns to the originating Todo surface, layout, query, and scroll position;
- the main content remains readable at approximately 820px while the whole
  route may expand to 1280px;
- use one continuous document surface plus one context rail, not a modal,
  scrim, repeated full-boundary panels, or nested card stack;

### References

- When References exist, Todo detail places one flat `References` region in the
  main column between `Brief / PRD` and `Plan`. With none, expose `Add files`
  through the compact starter instead of rendering an empty References block.
  References are never a Board card, preview control, tab, separate attachment
  page, or count badge on project surfaces.
- `Add files` opens the native multi-file picker and the surrounding drop target
  accepts drag-and-drop. The button remains the keyboard/touch alternative and
  all uploads activate serially using the latest Todo revision from the prior
  mutation response.
- Rows preserve server order and show the prototype's fixed 36px square file
  type marker (`PDF`, `PNG`, `TXT`, or the uppercase filename extension), file
  name, size, and an inline `Uploading…`, `Retry`, or error state. Do not load
  image thumbnails inside the list; this keeps row geometry stable. Images and
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

- omitting Rejected or Archived because Active is the primary surface;
- treating Todos as a generic Kanban clone;
- drag-and-drop as the only way to change state;
- large rounded lane containers;
- oversized or decorative lane-count treatments, or a permanent divider around
  the drag activator;
- rendering every Todo detail section as an equal rounded card;
- showing full empty References, Plan, Sessions, or Automations sections for a
  simple Todo;
- hiding existing linked work, lifecycle actions, or the canonical detail route;
- allowing preview to edit content or lifecycle, manage durable context, or
  resize and push the underlying inventory to one side;
- restoring a permanent capture composer above the inventory;
- presenting capture as an AI prompt.
