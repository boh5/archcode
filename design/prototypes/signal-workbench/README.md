# Signal Workbench design prototype

Interactive UI proposal for the ArchCode workbench. It includes:

- Session workspace with live Work streams, collapsed completed Work, always-visible final responses, grouped read-only calls, independently expandable ToolCards, a compact HITL-first Composer Dock, and the Session context inspector
- Project Dashboard
- Project Todos: Board, Rejected, and Archived
- Todo detail drawer
- Light and dark themes
- Responsive, collapsible, resizable project navigation and context inspector

The approved design system is persisted in
[`design-system/signal-workbench/`](design-system/signal-workbench/). Read its
`MASTER.md` and the relevant page override before implementing this direction.

Open `index.html` directly, or serve this directory:

```sh
python3 -m http.server 4181 --bind 127.0.0.1
```
