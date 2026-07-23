# Signal Workbench Design-System Package

This directory persists the approved Signal Workbench prototype as a reusable
Master + Page Overrides design system.

## Reading Order

1. Read [`MASTER.md`](MASTER.md).
2. Read the relevant page file:
   - [`pages/session.md`](pages/session.md)
   - [`pages/dashboard.md`](pages/dashboard.md)
   - [`pages/todos.md`](pages/todos.md)
3. Use the interactive prototype for rendered behavior:
   [`../../index.html`](../../index.html).

Page files override the Master only where they explicitly differ.

## Artifact Map

| Artifact | Purpose |
|---|---|
| `MASTER.md` | Brand, tokens, typography, layout, components, motion, accessibility, forbidden patterns |
| `pages/session.md` | Conversation, Work/final-response hierarchy, tool expansion, inspector, composer |
| `pages/dashboard.md` | Attention/running/resumption/upcoming hierarchy |
| `pages/todos.md` | Board, Rejected, Archived, capture, and Todo detail drawer |
| `../../styles.css` | Exact prototype token and component implementation |
| `../../app.js` | Prototype interaction states |

This package documents design intent. It does not authorize removing or
renaming existing product entities or changing backend behavior.
