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
  `project rail → project navigation → Session canvas → context inspector`.
- Let conversation structure, Work, tools, code, tables, Diffs, and the Composer
  use the available Session canvas with safe horizontal gutters.
- Constrain only long Agent prose to a 65–72ch reading measure. User messages
  may reach 660px and align right.
- Let the conversation and Composer Dock share the Session canvas vertically;
  the dock must not overlay conversation content.
- Preserve desktop resize, collapse, persisted-width, and focus-mode behavior
  for project navigation and Context Inspector.
- At `≤1180px`, Context Inspector becomes a right overlay.
- At `≤760px`, project navigation also becomes an overlay; the 48px project rail
  remains visible.

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

## Conversation Hierarchy

- User messages use one flat muted surface, 15px text, comfortable 1.66
  line-height, and right alignment. They are visually distinct without becoming
  oversized chat bubbles.
- Work commentary uses secondary 13–14px text. Tool names and Work summaries
  remain quieter than conversational content.
- The final Agent response is the strongest reading layer: 15px primary text,
  1.68 line-height, and a full-width structural surface. Its prose children use
  a 65–72ch reading measure while code, tables, Mermaid, and other technical
  blocks may use the available canvas. Its opening outcome may use 600 weight.
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
  reads `Working · {duration}` and may append `— {current activity}`.
- Do not show `Execution {number}`, steps, Tool count, Child count, model, or
  binding metadata in the visible Work row.
- Preserve the Execution identity in product data even though it is visually
  omitted. The accessible disclosure names the Work segment, state, duration,
  and current activity when present.
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

- Use a compact 32px visual row on precise pointers and a minimum 44px row on
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
- `aria-expanded`, `aria-controls`, and an accessible name containing the Work
  segment, state, elapsed duration, and current activity when present are
  required.

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
- Tool Run and expandable singleton rows remain compact with precise pointers
  and use a minimum 44px target with coarse pointers.
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

## Context Inspector

- Keep the three tabs: Agents, Changes, Context.
- Agents uses a compact tree showing role, title, Skill, Profile, and status.
- Changes shows summary counts and a navigable file list.
- Context shows working directory, model, and execution counters.
- Do not move the dark-mode switch here; it remains on the project rail.

## Composer

- Composer is always a compact bottom dock with no Composer-level
  expand/collapse state.
- Pending HITL is rendered first and receives the strongest semantic field in
  the dock. Its question or permission and response actions must be immediately
  visible; Goal and Queue never sit above it.
- Goal is one compact textual summary showing status and objective with an entry
  to its controls. Never add a Goal progress bar.
- Queued messages remain visible as compact rows with their content and
  management actions. Never collapse the queue to only a count or `View`
  control.
- Agent, Profile, next model, and the current Send/Queue/Stop actions remain in
  the quiet input surface below those priority cues.
- A running Session may queue ordinary messages while Stop remains a separate,
  unmistakable action.
- On very narrow layouts, hide secondary Profile/model metadata before removing
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
- collapsed state that hides the existence of Execution;
- tool output that expands beyond the work canvas;
- raw parameter tables for ordinary read/search tools;
- a completed Tool Run summarized by only its first or last call;
- repeated success/status/count chrome on every settled tool row;
- a generic tool label without the target it acted on;
- a separate activation-source banner above the conversation.
