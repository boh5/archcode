# Todos Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Todos contains three distinct
> surfaces: Board, Rejected, and Archived. All three must be implemented and
> remain reachable from the header switcher.

## Purpose

Project Todos capture intent, shape it with Lead, and connect it to execution.
They are project-owned lifecycle entities, not Session-local checklists.

## Shared Structure

- Context Inspector is absent on Todos.
- Keep the project rail and project navigation.
- Header contains the title, purpose, and the three-way
  `Board / Rejected / Archived` switcher.
- Place quick capture directly below the header.
- Main Todo content may use up to 1500px because Board lanes need horizontal
  working space.
- A selected Todo opens a right detail drawer without navigating away.

## Board Surface

Desktop uses four lanes:

1. Ideas — captured intent that still needs shaping.
2. Ready — clear enough to start or hand off.
3. In Progress — connected to active Session or Automation work.
4. Done — completed intent that may be reopened or archived.

Responsive columns:

| Width | Columns |
|---|---:|
| `>1180px` | 4 |
| `621–1180px` | 2 |
| `≤620px` | 1 |

Lane rules:

- Lanes are layout columns, not large rounded containers.
- Lane headers use a status orbit, title, short explanation, and count.
- Cards use one border, 6px radius, and no elevation.
- Card order is state → title → linked work/status → next action.
- Selection uses an indigo inset rule and border change.
- Running linked work uses lime only on the relevant status marker.

## Rejected Surface

- Use a flat list at a maximum width of 980px.
- Every row preserves the rejected title and reason.
- Primary recovery is `Restore to Idea`.
- Use amber for the rejected/reconsideration signal, never destructive red.
- Do not mix Rejected items back into the active Board.

## Archived Surface

- Use the same flat-list structure as Rejected for visual continuity.
- Show origin/state and archived date.
- Primary recovery is `Restore`.
- Archived work remains recoverable but visually quiet.
- Do not replace the list with a hidden archive menu.

## Quick Capture

- One horizontal input surface on desktop:
  `plus icon → title input → New Todo`.
- At `≤620px`, the primary action moves below the input rather than shrinking
  the title field.
- Capture creates intent only; it must not imply that execution has started.

## Todo Detail Drawer

The drawer preserves:

- title and lifecycle state;
- objective;
- confirmed decisions and unresolved decisions;
- linked Discussion, Session, or Automation;
- lifecycle-appropriate primary and secondary actions.

The entity and its actions are mandatory. Visual redesign may reorder or
reweight actions, but must not silently remove them.

Drawer behavior:

- maximum width 430px;
- right-side overlay with scrim and visible close action;
- at narrow widths, leave an 18px outer margin and start below the taller Todo
  header;
- use thin section rules instead of nested cards;
- unresolved decisions use an amber marker plus text.

## Todos-Specific Avoidances

- omitting Rejected or Archived because Board is the primary surface;
- treating Todos as a generic Kanban clone;
- drag-and-drop as the only way to change state;
- large rounded lane containers;
- hiding linked work or lifecycle actions;
- converting the drawer into a modal card stack;
- presenting capture as an AI prompt.
