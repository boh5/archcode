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
- Keep the sample compact while covering: completed and suspended Work,
  Reasoning, grouped ordinary Tools, singleton mutation/Bash calls, a failed
  Tool, Delegation, Recovery, Compaction, Permission, Ask User,
  Queue/Steering, a visible final response, and Agent/Changes/Context inspector
  states.
- The Permission and Ask User tabs in the prototype are a state-preview control
  for reviewing both current HITL presentations. The product continues to show
  only the active request family at one time.
- Do not replace this representative sample with whichever live Session happens
  to contain the least content.

## Layout

- Use the complete workbench shell:
  `project rail → project toolbar → Session canvas → context inspector`.
- `Sessions` remains the active project tab for Todo-bound, Automation-bound,
  and Direct Session details. Preserve origin through breadcrumb and source
  metadata rather than changing the active top-level tab.
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
- Preserve desktop resize, collapse, persisted-width, and focus-mode behavior
  for the Context Inspector.
- At `>1180px`, the Project Toolbar spans above both the Session canvas and the
  Inspector. The Inspector begins 52px from the viewport top; its 8px resize
  target straddles the boundary without subtracting width from the canvas.
- At `≤1180px`, Context Inspector becomes a right overlay.
- At `761–1180px`, that overlay begins below the Project Toolbar and 64px
  Session header at exactly 116px from the viewport top and includes its own
  top-right Close control.
- At `≤760px`, the project toolbar wraps to keep all three project tabs
  reachable and applies this page's explicit 88px override; the 48px project
  rail remains visible and the Inspector drawer begins below that toolbar. The
  modal scrim still covers the full viewport while the drawer is open.

## Content Order

1. Session header with title/state, working directory, Tool count, Token usage,
   Todo/source context, Todo action, and Inspector action.
2. User message.
3. The relevant Execution rendered as a Work disclosure.
4. The final Agent response, when one exists, outside the Work disclosure.
5. Hybrid Composer Dock at the bottom of the Session canvas.
6. Context Inspector with Agents, Changes, and Context.

Do not insert a separate activation-source banner or objective card between the
header and conversation. Do not move Execution into the inspector.

## Session Header

- First line: Session title plus current state.
- The title is static text, not a related-Session picker. Cross-Session
  navigation remains in the canonical Sessions inventory; do not add a second
  header navigation mechanism from prototype-only sample relationships.
- Second line:
  `working directory · {Tool count} tools · {Token usage} tokens · source`.
- Tool count and Token usage are retained because they provide useful activity
  and consumption orientation at a glance.
- Do not show Execution number, model/variant, or message count in the header.
- The path truncates first. The Tool/Token pair remains intact and uses tabular
  figures. Source context is quiet and may truncate only when necessary.
- At `≤760px`, hide the path, separators, and source context; keep the Tool/Token
  pair visible beneath the title.
- Todo/source context stays in this second line rather than consuming a separate
  row above the conversation.
- For a Session bound to a Todo (including a Todo-origin Automation Session),
  append the quiet static note `Using live Todo references` beside the existing
  source link. Do not query, subscribe to, or display a reference count; do not
  add a banner, card, tab, or navigation entry.

## Conversation Hierarchy

- User messages align right on one flat muted surface without becoming oversized
  chat bubbles.
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
```

- `Work` is the visual disclosure for one authoritative Execution. It does not
  merge multiple Executions or infer ownership from visual proximity.
- A completed Work summary reads `Worked for {duration}`. A running summary
  reads `Working for {duration}` (prototype) or `Working · {duration}` and may
  append `— {current activity}`.
- When Work is waiting on the user, the fold uses **`Paused · Worked for
  {duration}`** (or equivalent time/mechanism copy). Do **not** put product
  `Needs you` on the Work chevron row; that slogan belongs on the Session header
  badge and Composer state only.
- Do not show `Execution {number}`, steps, Tool count, Child count, model, or
  binding metadata in the visible Work row.
- Preserve the Execution identity in product data even though it is visually
  omitted.
- Running Work is expanded by default. Historical completed Work is collapsed
  by default.
- When a followed live Execution completes, collapse Work only if the user is
  still near the bottom and has not manually changed that disclosure.
- The final Agent response is ordinary editorial text below Work. It is never
  hidden by the Work disclosure and never restyled as a status card.
- If an Execution stops, waits for the user, or completes through a Tool without
  final Agent text, do not invent an empty final-response block. Keep the
  terminal state and recovery path in Work.
- Earlier Agent commentary, reasoning, Tools, delegated work, recovery, and
  compression remain inside Work.
- If the final model message contains reasoning followed by text, keep the
  reasoning inside Work and render only the final text outside.

### Work summary row

- Use a compact 36px visual row on precise pointers and a minimum 44px row on
  coarse pointers.
- Put the chevron first. Running Work adds one small live pulse before
  `Working`; completed Work needs no repeated success icon.
- The label is 13px/600. Duration uses tabular figures.
- A running current-activity label is quiet, single-line, and separated with an
  em dash. Truncate it before expanding the Work row into multiple metadata
  lines.
- Use a transparent surface with only a neutral hover field. Do not wrap Work in
  a raised card, add a large colored badge, repeat the user prompt, or show a
  second metadata row.
- Work summaries and nested activity use the full Session thread width; do not
  reintroduce a narrower activity-lane cap inside the conversation column.
- The chevron rotates 160ms. Do not animate disclosure height.

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
- Reasoning is a dedicated Work timeline disclosure and a hard Tool Run
  boundary. Preserve `Tool → Reasoning → Tool` in that exact visual order;
  never move Reasoning into a Tool Run or drop it. Rendered Assistant text,
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
- Delegation, Recovery, and Compaction use one nested record shell: 6px radius,
  default border, 10px horizontal header/content padding, and no raised outer
  shadow. Delegation alone may tint that border with brand to show child work.

## Context Inspector

Keep the three tabs: **Agents**, **Changes**, **Context**. Do not host HITL
Approve/Reject, Goal editing, or Queue management here — those stay in the
Composer dock and main canvas. Do not move the dark-mode switch here; it remains
on the project rail.

### Shell

- Default width **312px** (resize 280–460px); collapse and focus mode preserve the
  last expanded width.
- **No summary strip** above the tab bar. Do not restate Session status, agent
  count, or file count as a chrome line — those already live on the Session
  header/Composer, Agents/Changes tab badges, and Context property rows.
- Tab bar may carry counts (`Agents 4`, `Changes 3`). Active tab uses a brand
  underline inset 6px from each edge, not a filled pill block. Counts use a
  quiet 16px-high rounded field; the active count receives a restrained brand
  tint.
- Type floor ≥11px; primary labels ~12–12.5px; meta ~11–11.5px. No sub-11px
  operational text in the inspector.

### Agents

- Compact operational tree: Lead root, children indented with a quiet vertical
  guide (depth padding), not heavy L-shaped chrome or per-row card borders.
- Each row: role mark · **Role** + profile · one-line objective · trailing state.
  Skills/profile extras stay muted or hidden by default; do not force a third
  equal-weight text line.
- Selection: quiet hover field and/or 2px brand inset edge — not a large brand
  wash card.
- Trailing state uses the shared status map. When Lead is gated, show the HITL
  request family (**`Permission`** or **`Question`**) rather than repeating
  product `Needs you`. Use **`Failed`**, **`Running`**, or **`Completed`** for
  non-gate states.
- Activating a node selects it in the tree. When the product supports it, also
  focus or scroll the main transcript to that agent’s turns; do not open a second
  chat surface.

### Changes

- Summary line first: `N files` plus aggregate `+additions −deletions` when known.
- Flat navigable file rows: kind (M/A/D) · mono path · optional per-file diffstat.
  No bordered mini-cards per file.
- Empty state: one muted line such as `No file changes yet.`
- Optional footer action: **Open full diff** into the Session canvas. Row click
  opens that path’s diff in canvas when the product supports it.

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
  900px outer dock measure. Desktop dock padding is 12px top, 26px horizontal,
  and 14px bottom; narrow dock padding is 10px top and 12px on other sides.
  Desktop may reserve the transcript scrollbar gutter for alignment; at
  `<=760px` that gutter is zero so the Composer uses the full narrow canvas.
- The dock uses the base workspace surface and caps at
  `min(48dvh, 520px)` on desktop or `min(52dvh, 460px)` at `≤760px`. Only the
  priority stack (`HITL → Goal → Queue`) scrolls inside that cap; the input is a
  non-scrolling sibling so its menu can escape above the card.
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
  management actions. Never collapse the queue to only a count or `View`
  control.
- **Next model picker** (prototype `composer-model-picker`):
  - Trigger shows `Model display name · effort` (effort omitted only when the
    catalog model has no variants).
  - Trigger is 30px high with `10px / 8px` horizontal padding, a 999px radius,
    12px/520 type, a 6px outer gap, and a 5px `Model · effort` inner gap. The
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
- Agent identity and the current Send/Queue/Stop actions remain in the quiet
  input surface below those priority cues.
- A running Session may queue ordinary messages while Stop remains a separate,
  unmistakable action. Queue retains the primary filled treatment; Stop uses a
  quiet neutral fill and reveals destructive red only on hover.
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
