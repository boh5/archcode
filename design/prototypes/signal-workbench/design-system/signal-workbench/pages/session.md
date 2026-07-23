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
3. User and Agent conversation.
4. Execution embedded in the relevant Agent response.
5. Hybrid Composer Dock at the bottom of the Session canvas.
6. Context Inspector with Agents, Changes, and Context.

Do not move Execution into the inspector or replace it with a small status pill.

## Execution

- Execution header is always recognizable as an entity.
- Show `Running/Completed/Failed`, steps, calls, and elapsed time.
- The binding row shows Lead/Profile, model/variant, and continuity state.
- Timeline rows distinguish:
  - grouped completed read-only tools;
  - independent tool calls;
  - delegated Agent work;
  - currently running command or tool.
- Running work receives the lime field and pulse. Completed work uses green;
  delegation uses indigo.

## Tool Aggregation and Expansion

- Aggregate only consecutive completed read-only calls and only at a count of
  two or more.
- Mixed read tools use `Ran N read-only tools`; one repeated tool may use a
  semantic label such as `Read N items`.
- Group expansion reveals all child ToolCards.
- Each child ToolCard expands independently to show its path and result.
- Independent calls retain the same expansion model.
- An expanded write ToolCard includes:
  1. input parameters;
  2. Diff or mutation preview;
  3. completion status;
  4. observed and stored output quantities.
- Running, errored, write, permission, and delegated work remain independent.

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
- an expandable Composer or Goal progress bar;
- HITL placed below Goal, Queue, or ordinary input;
- live lime used on completed rows;
- collapsed state that hides the existence of Execution;
- tool output that expands beyond the work canvas.
