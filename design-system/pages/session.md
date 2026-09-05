# Session Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. This file defines Session-specific
> hierarchy and interaction rules.

## Purpose

The Session page is a durable engineering workspace, not a chat transcript. It
must let the user understand the objective, conversation, live Execution, tool
activity, delegated Agents, changes, context, and next input without navigating
away.

## Prototype Coverage

- `../prototypes/session.html` is a representative state sample, not a literal
  copy of one persisted Session.
- Synthetic content is allowed when it is needed to expose the current product
  states, but every state must use the current component hierarchy, labels,
  visual semantics, and interaction rules.
- The default `view=detail&sample=running` fixture contains one collapsed,
  completed historical Segment followed by one expanded live Segment. Expanding
  the historical Segment exposes grouped ordinary Tool Runs, visible Reasoning,
  one intentionally empty Reasoning boundary with no row, settled singleton
  mutation and Bash calls, Delegation, Recovery, and Compaction. The live
  Segment exposes the current mutation and active Bash call in the same timeline
  language. The Queue and the Agents/Changes/Context Inspector are present in
  this fixture.
- `sample=permission` and `sample=question` are separate paused Work fixtures for
  the two current HITL presentations; one concrete Session shows only its active
  request family. `sample=ready` exposes a settled `ask_user` record and visible
  final response. `sample=automation-license-failed` exposes the failed singleton
  Bash presentation. `sample=direct-completed` and `sample=automation-run`
  exercise completed source-only Session shells.
- The default Inspector fixture truthfully contains `Agents 3` and `Changes 3`;
  its child rows demonstrate Completed and Running graphical states with
  accessible names.
- Do not replace this representative sample with whichever live Session happens
  to contain the least content.

## Layout

- A Todo-bound Session uses the complete Todo-first workbench shell:
  `project rail → Todo navigation → compact Todo shell → conditional Session
  context → Session canvas → context inspector`.
- A Direct Session, or an Automation Session whose source has no Todo, uses one
  compact Session shell entered from `Runs` or `Schedules`. Never fabricate
  Todo identity, Todo/Work navigation, Todo content, Plan, or references for these sources.
- Let conversation structure, Work, tools, code, tables, Diffs, and the Composer
  use the available Session canvas with safe horizontal gutters.
- Constrain only long Agent prose to a 65–72ch reading measure. User messages
  may reach 640px and align right.
- Let the conversation and Composer Dock share the Session canvas vertically;
  the dock must not overlay conversation content.
- Reserve the vertical scrollbar gutter on the scrolling edge only. The
  Composer compensates by half that gutter so its centered column remains
  stable without shifting the transcript away from the prototype alignment.
- The Session conversation uses the prototype's normal 15px scrollbar gutter,
  rather than inheriting the workbench-wide thin scrollbar.
- Preserve desktop resize, collapse, and persisted-width behavior for the
  Context Inspector. Do not add a separate focus-mode control.
- At `>1260px`, Context Inspector remains the desktop grid column and does not
  consume Session canvas width when collapsed.
- At `≤1260px`, Context Inspector becomes a right overlay. For Todo-bound work it
  begins below the two compact shell bands: 108px normally, 115px when the
  touch-sized Session context row applies, and 145px when the Todo shell wraps at
  `≤560px`. For Direct/non-Todo Automation work it begins below the single 58px
  Session shell. Its scrim uses the same top inset and never covers shell context.
- At `≤980px`, Todo navigation becomes a left drawer while the 48px project rail
  remains visible. This responsive change must not add another header row.

## Content Order

1. Source-appropriate compact shell: Todo shell plus conditional Session context
   for Todo-bound work, or one compact Session shell for Direct/non-Todo
   Automation work.
2. User message.
3. The relevant Execution rendered as a Work disclosure.
4. The final Agent response, when one exists, outside the Work disclosure.
5. Hybrid Composer Dock at the bottom of the Session canvas.
6. Context Inspector with Agents, Changes, and Context.

Do not insert a separate activation-source banner or objective card between the
header and conversation. Do not move Execution into the inspector.

## Session Header

- The compact Session context owns the Session title plus current state.
- The title is static text, not a related-Session picker. Cross-Session
  navigation remains in the `Runs` presentation of the canonical Session
  inventory; do not add a second
  header navigation mechanism from prototype-only sample relationships.
- Its metadata line is:
  `Session kind · working directory · {Tool count} tools · {Token usage} tokens · source`.
- Tool count and Token usage are retained because they provide useful activity
  and consumption orientation at a glance.
- Do not show Execution number, model/variant, or message count in the header.
- The path truncates first. The Tool/Token pair remains intact and uses tabular
  figures. Source context is quiet and may truncate only when necessary.
- At `≤760px`, hide the path, separators, and source context; keep the Tool/Token
  pair visible beneath the title.
- Todo/source context stays in this second line rather than consuming a separate
  row above the conversation.
- Source copy is explicit and compact: `Todo · Work`, `Todo · Discussion`,
  `Todo · Automation setup`, `Automation`, or `Direct`. Do not query,
  subscribe to, or display a Todo reference count; do not add a banner, card,
  Tab, or navigation entry.
- Direct and non-Todo Automation Sessions use the same Session title/state and
  metrics contract, but replace Todo reference context with their truthful
  `Direct` or `Automation` source and omit the Todo shell entirely.

## Todo and Work Hierarchy

- The selected Todo owns one persistent compact shell header. It combines the
  content-derived Todo display lead, lifecycle state, and the `Todo / Work`
  local navigation in one horizontal band on desktop. The display lead follows
  the canonical derivation in `pages/todos.md` and never becomes a persisted
  title field. Do not render those elements as separate full-width headers. The
  Work-list filter and type controls remain inside the Work-list content toolbar
  rather than entering this shell header.
- Do not show a shortened Todo UUID as a permanent header eyebrow or sidebar
  footer. The route and object data preserve the full UUID; expose a deliberate
  copy/detail affordance only where identity is actually needed.
- A concrete Session adds one conditional compact context header below the Todo
  shell. It owns `All work`, the Session title/type/checkout, Session state, and
  the Session-scoped Inspector toggle. Todo detail and the Work list do not
  reserve this second row. Never stack a separate Todo header, local-navigation
  row, and Session header as three full-width bands.
- A Session without a Todo does not use this two-level hierarchy. It opens from
  `Runs` or `Schedules` in a single compact Session shell, with its truthful
  Direct or Automation source and no Todo-only surfaces.
- The Todo-first shell has exactly two local destinations in this order:
  **Todo** and **Work**. `Todo` is the canonical detail surface for the selected
  Todo; `Work` first opens the linked root-Session list. Selecting a Work row
  drills into that Session without changing the active Work destination.
- Do not add peer `Changes` or `Runs` tabs. Changes belongs to the selected
  Session family's current checkout and stays in its Inspector. Durable
  `SessionExecutionRun` records remain Execution internals and must not be
  renamed into Todo-level attempts.
- Work list rows distinguish Discussion, Work Session, and Automation Session;
  show state, useful recency, and branch/worktree only when authoritative. The
  list supports real New Discussion, New Work Session, and Create Automation
  actions. It is a scalable list/detail route, never a single dropdown.
- When search or type filters hide every linked Work row, keep the toolbar
  visible, name the active query/type cause, and offer one `Reset filters`
  action that clears both controls. This is the shared filter no-results state,
  not a first-use or creation state.
- Work detail exposes one compact `All work` back action and preserves Work-list
  filter/scroll state. Direct Work-detail links fall back to the Work list when
  Back has no in-shell parent.
- A Todo deep link opens this same shell with `Todo` selected. Do not keep a
  second visually equivalent Todo detail page or add an `Open Todo` action that
  loops back to the object the user is already viewing.
- The production route contract keeps one canonical identity for every concrete
  Session: `/projects/:slug/sessions/:sessionId`. A Todo-bound Session uses its
  immutable source to render the selected Todo shell and keep Work active; it is
  not duplicated under `/todos/:todoId/work/:sessionId`. The Todo object remains
  canonical at `/projects/:slug/todos/:todoId`.
- The supporting prototype keeps visible surfaces explicit with local fixture
  parameters: `view=todo` opens Todo detail, `view=work` opens the linked-work
  list, and `view=detail` simulates one concrete canonical Session while Work
  remains selected. `sample` chooses representative content only and must never
  be copied as a production identity or route contract.
- Runs inventory rows, Automation Invocation rows, Needs-you rows, search
  results, New Session, and linked Work rows open the exact canonical Session
  URL. Todo inventory rows open the exact canonical Todo URL.
- The Todo surface keeps its real lifecycle control band above the canonical
  document. Moving among Idea, Ready, In Progress, and Done mutates the Todo;
  Reject and Archive/Restore remain available without being mistaken for
  Session Execution status.
- Lifecycle buttons use the shared Todo lifecycle icon and tone map: neutral
  `spark`, brand `play`, live `activity`, and success `check`.
- The canonical document is ordered as
  **Todo content → References → Plan → Result when trusted final output exists**.
  This preserves `Intent → inputs → implementation guidance → accepted/review
  outcome` without nested tabs, accordions, cards, or a second copy of Todo data.
- `Todo content` renders the complete canonical Todo `content` and exposes the
  existing `Edit → Save / Cancel` flow. The content's first Markdown heading may
  visually lead the document but must not become a second persisted title.
  Do not label rendered content `Markdown`; keep only useful freshness metadata
  such as the relative update time. Stable IDs belong to object identity, not a
  repeated metadata row.
- Todo IDs are UUIDs. A compact display may mechanically shorten the UUID, but
  must not invent sequential identities such as `Todo #142`. Any path, API
  value, deep link, or tooltip that claims precision uses the real full ID.
- `References` owns the existing canonical management contract: Add files,
  upload progress and failure recovery, `Open` for safe image/PDF bytes,
  `Download` for other content, and `Remove`. Use flat rows with the 36px type
  marker, filename, size, and media type. PRDs, design documents, logs, images,
  PDFs, and other supporting files belong here; none of them changes or
  specializes the Todo content model. The concise live-use explanation is:
  `Supporting files such as PRDs, designs, logs, and images stay in this project.
  Agent work can read the current set; images may be sent to the selected model
  provider.` Already-started model and tool calls do not change.
- A prototype fixture without backing bytes renders `Open` / `Download`
  disabled and identifies itself as reference-only. A file attached during the
  prototype session uses its real local object URL for Open or Download. Never
  show a success toast for an action that did not open or download bytes.
- `Plan` is exactly the ordinary `.archcode/plans/<Todo UUID>.md` file. The API
  returns only `path`, `markdown`, and `updatedAt`; never add Plan ID, status,
  owner, approval, completion, version, or progress state.
- Plan presentation follows the current product renderer: demote every Markdown
  heading two levels below the owning page/section, preserve fenced code, and
  render the resulting Markdown document including lists, tables, links, and
  code blocks. A representative prototype may show the builtin Plan structure,
  but it must not imply that `Approach / Verification` is a fixed schema.
- Preserve the real Plan state matrix:
  - absent (`plan: null`): no full document region; show one compact optional
    context starter with `Generate Plan`;
  - opening the coordination flow: the action alone becomes `Opening…` with a
    spinner and blocks only duplicate Plan actions;
  - present with content: show `Plan`, the exact path, rendered Markdown, and
    `Improve`;
  - present but empty: show `Plan file exists but is empty. Continue the
    Discussion to fill it in.`;
  - loading: show `Loading Plan…`;
  - read failure: show `Could not load Plan: …` with a retry path.
- `Generate Plan` and `Improve` reuse the existing Todo Plan coordination:
  resume an idle Discussion when possible, otherwise create a new Plan
  Discussion and open its real Work. Do not invent a persistent `Generating`
  Plan state or write the Plan directly from the button.
- Keep one continuous document surface with horizontal section rules. Optional
  starters and errors remain compact rows; do not turn absent content into a
  large empty card.
- `Result` appears only when the latest eligible completed Work Session exposes
  trusted final output. Before Done it is `Result for review`; after explicit
  acceptance it is `Accepted outcome`. Tool-only completion without trusted
  final output does not create an empty Result section.

## Conversation Hierarchy

- User messages align right on one flat muted surface without becoming oversized
  chat bubbles.
- The current prototype gives that single user-intent surface a stable 1px
  quiet structural border, 10px radius, one inset top edge, and a neutral
  same-family surface gradient. It has no avatar, colored outline, or floating
  outer shadow.
- Agent responses use the full-width structural surface; code, tables, Mermaid,
  and other technical blocks may use the available canvas.
- Agent responses are editorial text, not bubbles. Avoid avatars, role headers,
  timestamps, and cards competing with the actual outcome.
- Use spacing and contrast, not additional boxes, to separate user intent,
  process disclosure, and final outcome.

## Work and Final Response

The Session page uses progressive disclosure at the Execution boundary:

```text
completed:  user message → collapsed Work → visible final response
running:    user message → expanded Work
HITL pause: user message → expanded paused Work + independent decision disclosure
```

- `Work` is the visual disclosure for one Web-projected Work Segment inside one
  authoritative Execution. Each canonical UserMessage starts a new Segment;
  adjacent steering or queued inputs therefore remain independently foldable
  without inventing a second Execution. A Segment never merges Executions or
  infers ownership from visual proximity.
- A completed Work summary reads `Worked for {duration}` and may append
  ` · {N} tools` when that Segment contains one or more settled Tool calls.
  Count settled calls, not visual Tool Run groups; use `1 tool` for the singular
  form and omit the aggregate when it is zero. This aggregate is Segment-scoped;
  the Session-header Tool count remains Session-scoped.
- A running summary reads `Working for {duration}` (prototype) or `Working ·
  {duration}` and may append `— {current activity}`. It never shows a changing
  Tool count while the Segment is live.
- When Work is waiting on the user, the fold uses **`Paused · Worked for
  {duration}`** (or equivalent time/mechanism copy) and may append the same
  settled Segment Tool aggregate. Do **not** put product `Needs you` on the Work
  chevron row; that slogan belongs on the Session header badge and Composer state
  only.
- Do not show `Execution {number}`, steps, Child count, model, binding metadata,
  or any other runtime aggregate in the visible Work row. The settled,
  Segment-scoped Tool aggregate above is the only permitted Work-row count.
- Preserve the Execution identity in product data even though it is visually
  omitted.
- Only the latest Segment of a running Execution may read `Working` and
  auto-expand. Earlier completed Segments in that same Execution read `Worked`
  and remain collapsed by default.
- When a Question or Permission suspends the latest Execution, its latest Work
  Segment also defaults open so the Agent commentary immediately before the
  decision remains readable. This applies on live transition, refresh, route
  re-entry, and owner deep links. A user's manual Work choice wins for the
  current route lifecycle and is not overwritten by later snapshots.
- When the latest Segment receives its final Agent response, it becomes
  completed and auto-collapses under the existing near-bottom/manual-override
  rules. The final response stays visible below the fold.
- When a followed live Execution completes, collapse Work only if the user is
  still near the bottom and has not manually changed that disclosure.
- The final Agent response is ordinary editorial text below Work. It is never
  hidden by the Work disclosure and never restyled as a status card.
- If an Execution stops, waits for the user, or completes through a Tool without
  final Agent text, do not invent an empty final-response block. Keep the
  terminal state and recovery path in Work.
- Earlier Agent commentary, reasoning, Tools, delegated work, recovery, and
  compression remain inside Work.
- Do not prefix Work commentary or final responses with an Agent avatar, Agent
  name, Profile chip, or timestamp. Agent identity stays in the Session shell
  and Context Inspector; a child Session may identify its owner once in the
  child-Session heading, not before every message.
- If the final model message contains reasoning followed by text, keep the
  reasoning inside Work and render only the final text outside.

### Work summary row

- Use a compact 36px visual row on precise pointers and a minimum 44px row on
  coarse pointers.
- Put the chevron first. Running Work adds one small live pulse before
  `Working`; completed Work needs no repeated success icon.
- The label is 13px/600. Duration and the optional settled Tool aggregate use
  tabular figures and remain on the same line. At narrow widths, omit the Tool
  aggregate before losing the duration or state label.
- A running current-activity label is quiet, single-line, and separated with an
  em dash. Truncate it before expanding the Work row into multiple metadata
  lines.
- Use a transparent surface with only a neutral hover field. Do not wrap Work in
  a raised card, add a large colored badge, repeat the user prompt, or show a
  second metadata row.
- Completed Work keeps the neutral 1px body spine and divider. Running/live Work
  may strengthen the body spine to 2px and mix a restrained live tone into that
  spine and the remaining summary divider; paused Work uses the same treatment
  with attention tone. The visible label/pulse still carries the meaning, so
  the line is never the only state signal.
- Work summaries and nested activity use the full Session thread width; do not
  reintroduce a narrower activity-lane cap inside the conversation column.
- The chevron rotates 160ms. Do not animate disclosure height.
- Opening Work may use the prototype's 180ms opacity plus 4px vertical reveal,
  and the summary may use one matching settle response when its state changes.
  Both are one-shot, preserve layout, and disappear under reduced motion.

### Scroll and disclosure behavior

- Expanding or collapsing Work preserves the disclosure row at the same viewport
  position. It must never trigger the live “follow bottom” behavior.
- Streaming updates follow the bottom only while the user is within the existing
  near-bottom threshold.
- Reading historical content disables live following until the user returns to
  the bottom.
- A user-explicit Work state wins over automatic defaults for the current route
  lifetime.
- Keyboard focus remains on the disclosure button after opening or closing.

## Work content

- Do not add a binding row before the timeline. Agent/Profile/model details
  remain available in the Context Inspector or deeper context surfaces.
- Work commentary uses 13–14px secondary text and appears only when it explains
  intent, a decision, a transition, or a result.
- Historical Work may contain settled Tool Runs, singleton mutation/Bash calls,
  delegated Agent work, recovery, compaction, and meaningful commentary.
- Live Work normally shows the latest useful commentary plus one concise active
  tool or delegated-Agent line. Avoid a large live-state panel or a synthetic
  step timeline when there is no user-relevant state to show.
- Lime is limited to the small live pulse or active-item indicator. Completed
  ordinary tool rows are neutral; delegation may use indigo.

## Tool Runs and Expansion

- Tool details remain inside Work; do not move them to the Context Inspector.
- Within one Execution, project two or more consecutive ordinary tool calls as
  one Tool Run, even when model steps create multiple Assistant messages.
- Reasoning with displayable text is a dedicated Work timeline disclosure and a
  hard Tool Run boundary. When that text exists, preserve `Tool → Reasoning →
  Tool` in that exact visual order and never move Reasoning into a Tool Run. A
  Reasoning event with no displayable text still preserves the projection
  boundary but renders no standalone row: do not show `Reasoning unavailable`,
  token-only placeholders, or an invented summary. Rendered Assistant text,
  `delegate`, `ask_user`, Recovery, and Compaction are also hard boundaries.
- Once every call settles, the collapsed row shows the canonical tool names in
  authoritative order, separated by comma and space:
  `file_read, grep, glob, lsp_diagnostics`.
- Do not show a count, `Completed` label, representative target, or repeated
  success glyph on this settled group row.
- The chevron sits at the left edge. Tool names use readable 12–13px monospace
  text rather than tiny metadata.
- Reasoning, Tool Run, expandable singleton, and flat Tool child rows use the
  same 36px precise-pointer rhythm as Work, with a minimum 44px target on
  coarse pointers.
- Tool Run expansion reveals one flat ordered call list. Reasoning and ordinary
  Agent commentary remain independent timeline modules outside the group.
- Each successful ordinary child row shows
  `canonical tool name + human-scale target` and is not independently
  expandable. Failed, unknown-outcome, and artifact-backed rows keep one focused
  details affordance for diagnosis and output recovery. Examples:
  `file_read registry.ts`, `grep ".archcode/runtime"`,
  `lsp_diagnostics runtime.ts`.
- Do not reduce an ordinary file/search call to only `File read` or `grep`; the
  user must be able to see what it acted on.
- A singleton call renders directly as one collapsed ToolCard, without an
  additional Tool Run disclosure.
- Ordinary read/search calls do not expose raw argument tables or verbose result
  metadata by default.
- A file mutation row shows:
  `tool name + file target + diffstat`; expansion reveals the Diff or mutation
  preview.
- A Bash row shows the exact command in the collapsed row. Expansion reveals
  the terminal output plus exit code, duration, and concise result.
- `delegate`, `ask_user`, Recovery, and Compaction retain their dedicated
  presentation.
- An `ask_user` result with one finalized, displayable answer group collapses to
  `Question answered · {available answer summary}`. Join multiple selected
  answers from that group in their authoritative order, then mechanically
  truncate to one line rather than paraphrasing.
- A complete multi-question result collapses to `{N} questions answered`. A
  bounded presentation marked `truncated` uses `Answer recorded · details
  truncated` instead of guessing omitted text or counts. Expansion shows only
  the finalized Q/A groups actually available to the Web and identifies
  truncation when present. Cancelled or failed calls retain their terminal/error
  presentation and never read `answered`.
- Pending `ask_user` remains actionable exclusively in the existing Composer
  HITL surface. This change introduces no pending ToolCard state, badge, or
  response controls; any already-projected Work context remains read-only.
- When that pending call settles, append its terminal `ask_user` record to the
  same current Work Segment, preserve the exact available question and answer,
  and increment that Segment's settled-call count once. Resuming continues the
  same Execution; never update an unrelated historical record or fixture.
- Delegation, Recovery, and Compaction use one nested record shell: 6px radius,
  default border, 10px horizontal header/content padding, and no raised outer
  shadow. Delegation alone may tint that border with brand to show child work.

## Context Inspector

Keep the three tabs: **Agents**, **Changes**, **Context**. Do not host HITL
Approve/Reject, Goal editing, or Queue management here — those stay in the
Composer dock and main canvas. Do not move the dark-mode switch here; it remains
on the project rail.

The Inspector exists only in Work detail (including its full-diff child view).
Todo content and the Work list have no selected Session and therefore no
Session Inspector. Hiding it at those levels also removes its reserved desktop
column rather than leaving an empty rail.

### Shell

- Default width **312px** (resize 280–460px); collapse preserves the last
  expanded width.
- **No summary strip** above the tab bar. Do not restate Session status, agent
  count, or file count as a chrome line — those already live on the Session
  header/Composer, Agents/Changes tab badges, and Context property rows.
- The current fixture carries the truthful inline counts `Agents 3` and
  `Changes 3`; Context has no invented count. Counts are quiet 9.5px monospace
  brand text, not badges or filled fields. The active tab uses a 2px brand
  underline inset 7px from each edge and aligned to the tab-bar bottom rule,
  not a filled pill block.
- The 9.5px floor is reserved for inline tab counts and compact tertiary
  summary keys/figures. Primary labels remain ~11–12.5px and operational
  metadata ~11–11.5px; ordinary labels never drop to the tertiary floor.

### Agents

- Compact operational tree: Lead root, children indented with a quiet vertical
  guide (depth padding), not heavy L-shaped chrome or per-row card borders.
- Each row: role mark · **Role** + profile · one-line objective · trailing state.
  Skills/profile extras stay muted or hidden by default; do not force a third
  equal-weight text line.
- Selection uses the shared `--selection-field` plus 2px inset brand edge — not
  a large brand wash card. Keyboard focus remains an independent focus-visible
  signal.
- Trailing state uses the shared status map. When Lead is gated, show the HITL
  request family (**`Permission`** or **`Question`**) rather than repeating
  product `Needs you`. Use **`Failed`**, **`Running`**, or **`Completed`** for
  non-gate states.
- A compact ordinary child row may replace the trailing text label with the
  prototype's 13px success check or 6px live pulse when space is constrained.
  The graphic must expose the exact state through an accessible name and title
  (`Completed` or `Running`); color or motion alone is never the label.
- Activating a node selects it in the tree. When the product supports it, also
  switches the main canvas to that child Agent's durable Session. Child views
  are inspect-only in this root workbench: keep one quiet ownership cue above
  the child transcript, while the Composer, Queue, HITL, and Stop/Send control
  remain bound to the root Lead Session. Do not open a second chat surface or
  imply that the root Composer now sends to the selected child.

### Changes

- Label the scope as **Current checkout** or **Working tree**, not “changes made
  by this Session.” The current API projects the selected root Session's cwd;
  multiple root Sessions under one Todo may point at different worktrees, while
  Sessions sharing one cwd may show the same current Diff. Never aggregate those
  into a Todo-level Diff without a future durable ChangeSet/merge-base contract.
- Summary line first: `N files` plus aggregate `+additions −deletions` when known.
- Flat navigable file rows: kind (M/A/D) · mono path · optional per-file diffstat.
  No bordered mini-cards per file.
- Empty state: one muted line such as `No file changes yet.`
- Optional footer action: **Open full diff** into the Session canvas. Row click
  opens that path’s diff in canvas when the product supports it. Full diff keeps
  the complete current-checkout file set and aggregate count; a row deep link
  only expands, focuses, and scrolls to that file rather than filtering the Diff.
- Full diff uses a centered 900px maximum content measure with at least 16px of
  physical inline gutter on each side, inside a stable two-edge scrollbar gutter.

### Context

- Property list (label left / value right), not a stack of bordered cells.
- Priority rows first: **Goal**, **Execution** (binding such as
  `Suspended · Permission`, `Running`, `Completed`).
- Supporting rows: Model/Profile, Tokens (`used / limit` when the model limit is
  authoritatively exposed; otherwise used tokens only, never a fabricated
  denominator), Working directory.
- Goal full prose control remains in Composer; Context only mirrors the binding.

### Density and anti-patterns

- Prefer rows and rules over cards; semantic color only on state dots, short
  labels, and diffstat ±.
- Do not duplicate the transcript, auto-expand every agent/file, or place primary
  Send/Approve actions in the inspector.
- Phase-aware default tab is allowed (Agents while multi-agent live work;
  Changes when review/diff is the job; Context for bindings) without adding tabs.

## Composer

- Composer is always a compact bottom dock with no Composer-level
  expand/collapse state.
- Its desktop input is 15px / 1.45 line-height and grows only to 160px. At
  `≤760px`, use the approved 16px exception to prevent iOS input-focus zoom;
  the current prototype and product must both retain that exception.
- Match the current prototype's horizontal rhythm: the conversation content
  boundary is 852px, while the dock input/priority column is 848px inside a
  900px outer dock measure. Desktop dock padding is 14px top, 26px horizontal,
  and 16px bottom; narrow dock padding is 10px top and 12px on other sides.
  Desktop may reserve the transcript scrollbar gutter for alignment; at
  `<=760px` that gutter is zero so the Composer uses the full narrow canvas.
- The dock reserves layout height but keeps its full-width region visually
  transparent: no top divider, footer fill, blur, or glass. Only the centered
  priority stack and input surface are visible. This creates a floating
  presentation without overlaying or hiding the conversation.
- The dock caps at
  `min(48dvh, 520px)` on desktop or `min(52dvh, 460px)` at `≤760px`. Only the
  priority stack (`HITL → Goal → Queue`) scrolls inside that cap; the input is a
  non-scrolling sibling so its menu can escape above the card.
- Any pending HITL decision — Question or Permission — expands the dock cap to
  `min(78dvh, 640px)`. This is one decision-state exception, not separate layout
  modes for the two request families. Because the value is a maximum, a short
  decision continues to use only its natural height. The larger cap keeps the
  decision, Queue tray, attachments, and terminal action visible together before
  introducing priority-stack scrolling.
- Pending HITL is rendered first and receives the strongest semantic field in
  the dock. Its question or permission and response actions must be immediately
  visible; Goal and Queue never sit above it.
- Composer chrome may show product state **`Needs you`** while a real HITL
  decision is pending (paired with the Session header badge). Tool-level copy
  inside HITL may still say **Permission** / **Question** for the request family.
- Terminal **`Failed`** Sessions keep error tone on both header and Composer
  chrome (`Failed`). Do not restyle failure as amber product `Needs you` merely
  because recovery still needs a human.
- Goal is one compact textual summary showing status and objective with an entry
  to its controls. Never add a Goal progress bar.
- Queued messages remain visible as compact rows with their content and
  management actions. They form a quiet tray inset 8px from the input surface,
  retain their status icon and Steer/Edit/Delete icon actions, and never
  collapse to only a count or `View` control.
- Permission and Question use one decision-sheet language above Queue: a compact
  amber mechanism icon/label, neutral solid surface, collapsible detail where
  applicable, and a clear action footer. Do not use a thick amber left rail.
  Question options remain vertical; selection uses border, radio mark, and a
  quiet brand field instead of an inset left color bar.
- Every pending Permission or Question is itself an independent disclosure,
  open by default. Its collapsed one-line summary retains the request family,
  concise request summary, `Pending`, expand affordance, and `current/total`
  position when several requests exist. Collapsing this sheet does not collapse
  Work, alter the pending HITL state, hide the Composer input, or move to another
  request. Manual sheet state is keyed by `hitlId` for the current route
  lifecycle, survives remount/SSE updates, and is removed when that request is
  no longer pending.
- If an accepted answer or permission cannot be delivered back to its suspended
  execution, keep the attention card visible but present it truthfully as
  **Inspection · Manual inspection**, open it by default, and explain that it
  can no longer accept actions. This inspection state does not retain the
  request's pending disclosure state, expand the pending-only dock cap, show
  Composer `Needs you`, or block ordinary Composer input.
- **Next model picker** (prototype `composer-model-picker`):
  - Trigger shows `Model display name · effort` (effort omitted only when the
    catalog model has no variants).
  - Trigger is 32px high with `10px / 9px` horizontal padding, a 999px radius,
    12px/500 type, a 6px outer gap, and a 5px `Model · effort` inner gap. The
    menu is 308px wide, uses 6px padding and a 12px radius, and opens 8px above
    the trigger.
  - Menu lists **model display names only** — no marketing descriptions
    (“Balanced default…”, etc.). Models are user-added configuration.
  - The project/principal default model, if known, carries a small **Default**
    badge on that row. Do not add a separate “Use Principal default” option for
    ordinary next-run selection in the prototype; product may still expose
    profile-default reset only when the session already holds an explicit
    override (see product `ModelPicker`).
  - Effort section label is **Effort** (not Thinking). Options are free-form
    variant keys from model config (e.g. `fast`, `deep`) plus **Default** when
    no variant is selected. No effort description hints.
  - Selecting a Model, Effort, or explicit-override reset keeps the menu open;
    outside activation or Escape closes it. Pointer opening leaves focus on the
    trigger. Keyboard opening with Enter, Space, ArrowDown, or ArrowUp focuses
    the currently selected model; Arrow/Home/End navigation then moves across
    enabled menu options. Escape closes and restores focus to the trigger.
- **Draft attachments** are chips: file glyph + truncated name + one remove (×)
  control. Size/ready secondary text is optional and may stay hidden at this
  density. No up/down reorder controls — attach order is enough.
- Agent identity and one mutually exclusive terminal action remain in the quiet
  input surface below those priority cues.
- The input surface uses `--elevation-composer` and a stable 1px border.
  Its resting border mixes only a small amount of brand into the structural
  line, and its neutral same-family vertical surface gradient resolves to the
  elevated surface by 78px. Use the Master Composer shadow and 12px radius.
  Focus adds only a restrained outer brand ring and must not introduce a left
  stripe, change border width, or shift layout. Queue and decision sheets use
  weaker separation so the Composer remains the visual anchor.
- The terminal action is one mutually exclusive control. While a Session family
  is active or user-gated, an empty valid draft shows **Stop**; as soon as the
  draft contains sendable text or attachments, the same control becomes the
  **Queue message** arrow. An idle/Ready Session shows the **Send message** arrow
  only when the draft is sendable. Never render Queue/Send and Stop side by
  side. Stop uses a quiet neutral fill and reveals destructive red only on
  hover.
- Queued messages remain visible and manageable above the input. This terminal
  action rule does not turn Queue into a second action button.
- Keyboard submission is local to this Composer: plain `Enter` with a sendable
  draft activates the same mutually exclusive terminal action (`Send` when
  idle, `Queue` while active or user-gated). `Shift+Enter` inserts a newline;
  modified Enter combinations remain available to the platform; IME composition
  (`isComposing` or key code 229) never submits. Plain Enter on an empty draft
  does nothing and must never trigger Stop. Do not register a document-level or
  application-wide Enter handler for this behavior.
- When the terminal action changes among Stop, Queue, and Send, it may use one
  180ms opacity/scale settle response. New Queue rows may enter over 140ms and a
  newly visible HITL decision sheet over 180ms. These transitions never add a
  second action, change bounds, or survive reduced motion.
- On very narrow layouts, hide secondary model/effort metadata before removing
  Agent identity or the primary Queue/Send/Stop controls.

## Session-Specific Avoidances

- chat bubbles for every Agent message;
- hiding tools behind a separate route;
- a terminal-only Execution treatment;
- hiding the final Agent response inside Work;
- a second outer Execution card around Work and the final response;
- auto-scrolling to the bottom when the user opens historical Work;
- an expandable Composer or Goal progress bar;
- HITL placed below Goal, Queue, or ordinary input;
- live lime used on completed rows;
- stacked product `Needs you` labels on Work or agent tree in addition to
  header + Composer;
- an inspector summary strip that restates status or counts already on tabs;
- model marketing blurbs, a separate Principal-default menu row, or Thinking
  intensity copy with invented effort descriptions;
- attachment reorder arrows on already-attached draft chips;
- inspector card stacks, sub-10px type, or brand-wash agent selection;
- collapsed state that hides the existence of Execution;
- tool output that expands beyond the work canvas;
- raw parameter tables for ordinary read/search tools;
- a completed Tool Run summarized by only its first or last call;
- repeated success/status/count chrome on every settled tool row;
- a generic tool label without the target it acted on;
- a separate activation-source banner above the conversation.
