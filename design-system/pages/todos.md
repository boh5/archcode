# Todos Page Overrides

> Read [`../MASTER.md`](../MASTER.md) first. Todos contains three distinct
> surfaces: Board, Rejected, and Archived. All three must be implemented and
> remain reachable from the header switcher.

## Purpose

Project Todos capture intent, shape it in Discussion, and connect it to execution.
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
| `≥1100px` | 4 |
| `700–1099px` | 2 |
| `<700px` | 1 |

Lane rules:

- Lanes are structural columns with one 1px boundary, an 8px radius, and the
  surface background. At four columns they use a 500px minimum height; stacked
  lanes remain content-sized with a 160px minimum.
- Lane headers use a status orbit, title, short explanation, and count.
- Cards use one border, 6px radius, and no elevation.
- Card order is state → title → optional body preview. Linked Sessions,
  Automations, and lifecycle actions live in the detail drawer.
- Selection changes the card border to indigo.
- Lifecycle state uses its matching status icon plus text; color is secondary.
- Pointer and touch dragging target the lane under the pointer rather than the
  dragged card rectangle; keyboard dragging retains geometric collision
  fallback.

## Rejected Surface

- Use a flat list at a maximum width of 980px.
- Every row preserves the rejected title and reason.
- Primary recovery is `Restore to Idea`.
- Use amber for the rejected/reconsideration signal, never destructive red.
- Do not mix Rejected items back into the active Board.

## Archived Surface

- Use the same flat-list structure as Rejected for visual continuity.
- Show the Todo title and a quiet `Archived` state label.
- Primary recovery is `Restore`.
- Archived work remains recoverable but visually quiet.
- Do not replace the list with a hidden archive menu.

## Quick Capture

- Use one horizontal input surface at every width:
  `plus icon → title input → Add`.
- The input stays flexible; the 32px Add button remains visible and does not
  imply that execution has started.
- Capture creates intent only; it must not imply that execution has started.

## Todo Detail Drawer

The drawer preserves:

- title and lifecycle state;
- Todo body and editing controls;
- linked Discussions, work Sessions, and Automations;
- lifecycle-appropriate primary and secondary actions.

Keep `Edit` with the Todo body. Put workflow and lifecycle controls in one
`Actions` section, using visible labels and flat spacing rather than nested
cards, menus, or collapsible groups:

- `Discuss & Plan` contains Continue Discussion when available, New Discussion,
  and Generate / Improve Plan;
- `Execution` contains Start Work, Continue Work when available, and Create
  Automation, and appears only in lifecycle states where those actions are
  already valid;
- `Lifecycle` contains state movement, Reject/Restore, and Archive/Restore.

Plan shaping remains one fixed secondary action inside `Discuss & Plan`:

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
- while this action is resolving, keep the drawer in place, show explicit
  `Opening Plan…` feedback, prevent only a duplicate Plan action, and place any
  unrecoverable error directly inside the `Discuss & Plan` group;
- open the resulting Discussion;
- keep Plan generation independent from lifecycle state changes, Start Work,
  Goal creation, Automation creation, and persistent Plan-specific workflow
  state.

The entity and its actions are mandatory. Visual redesign may reorder or
reweight actions, but must not silently remove them.

Drawer behavior:

- width is `min(430px, 100% - 18px)`;
- full-height right-side overlay with scrim and visible close action;
- use thin section rules instead of nested cards;

## Todos-Specific Avoidances

- omitting Rejected or Archived because Board is the primary surface;
- treating Todos as a generic Kanban clone;
- drag-and-drop as the only way to change state;
- large rounded lane containers;
- hiding linked work or lifecycle actions;
- converting the drawer into a modal card stack;
- presenting capture as an AI prompt.
