# Session Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. This file defines Session-specific
> hierarchy and interaction rules.

## Purpose

The Session page is a durable engineering workspace, not a chat transcript. It
must let the user understand the objective, conversation, live Execution, tool
activity, delegated Agents, changes, context, and next input without navigating
away.

## Layout

- Use the complete workbench shell:
  `project rail → project navigation → Session canvas → context inspector`.
- Keep the conversation centered at a 760px reading width.
- Agent responses may reach 740px; user messages may reach 640px and align right.
- Let the conversation and Composer Dock share the Session canvas vertically;
  the dock must not overlay conversation content.
- Preserve desktop resize, collapse, persisted-width, and focus-mode behavior
  for project navigation and Context Inspector.
- At `≤1180px`, Context Inspector becomes a right overlay.
- At `≤760px`, project navigation also becomes an overlay; the 44px project rail
  remains visible.

## Content Order

1. Session header with title, project/worktree context, Todo status, and Inspector.
2. Objective block with Agent, Profile, start time, title, and short rationale.
3. User message.
4. The relevant Execution rendered as a Work disclosure.
5. The final Agent response, when one exists, outside the Work disclosure.
6. Hybrid Composer Dock at the bottom of the Session canvas.
7. Context Inspector with Agents, Changes, and Context.

Do not move Execution into the inspector or replace it with a small status pill.

## Work and Final Response

The Session page uses progressive disclosure at the Execution boundary:

```text
completed:  user message → collapsed Work → visible final response
running:    user message → expanded Work
```

- `Work` is the visual disclosure for one authoritative Execution. It does not
  merge multiple Executions or infer ownership from visual proximity.
- A completed Work summary reads `Worked for {duration}`. A running summary
  reads `Working · {duration}`. Keep `Execution {number}`, steps, Tool count,
  and Child count as quiet metadata on the same row.
- Running Work is expanded by default. Historical completed Work is collapsed
  by default.
- When a followed live Execution completes, collapse Work only if the user is
  still near the bottom and has not manually changed that disclosure.
- The final Agent response is ordinary editorial text below Work. It is never
  hidden by the Work disclosure and never restyled as a status card.
- If an Execution stops, waits for the user, or completes through a Tool without
  final Agent text, do not invent an empty final-response block. Keep the
  terminal state and recovery path in Work.
- Earlier Agent commentary, reasoning, Tools, delegated work, recovery,
  compression, and model binding remain inside Work.
- If the final model message contains reasoning followed by text, keep the
  reasoning inside Work and render only the final text outside.

### Work summary row

- Minimum hit target: 44px.
- Leading state uses icon plus text: live pulse + `Working`, check +
  `Worked for`, question + `Needs you`, stop/error icon + the terminal label.
- The label is 11px/650 and is the strongest content in the row.
- Duration uses tabular figures. Counts and `Execution {number}` use quiet
  9px metadata and may wrap below the label on narrow screens.
- Use thin rules and a neutral hover field. Do not wrap Work in a raised card,
  add a large colored badge, or repeat the user prompt as an Execution title.
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
- `aria-expanded`, `aria-controls`, and an accessible name containing the
  Execution number and state are required.

## Work content

- The binding row shows Lead/Profile, model/variant, and continuity state.
- Timeline rows distinguish:
  - collapsed Tool Runs;
  - singleton tool calls;
  - delegated Agent work;
  - currently running command or tool.
- Running work receives the lime field and pulse. Completed work uses green;
  delegation uses indigo.

## Tool Runs and Expansion

- Tool details remain inside Work; do not move them to the Context Inspector.
- Within one Execution, project two or more consecutive ordinary tool calls as
  one Tool Run, even when model steps create multiple Assistant messages.
- Reasoning emitted around tool-calling steps stays inside the same Tool Run.
  Rendered Assistant text, `delegate`, `ask_user`, Recovery, and Compaction are
  hard boundaries.
- While any call remains pending or running, the collapsed row shows the last
  tool in authoritative order. This same last-entry rule applies to parallel
  calls.
- Once every call settles, the collapsed row returns to the first tool call.
  Keep only a quiet numeric count; do not reintroduce semantic labels from the
  retired read-only aggregation.
- Use the same row grammar for Tool Runs and singleton ToolCards: status glyph
  at the left edge, disclosure chevron at the right edge. A Tool Run differs
  only by its numeric count.
- Tool Run expansion reveals the flat ordered call list and its reasoning.
- Each child ToolCard expands independently to show its path and result.
- A singleton call renders directly as one collapsed ToolCard, without an
  additional Tool Run disclosure.
- An expanded write ToolCard includes:
  1. input parameters;
  2. Diff or mutation preview;
  3. completion status;
  4. observed and stored output quantities.
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
- tool output that expands beyond the work canvas.
