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
- Keep the project rail and persistent Todo navigator; there is no project
  toolbar or `Todos / Automations / Sessions` Tab row. `All todos` is selected
  in the navigator.
- Keep every persistent navigator lifecycle group Todo-only. `Needs you` has one
  row per Todo, never one row per Worker, Session, HITL request, or Goal gate.
  Its group count is the number of affected Todos; each row's trailing count is
  the exact number of unresolved requests plus blocked/budget-limited Work or
  Automation Goals for that Todo. Activating that row opens the Todo's canonical
  Work destination, where the individual actions are expanded.
- The compact canvas header shows `All todos` and the total count. The command
  row below owns `Filter todos`, the `List / Board` layout toggle, and the
  `Active / Rejected / Archived` surface switcher. `New todo` remains the single
  primary action in the persistent Todo navigator; do not duplicate it in the
  canvas header or command row.
- Keep that command header as a stable two-column grid on desktop. The lead group
  contains the filter, capped at 420px, plus the compact icon-only layout toggle;
  the action group contains the three equal surface choices. At
  `≤720px`, stack the two groups into full-width rows. Match the current
  prototype values exactly: the filter is 38px high on precise pointers, the two
  icon-only layout controls are 32px square, and the surface switcher remains
  38px high with 30px inner buttons. At `≤720px`, filter and layout controls
  become 44px touch targets. Enabled
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
  another search icon to the compact canvas header.
- `Filter Todos` matches stable ID, canonical Todo content, and visible
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
- Match the current prototype workspace padding: 28px top, 20px horizontal,
  64px bottom on desktop; 18px top, 12px horizontal, 64px bottom at `≤720px`.
  Active groups use a 26px vertical gap. Group headers have a 29px minimum
  height, `0 7px 8px` padding, 11px/700 uppercase titles, and 10.5px tabular
  counts.
- Each row shows the prototype's display-only lead: the first Markdown heading
  when present, otherwise the first normalized content, capped at 80
  characters. This never adds a persisted Todo title. Quiet relative update
  metadata remains `Updated {relative time}`. Only In Progress rows may add the
  same derived operational line as Board cards.
- List rows begin with a 30px state-orbit column, then flexible copy and the
  trailing affordance. They use 12px gaps, `10px 8px` padding, a 66px minimum
  height, and one bottom rule. Excerpts are 13.5px/600 at 1.35 line-height;
  metadata is 11.5px at 1.35 line-height with 4px top spacing. Focus/selection uses the
  prototype's hover field plus a 2px inset brand rule without changing bounds.
- Use flat rows separated by rules. Do not turn every row into a floating card,
  repeat its lifecycle label, or show linked-work counts.
- The row itself is the single inventory action and opens Preview or canonical
  detail according to the responsive rule below. Do not add row-end
  `Discuss`, `Plan`, or duplicate `Open` shortcuts; those workflows belong to
  Preview or full detail.
- Prototype inventory navigation uses visible controls and ordinary Tab order.
  Do not register document-level letter shortcuts.

## Board Surface

Board is the secondary Active layout. Desktop uses four lanes:

1. Ideas — captured intent that still needs shaping.
2. Ready — clear enough to start or hand off.
3. In Progress — work has started, even when its current processing is idle.
4. Done — completed intent that may be reopened or archived.

Responsive columns:

| Width | Columns |
|---|---:|
| `>1260px` | 4 |
| `721–1260px` | 2 |
| `≤720px` | 4 horizontally scrollable lanes, each `min(240px, 82vw)` |

Lane rules:

- Lanes are open structural columns, not card containers. The current lane
  drop target spans the remaining Board height (420px desktop, 360px narrow).
  Do not draw a permanent lane
  perimeter, radius, or large filled empty box. A current drag target may use
  one temporary quiet field.
- Lane headers own one lifecycle icon, the lifecycle label, one bottom rule, and
  a quiet tabular count. `Idea` is neutral, `Ready` uses brand, `In progress`
  uses live lime, and `Done` uses success green. The Done lane uses the shared
  outline `check` glyph. Carry that same semantic tone into the current
  prototype's 2px top rule, a very low-chroma lane wash that fades by 190px,
  and a 9% header-only horizontal field. This is lifecycle orientation, not a
  filled lane container; keep the rest of the column open. Do not repeat these
  lifecycle icons inside every card.
- Lane contents use 10px top spacing, 8px horizontal insets, and a 10px card
  gap. Todo cards are the
  Board's only persistent card layer. Use a subtle border, surface background,
  6px radius, 56px visual minimum height, and no outer elevation. A quiet inset
  top edge and a lifecycle-mixed hover border are allowed; they must not make
  the cards appear to float.
- Cards use the prototype hover response: border/background emphasis and a
  `translateY(-0.5px)` lift; pressed cards return to the baseline at 0.995
  scale without shifting surrounding layout.
- Preserve the dedicated full-height drag activator. Its precise-pointer width
  is 28px; on coarse/touch pointers it expands to 44px. The grip is an operation
  affordance, not a lifecycle icon. Keep it visually quiet until card or direct
  handle hover/focus; a narrow divider may separate the handle from the link
  content without becoming a second status column.
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
- Card link content uses 10px padding on all sides beside the dedicated drag
  activator. Its compact
  title is 12.5px/500 at 1.48 line-height. The operational line
  uses a 6px status dot plus visible 11.5px/500 text and an optional short detail
  after a separator; the running dot alone may pulse. Keep it inside the existing
  card boundary without a badge stack, nested card, action, lifecycle control,
  or full-width internal divider.
- Empty-lane guidance stays close to the lane header and aligns with card text;
  do not center it inside the full desktop drop target.
- Pointer and touch dragging target the lane under the pointer rather than the
  dragged card rectangle. A successful move updates Board counts and the List
  projection together. Dragging is not the only lifecycle path: the canonical
  Todo detail lifecycle control remains available.
- During drag, only the active card may lift and receive temporary elevation;
  the target lane uses one temporary brand field. A successful drop gets one
  220ms border/translate landing response, then returns to the ordinary flat
  card state. Reduced motion removes that response.

## Rejected Surface

- Use a centered flat list at a maximum width of 980px.
- Keep the same compact uppercase group heading and rule as the Active List.
  Rows use the same 30px-orbit / flexible-copy / trailing-action structure,
  12px gaps, `10px 8px` padding, and 66px minimum height as Active. The display
  lead is 13.5px/600 at 1.35 line-height and clamps to two lines; the state line
  is 11.5px at 1.35 line-height with 4px top
  spacing. Recovery controls are 32px high for precise pointers and 44px for
  coarse pointers.
- Every row preserves the compact content excerpt and rejection reason.
- Primary recovery is `Restore to Idea`.
- Use amber for the rejected/reconsideration signal, never destructive red.
- Do not mix Rejected items back into the active Board.

## Archived Surface

- Use the same centered flat-list structure as Rejected for visual continuity.
- Show the compact content excerpt and a quiet `Archived` state label.
- Primary recovery is `Restore`. It clears the archived flag and returns the
  Todo to the lifecycle state it held before archival; it does not force the
  Todo back to Ideas.
- Archived work remains recoverable but visually quiet.
- Do not replace the list with a hidden archive menu.

## New Todo Dialog

- The persistent Todo navigator exposes one primary `New Todo` action. The prototype does
  not register a document-level creation shortcut.
- Open one compact modal dialog containing a visible `Todo content` label,
  Markdown textarea, helper copy, and three explicit outcomes:
  `Save / Start discussion / Run now`.
  Center it against the viewport, including the project rail, over a 58% black
  backdrop. Desktop geometry is a 500px maximum width, 12px radius, 52px
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
- Visible row/card activation updates the preview while it remains open. At
  `≤720px`, skip the narrow drawer and open full detail directly.

## Todo Detail Route

The route preserves:

- lifecycle state and stable Todo ID;
- canonical Todo Markdown and one editing control;
- linked Discussions, work Sessions, and Automations when they exist;
- lifecycle-appropriate primary and secondary actions.

The selected-Todo shell is one compact band. It contains the content-derived
display lead, the current lifecycle state, and `Todo / Work`; it does not stack
a separate object header and Tab row. The display lead is not a second persisted
Todo title. Stable UUID and freshness remain in the object data and deliberate
detail/copy affordances rather than consuming a permanent eyebrow.

The Todo destination begins with one lifecycle control row containing only the
four normal icon-and-label actions: `Idea / Ready / In progress / Done`. A
labeled quiet `More` control follows them and progressively discloses
`Reject Todo…` and `Archive Todo`; these exceptional exits never appear as
peers of normal lifecycle movement. Its icon and color mapping is identical to
the Todos Board lane headers. Selecting a non-current lifecycle action performs
the canonical mutation; Session Execution state remains independent. At
`≤720px`, the row stacks and every lifecycle/menu/recovery control remains a
44px touch target.

Use one selected-Todo shell with two stable local destinations: **Todo** first,
then **Work** with its linked-Session count. These are route-level destinations,
not content filters. Todo detail and the Work list retain direct links and
Back-stack state inside the Todo shell. A concrete Work row opens that Session's
single canonical `/projects/:slug/sessions/:sessionId` URL; immutable Todo source
reconstructs the same shell with Work selected. Do not create a second nested
Session identity under the Todo route, and never jump back to Todo merely because
the concrete Session URL belongs to the Session route family.

When the Todo needs user action, the Work destination begins with one
authoritative `Needs you` section above its local work filter. It renders every
pending HITL request and every blocked/budget-limited Work or Automation Goal
as a separate row; never collapse multiple child Workers into a single primary
request. A row names the exact owning Agent and Session, shows the mechanism
(`Inspection / Permission / Question / Goal`), and deep-links to the canonical
root Session with `hitl` and child `focus` when applicable. Resolution remains
owned by that Session's existing HITL surface; the Todo Work page does not copy
permission/question controls or create another mutation owner. Until Session
inventory and the global HITL snapshot are both authoritative, do not show a
partial count or partial action list. The global rail Bell remains action-first
and continues to open the exact Session directly; this Todo-level drill-down is
only the project navigator's Todo-preserving path.

The Todo destination is one continuous readable document work surface owning
`Todo content`, `References`, `Plan`, and any `Result`. The lifecycle-appropriate
primary `Start Work / Continue Work` action remains directly reachable from the
Todo document; linked-Session history and additional work creation move to the
Work destination instead of forming a permanent right rail beside Todo content.
Separate document regions with typography and horizontal rules rather than
rounded cards. At `≤720px`, apply the 12px
horizontal document gutter and 24px region gap. Page, lifecycle, starter, and
work actions are 44px high at that breakpoint. The Todo content header's quiet `Edit`
control remains the one 32px detail-action exception. Compact inline Reference
row actions remain 30px on precise pointers and expand to 44px on coarse/touch
pointers. Do not introduce nested Todo-content tabs, collapsible document
groups, or a second Todo summary model.

Use progressive disclosure without hiding capability:

- `Todo content` and `Lifecycle` remain available for every Todo. Ready and In
  Progress Todos expose the document's one primary `Start Work` action, or
  `Continue Work` when a bound Work Session already exists. Starting Work uses
  the canonical Todo-to-Session mutation; continuing opens the latest bound Work
  Session and advances Ready to In Progress before navigation. Idea, Done,
  Rejected, and Archived do not expose an execution primary. Until linked Work
  inventory is authoritative, keep the primary visible but disabled as `Loading
  work…`; a failed inventory reads `Work unavailable`. Never treat unknown Work
  as absent and create a potentially duplicate Session.
- `References` remains a stable flat region because `Add files` is a canonical
  management action; its list may be empty without inventing placeholder cards.
- `Plan` has three visible prototype states: present Markdown with `Improve`,
  absent with `No Plan file yet` and `Generate Plan`, and present-but-empty with
  recovery copy and `Improve`. Linked Work appears on the adjacent Work
  destination rather than as another Todo document section. `Result` remains
  conditional on trusted final output.
- This disclosure is presentational only. It does not change Todo lifecycle,
  create a new entity, or make Discussion/Plan mandatory before execution.

Keep `Edit` with the canonical content. Editing uses one Markdown textarea and
one Save/Cancel pair. Do not render a content-derived Todo title in the route
header as independent persistent data. Render the complete canonical Markdown,
including its first line, in `Todo content`. A one-line
capture therefore remains visible as the complete document rather than
producing an empty-detail state. Demote headings rendered from Todo content and
Plan two levels beneath the route `h1` and their owning section `h2` (`#` renders as
`h3`, `##` as `h4`, and deeper headings retain their hierarchy capped at `h6`);
fenced code content is never rewritten. Actions stay with the surface they
change:

- Plan exposes `Generate Plan` through the absent state and
  `Improve` beside the Plan when present. Its header metadata is exactly
  `.archcode/plans/<Todo ID>.md`; its body is ordinary
  rendered Markdown. Do not derive progress counts, interactive checkboxes, or
  persistent step state from Markdown list items;
- A quiet **`Discuss`** action remains visible beside `Edit` in the Todo
  destination's `Todo content` header for every non-Archived Todo. It creates and
  opens a new bound Discussion directly; users never need to discover the Work
  destination before they can shape the Todo.
- `Start Work / Continue Work` is the one local primary beside those Todo content
  actions for Ready and In Progress Todos. It does not create a second workflow:
  `Start Work` reuses the existing Todo `entry: work` command, while `Continue
  Work` opens the most recently updated bound Work Session.
- `New discussion`, `Create automation`, and `New work session` remain in the
  Work list header for explicit linked-work creation and management;
- the four lifecycle buttons are the only normal status-movement controls.
  A labeled `More` menu in that same row owns `Reject Todo…` and `Archive Todo`;
  no second lifecycle or completion surface is added;
- conditional Result owns only `Open Session`, which drills into the exact
  completed Work Session that produced the trusted final output.

`Reject Todo…` first closes the menu and opens one inline rejection-reason field
with `Cancel / Reject Todo`; an empty reason cannot be submitted. `Archive Todo`
applies after that deliberate menu choice. Rejected and Archived detail hide
the `More` menu and expose one direct recovery action in the same row:
`Restore to Idea` for Rejected and `Restore` for Archived. Restoring an Archived
Todo preserves the lifecycle it held before archival.

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

Route behavior:

- direct deep links render the same complete entity surface;
- the inventory command header belongs only to List, Board, Rejected, and
  Archived surfaces. Full Todo detail does not retain `Filter Todos`, layout or
  surface switches, or `New Todo` above the document;
- `Open details` from preview reaches this route, and a visible back action
  returns to the originating Todo surface, layout, query, and scroll position;
- the document remains readable at approximately 820px;
- use one continuous document surface. Linked Discussions, Work Sessions, and
  Automation Sessions belong to Work; do not add a permanent Todo context rail,
  modal, scrim, repeated full-boundary panels, or nested card stack;

### References

- Todo detail places one flat `References` region between `Todo content` and
  `Plan`. The region keeps `Add files` reachable even when its list is empty.
  References are never a Board card, preview control, tab, separate attachment
  page, or count badge on project surfaces.
- `Add files` opens the native multi-file picker and the surrounding drop target
  accepts drag-and-drop. The button remains the keyboard/touch alternative and
  all uploads activate serially using the latest Todo revision from the prior
  mutation response.
- PRDs, design documents, logs, images, PDFs, and any other supported
  files belong in `References`. They are attachments to the Todo, not a special
  Todo content type and not a reason to rename or reinterpret the canonical
  `content` field.
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
