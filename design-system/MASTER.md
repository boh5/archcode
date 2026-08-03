# Signal Workbench Design System

> Target UI specification synchronized with the current effective prototypes on
> 2026-08-02. Until product implementation catches up, current product code
> remains authoritative for existing runtime behavior and state mechanics.
>
> When designing or implementing a page, read this file first and then read
> `pages/[page-name].md`. A page file overrides this Master only where it says
> so. The current product UI is authoritative. When a current prototype exists,
> use it as a supporting rendered reference:
> [`dashboard.html`](prototypes/dashboard.html),
> [`todos.html`](prototypes/todos.html),
> [`automations.html`](prototypes/automations.html),
> [`sessions.html`](prototypes/sessions.html), or
> [`session.html`](prototypes/session.html).

## Product Fit

Signal Workbench is the visual system for ArchCode: a self-hosted, always-on
workbench for long-running AI engineering work. It is not a generic chat client,
an analytics dashboard, or a marketing-style AI SaaS.

Primary users are developers and small engineering teams who need to:

- see what needs attention;
- understand what is running and why;
- inspect Sessions, Executions, Agents, tool calls, changes, and context;
- shape project Todos without losing their lifecycle or linked work;
- resume long-running work quickly on desktop or a narrow remote viewport.

## Non-Negotiable Product Rules

1. Preserve product entities and their existing functions. Visual simplification
   must never remove Execution, the right context inspector, Todo lifecycle
   states, linked work, dark mode, or existing actions.
2. The workbench mental model stays primary. Do not collapse the product into a
   single chat column.
3. State is shown with text or icon plus color. Color alone is never the only
   signal.
4. The interface is dense, but hierarchy, readable type, and selective
   disclosure must keep it calm.
5. Light and dark modes are designed together. The theme control stays at the
   bottom of the project rail; do not move it into the main header.

## Design Concept

**Quiet operational clarity.** The interface combines the legibility of an
editorial transcript with the compactness of a developer tool. Neutral surfaces
keep the conversation dominant; low-chroma semantic color appears only where it
communicates selection, live work, attention, success, or failure.

Design dials:

| Dial | Value | Meaning |
|---|---:|---|
| Variance | 5/10 | Balanced composition with asymmetric workbench rails |
| Motion | 3/10 | Subtle, state-driven motion only |
| Density | 8/10 | Compact operational information, progressively disclosed |

Core visual principles:

- neutral near-white and charcoal surfaces with visible, restrained separation;
- indigo for selection and intentional actions;
- lime only for live/running signals;
- thin rules and small surface shifts before cards or shadows;
- mostly 4–8px radii;
- user intent, final Agent response, and current work form the dominant reading
  sequence;
- monospace only for code, paths, commands, metrics, and tool names.

## Color System

Use the semantic tokens defined in `apps/web/src/styles/globals.css`. Do not
place raw colors in page-specific components or introduce a second token naming
scheme in prototypes.

### Light Theme

| Token | Value | Role |
|---|---|---|
| `--bg-base` | `#f2f3f0` | Warm-neutral workspace background |
| `--bg-surface` | `#f8f8f6` | Navigation, headers, large work surfaces |
| `--bg-elevated` | `#ffffff` | Inputs, ToolCards, compact controls |
| `--bg-overlay` | `#ffffff` | Drawers, dialogs, and popovers |
| `--bg-muted` | `#eceeea` | User messages and secondary fields |
| `--bg-hover` | `#e6e8e4` | Hover state |
| `--bg-active` | `#dde0da` | Pressed neutral state |
| `--border-subtle` | `#e1e3df` | Internal separators |
| `--border-default` | `#cdd1ca` | Default boundary |
| `--border-strong` | `#9fa69d` | Structural boundary |
| `--control-border` | `var(--border-default)` | Form-control boundary |
| `--text-primary` | `#171917` | Primary text |
| `--text-secondary` | `#424742` | Body and explanation text |
| `--text-tertiary` | `#626a62` | Secondary metadata |
| `--text-muted` | `#747c74` | De-emphasized metadata |
| `--brand` | `#6157d5` | Selection, primary action, active navigation |
| `--brand-hover` | `#5148c1` | Primary action hover |
| `--brand-field` | `#eeecfb` | Explicit brand-tinted field |
| `--brand-ink` | `#ffffff` | Text on brand |
| `--signal` | `#758b22` | Running/live indicator |
| `--signal-ink` | `#151b00` | Text on signal |
| `--signal-foreground` | `#506015` | Live text on neutral surfaces |
| `--signal-field` | `#eef3d8` | Explicit running status field |
| `--success` | `#2f7752` | Completed/success |
| `--success-field` | `#e8f2eb` | Completed field |
| `--warning` | `#8a5e13` | Attention/decision required |
| `--warning-field` | `#f7eddd` | Explicit attention status field |
| `--error` | `#b14840` | Error/destructive/diff removal |
| `--error-field` | `#f8e8e6` | Error/removal field |
| `--neutral` | `#626a62` | Neutral status |
| `--neutral-field` | `#eceeea` | Neutral status field |
| `--selection-field` | `#eeedf8` | Quiet selected row |
| `--running-field` | `#f1f4e7` | Quiet running row |
| `--attention-field` | `#f8f2e8` | Quiet attention band |
| `--rail` | `#eceeea` | Light project rail |
| `--rail-ink` | `#171917` | Active rail content |
| `--rail-muted` | `#626a62` | Inactive rail content |
| `--rail-hover` | `#e1e3df` | Rail hover field |
| `--rail-active` | `#d7dbd4` | Active project field |
| `--rail-border` | `#cdd1ca` | Rail boundaries and separators |
| `--terminal-bg` | `#252620` | Bash output surface |
| `--terminal-text` | `#d7d6cd` | Bash output foreground |
| `--terminal-muted` | `#aaa99f` | Bash process metadata |
| `--terminal-success` | `#b6d84b` | Successful Bash exit |
| `--terminal-error` | `#ed8178` | Failed Bash exit |
| `--focus` | `0 0 0 3px rgb(97 87 213 / 23%)` | Focus ring |

### Dark Theme

| Token | Value | Role |
|---|---|---|
| `--bg-base` | `#101210` | Graphite workspace background |
| `--bg-surface` | `#151815` | Navigation, headers, large work surfaces |
| `--bg-elevated` | `#1c201c` | Inputs, ToolCards, controls |
| `--bg-overlay` | `#1c201c` | Drawers, dialogs, and popovers |
| `--bg-muted` | `#232723` | Secondary fields |
| `--bg-hover` | `#292e29` | Hover state |
| `--bg-active` | `#303630` | Pressed neutral state |
| `--border-subtle` | `#262b26` | Internal separators |
| `--border-default` | `#363c36` | Default boundary |
| `--border-strong` | `#596159` | Structural boundary |
| `--control-border` | `var(--border-default)` | Form-control boundary |
| `--text-primary` | `#f3f5f0` | Primary text |
| `--text-secondary` | `#c9cec6` | Body text |
| `--text-tertiary` | `#9ca49a` | Secondary metadata |
| `--text-muted` | `#868f84` | De-emphasized metadata |
| `--brand` | `#a49bff` | Selection and primary action |
| `--brand-hover` | `#b9b2ff` | Primary action hover |
| `--brand-field` | `#2b2845` | Explicit brand-tinted field |
| `--brand-ink` | `#17181f` | Text on brand |
| `--signal` | `#c1dd64` | Running/live indicator |
| `--signal-ink` | `#202807` | Text on signal |
| `--signal-foreground` | `#d9ec8c` | Live text on neutral surfaces |
| `--signal-field` | `#29331b` | Explicit running status field |
| `--success` | `#82c49a` | Completed/success |
| `--success-field` | `#203329` | Completed field |
| `--warning` | `#deb96e` | Attention/decision required |
| `--warning-field` | `#352b1b` | Explicit attention status field |
| `--error` | `#f08b82` | Error/destructive/diff removal |
| `--error-field` | `#3b2421` | Error/removal field |
| `--neutral` | `#9ca49a` | Neutral status |
| `--neutral-field` | `#232723` | Neutral status field |
| `--selection-field` | `#26243a` | Quiet selected row |
| `--running-field` | `#22291b` | Quiet running row |
| `--attention-field` | `#2c271e` | Quiet attention band |
| `--rail` | `#0c0e0c` | Project rail |
| `--rail-ink` | `#f2f4ef` | Active rail content |
| `--rail-muted` | `#858c83` | Inactive rail content |
| `--rail-hover` | `#1c201c` | Rail hover field |
| `--rail-active` | `#232723` | Active project field |
| `--rail-border` | `#363c36` | Rail boundaries and separators |
| `--terminal-bg` | `#0f100e` | Bash output surface |
| `--terminal-text` | `#dad9d1` | Bash output foreground |
| `--terminal-muted` | `#aaa99f` | Bash process metadata |
| `--terminal-success` | `#b6d84b` | Successful Bash exit |
| `--terminal-error` | `#ed8178` | Failed Bash exit |
| `--focus` | `0 0 0 3px rgb(164 155 255 / 26%)` | Focus ring |

Implementation aliases do not introduce new colors:

- `--info` follows `--brand`;
- `--brand-subtle` and `--info-muted` follow `--brand-field`;
- `--success-muted`, `--warning-muted`, `--error-muted`, and
  `--neutral-muted` follow their matching `*-field` token;
- `--terminal-border` is `rgb(255 255 255 / 10%)` in both themes.

### Color Discipline

- Indigo means selected, navigable, or user-triggered action.
- Lime means currently live or running. Never use it as a general accent.
- Green means completed; amber means attention; red means error/destructive.
- Large surfaces remain neutral. Semantic colors appear as narrow fields,
  status glyphs, short labels, or inset rules.
- Selection, running, and attention use separate low-chroma neutral fields so
  their large surfaces do not become colored blocks.
- Never introduce purple/pink gradients or an orange imitation of another
  developer tool.

## Typography

No network font dependency is required.

```css
--font-stack-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC", sans-serif;
--font-stack-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

Type scale:

| Role | Size | Weight | Notes |
|---|---:|---:|---|
| Dense metadata | 11–12px | 500–700 | Counts, elapsed time, compact state |
| Compact label | 12px | 600–700 | Buttons, row labels, section labels |
| Operational title | 13–14px | 600–680 | Navigation, tool targets, rows |
| Commentary | 13–14px | 400–500 | Process explanation inside Work |
| User message | 15px | 400–500 | User intent |
| Final response | 15px | 400–600 | Agent outcome and supporting detail |
| Session / Todos title | 20px | 600 | Active work or page identity |
| Global Home title | 26px | 700 | Cross-project operational identity |

Rules:

- Conversation text uses 1.62–1.68 line-height. Long prose blocks use a
  65–72ch reading measure; Work, tools, code, tables, Diffs, and message
  structure use the available Session canvas.
- Inline and operational code uses monospace.
- Numeric timers and counters use tabular figures.
- Small text is metadata only. The Session Composer uses 16px input text on
  narrow screens; compact operational inputs follow their page specification.

## Spacing, Radius, and Elevation

Use a 2/4px-derived dense scale:

`2, 4, 6, 8, 10, 12, 14, 18, 24, 30, 40px`.

Radius tokens:

| Token | Value | Usage |
|---|---:|---|
| `--shape-control` | 4px | Buttons, inputs, tight metadata fields |
| `--shape-card` | 6px | Tool children, rows, and compact cards |
| `--shape-popover` | 8px | Menus, lane surfaces, and user messages |
| `--shape-dialog` | 12px | Composer and dialogs |
| circle / full | — | Status orbits, pulses, compact counters only |

Do not make every surface a rounded card. Structural groups should prefer
dividers, background changes, and inset rules.

Elevation:

- Ordinary rows and cards have no drop shadow.
- `--elevation-sm` is the compact Composer/input shadow:
  `0 10px 30px rgb(26 31 25 / 9%)` in light mode and
  `0 14px 34px rgb(0 0 0 / 32%)` in dark mode.
- Inspectors, drawers, and off-canvas navigation use
  `0 22px 56px rgb(25 28 22 / 18%)` in light mode and
  `0 22px 56px rgb(0 0 0 / 52%)` in dark mode.
- Do not raise cards on hover; use border, fill, or a 2–3px inset rule.

Layer scale:

| Layer | z-index | Usage |
|---|---:|---|
| Base | 0 | Canvas, rails, ordinary content |
| Composer dock | 4 | Session controls and input |
| Inspector | 30 | Responsive context inspector |
| Desktop navigation / resize | 40 | Project rail and resize affordances |
| Mobile overlay | 50 | Mobile navigation and Inspector drawers |
| Mobile project rail | 55 | Stable rail above mobile overlays |
| Toast | 60 | Attention and action feedback |

## Workbench Layout

Desktop shell defaults:

```text
project pages: 52px project rail | flexible work canvas
Session detail: 52px project rail | flexible Session canvas | 312px inspector
```

- Context Inspector is resizable from 280–460px.
- User-adjusted Inspector width persists across visits. Collapse and focus mode
  never discard the last expanded width.
- Every project page begins with one 48px project toolbar containing the
  project identity, the `Todos / Automations / Sessions` navigation, and project
  actions. Do not duplicate this hierarchy in a persistent project sidebar.
- Workbench headers use a 64px minimum height and expand when their two-line
  content needs more room.
- Conversation structure follows the flexible work canvas with safe horizontal
  gutters; prose inside Agent responses uses a 65–72ch reading measure and user
  messages remain capped at 660px.
- Global Home content max: 1180px.
- Todos content max: 1500px.
- Main regions scroll independently only where the product structure requires it.

Responsive behavior:

| Breakpoint | Behavior |
|---|---|
| `>1180px` | Project rail + canvas; Session detail also shows the resizable Inspector |
| `761–1180px` | 52px rail + canvas; Session Inspector becomes a right overlay below the Session header |
| `≤760px` | 48px rail + canvas; project toolbar wraps to two rows when needed and the Session Inspector becomes an overlay |
| `<700px` | Todo Board becomes one column |

Narrow-screen rules:

- no document-level horizontal scrolling;
- Diff and terminal overflow stays inside its own component;
- secondary metadata may hide, but the entity, primary action, Tool count, and
  Token usage remain;
- the Composer Dock participates in the vertical layout rather than covering
  conversation content;
- page titles truncate only where a reachable detail surface preserves the full
  text.

## Navigation

- Project rail is the stable global anchor and uses initials or consistent
  outline SVG icons.
- Active project uses a lime edge marker because it represents the live
  workspace; active in-project navigation uses indigo.
- The project rail is theme-adaptive: warm neutral in light mode and graphite
  in dark mode. Its brand mark, hover fields, selected project, separators, and
  icon contrast use the matching `--rail-*` tokens; never leave a permanently
  black rail inside the light theme.
- The lower rail utility order is global search, Needs you, Settings, then the
  theme switch. Global search sits immediately above Needs you after the rail
  separator.
- The brand mark opens global Home. Home is a cross-project attention and
  resumption surface; it never becomes a second project inventory.
- Opening a project enters Todos by default. The stable project-level
  navigation order is `Todos / Automations / Sessions`; do not add a separate
  Project Dashboard that restates the same project work.
- On project inventory pages, the project name is the visible page `h1`. The
  active project tab labels the work surface, so do not repeat `Todos`,
  `Automations`, or `Sessions` as a second visible page title below the toolbar.
  Session detail instead uses the Session title as its page `h1`.
- Do not show ordinary entity totals in the project tabs. Session totals grow
  without a useful decision boundary, and mismatched Todo, Automation, and
  Session count semantics make the navigation harder to interpret.
- Search has two explicit scopes and never relies on placement alone:
  - the project rail opens `Search all work` across every registered project
    with `Command/Ctrl+K`;
  - each inventory page exposes one visible `Filter {entity}` field that only
    narrows the current Todo, Automation, or Session surface.
- Use `Search` for navigational result dialogs and `Filter` for in-place list
  narrowing. Global results identify their project and entity type and keep
  urgency grouping within a project. Do not duplicate the global-search icon
  in the project toolbar.
- Todo, Automation, and Session filters share one visual/interaction contract:
  36px high on precise pointers, at least 44px on coarse pointers, a search
  icon, visible focus ring, the same border/radius/type, and a helpful
  no-results state. Implement each page's filter locally; do not pre-build a
  generic `EntityFilter` component. Page-specific source or view controls may
  sit beside it without restyling the field.
- Session and Automation pages use one compact row per item:
  `state icon → single-line title → optional goal/attention/time marker`.
- Use icons for running, completed, Goal, permission, question, and Automation
  states. Reserve short text tags for states that require immediate user action,
  such as `Permission` or `Question`.
- Do not repeat ordinary state and time in a second descriptive line. Put the
  full state explanation in the accessible name and tooltip.
- Organize Sessions by decision value: `Needs you`, `Running`, then `Recent`.
- The Sessions page is the full project execution inventory and the only
  visible place for the primary `New Session` action. Creating one opens a
  direct root Lead Session without first creating a Todo.
- `Direct` describes how a Session was started, not the size or complexity of
  its work. Do not describe Direct Sessions as `No Todo`, `Quick`, or small
  work; show the root Agent identity as their neutral source context.
- A Todo `Run now` creates and opens a Todo-bound Session. An Automation
  `start_session` invocation creates and opens its Automation-source Session;
  `send_message` opens the exact target Session and invocation deep link without
  changing that Session's source. Every Session row and detail header identifies
  its source as `Todo`, `Automation`, or `Direct`.
- Todo quick capture presents two explicit outcomes in one surface:
  - `Save` captures one Idea without starting Agent work;
  - `Run now` creates the minimal Todo, moves it into active work, creates its
    bound Lead Session, and opens that Session. Discussion and Plan are optional,
    not gates for simple work.
- A Session detail always marks `Sessions` as the active project tab. Its
  breadcrumb and source metadata preserve the originating Todo or Automation.
- Mark the currently open Session with `aria-current="page"` and move that
  attribute whenever the user changes Sessions.
- The theme switch stays at the bottom of the project rail.
- Context Inspector retains resize, collapse, persisted width, and focus-mode
  behavior on desktop.
- On mobile, keep all three project tabs reachable in a second toolbar row when
  they do not fit beside the project identity. Do not replace them with an
  unrelated bottom-tab model or hide Sessions in overflow.

## Status Language

Use visible text or a recognizable icon in addition to color. Always provide
the complete state in the accessible name:

| State | Visual |
|---|---|
| Running/live | Lime-accented spinner/orbit or live pulse plus accessible state |
| Completed | Green check/status text |
| Needs attention | Amber icon plus short `Permission` or `Question` tag |
| Selected/active | Indigo field or inset rule |
| Idle/neutral | Outline neutral orbit |
| Error/destructive | Red icon/field and recovery wording |

Automation invocation state is not Session or Execution completion: a
`dispatched` invocation remains visibly `Dispatched` and must never be labeled
`Completed` without a terminal result from the relevant Session/Execution.

Avoid decorative status animation. Only a running Session spinner, live Work
pulse, and terminal cursor may loop.

## Component Specifications

### Buttons

- Primary: indigo fill, 4px radius, 32px default height.
- Secondary: elevated neutral surface, 1px border, 4px radius.
- Icon button: 32–40px visible control; expand the hit area to 44px on coarse
  pointers.
- Hover changes color, border, or surface only. No scale or vertical movement.
- Each view has one visually dominant primary action.

### Rows and Cards

- Global Home and archived/rejected items are rows separated by rules.
- Todo cards are one card level only; never nest a card inside another card.
- Selection uses a 2px indigo inset rule plus border change.
- Running or attention rows may use a semantic field and 3px inset rule.

### Session Header

- The first line contains the Session title and current state.
- The second line contains:
  `working directory · Tool count + Token usage · activation source`.
- Keep Tool count and Token usage visible as useful Session-level orientation.
  Use tabular figures and slightly stronger metadata color than the working
  directory and activation source.
- Do not restore Execution number, model/variant, or message count to this
  header. Those values do not improve primary reading orientation.
- The working directory is the flexible truncation region. Preserve the usage
  metrics and truncate the activation source only after the path has yielded.
- At `≤760px`, hide the working directory, separators, and activation source;
  retain only Tool count and Token usage beneath the title.
- Show Todo/source context in the same metadata line; do not add a separate
  activation-source banner above the conversation.

### Execution, Work, and Final Response

Execution is a mandatory product entity, not an optional visual section.

- One Execution's process is presented through a compact `Work` disclosure,
  without wrapping the whole turn in an Execution card.
- Running Work is expanded so current progress remains visible. Completed Work
  collapses to `Worked for {duration}` with only a chevron and expansion
  affordance.
- A running summary reads `Working · {duration}` and may append one current
  activity label after an em dash.
- Do not show Execution number, model, message count, step count, Tool count, or
  Child count in the visible Work row. Preserve Execution identity in product
  data and stable DOM identity.
- The accessible disclosure name includes the Work segment, terminal/live
  state, elapsed duration, and current activity when present.
- A final Agent response is editorial content after Work and remains visible
  when Work is collapsed. Never place the final response inside the disclosure.
- An Execution without final Agent text does not receive a fabricated empty
  response block.
- The Work body includes only useful commentary, completed Tool history,
  delegation, recovery/compaction events, and the current active item. Do not
  add a binding/status strip before the content.
- Live Work should normally expose one concise current tool or delegated-Agent
  line rather than a large running-state panel.
- Opening historical Work preserves the user's reading position and does not
  trigger live bottom-follow behavior.

### Tool Calls

- Project two or more consecutive ordinary tool calls within one Execution as a
  Tool Run, including calls split across model-step Assistant messages.
- Reasoning is an independent Work timeline module and a hard Tool Run boundary.
  Rendered Assistant text, `delegate`, `ask_user`, Recovery, and Compaction are
  also hard boundaries.
- A settled Tool Run summary is the ordered, comma-separated canonical tool-name
  list, for example `file_read, grep, glob, lsp_diagnostics`.
- Do not add a Tool count, completed label, representative target, or repeated
  success icon to the settled group row. The comma-separated names are the
  compact record.
- Expanding a settled Tool Run reveals one flat ordered tool list. Each
  successful ordinary row shows `tool name + target` without another
  disclosure. Failed, unknown-outcome, or artifact-backed rows retain a focused
  details affordance so errors and recoverable output are not lost.
- A singleton tool renders directly as a ToolCard without an extra disclosure.
- Read/search/navigation tools show what they acted on, not raw arguments or
  verbose results: `file_read registry.ts`, `grep ".archcode/runtime"`.
- File mutations show `tool name + file target + diffstat`; expansion reveals
  the Diff or mutation preview without a generic parameter table.
- Bash shows the exact command in the collapsed row. Expansion reveals the
  terminal output and exit/duration summary.
- Dedicated workflow events such as `delegate`, `ask_user`, Recovery, and
  Compaction keep their own concise presentation.
- Use monospace for tool names, paths, Diff, commands, and output metrics; use
  readable UI text for human-oriented targets.
- On narrow screens, hide secondary summary metadata before hiding state; Diff
  may scroll inside the card.

### Composer

- The Session composer is one compact bottom dock. Do not design a collapsed
  versus expanded Composer state.
- HITL is the highest-priority content in the dock. A pending permission or
  question appears as the first visible decision band, above Goal, Queue, and
  ordinary input, with its response actions immediately available.
- Goal is a compact textual summary with status, objective, and a control entry.
  Do not visualize Goal as a progress bar.
- Queued messages remain directly visible as compact rows with their message
  text and management actions. Do not reduce them to only a count or a `View`
  disclosure.
- Input, Agent, Profile, next-model selection, Queue/Send, and Stop remain in
  one quiet surface below the priority band and compact summaries.
- A running Session keeps ordinary queue composition available and exposes Stop
  clearly.
- The dock consumes layout space and never floats over Work or conversation
  content.

### Inspector, Drawers, and Entity Detail

- Context Inspector owns Agents, Changes, and Context; do not remove or merge
  these tabs.
- Inspector is a persistent right column on wide Session layouts and an overlay
  below 1181px.
- Persistent desktop navigation and Inspector widths are user-resizable and
  restored after collapse or focus mode.
- Todo detail is an independent project route because it owns durable Markdown,
  Plan, linked Sessions and Automations, and lifecycle actions. The Todo Board
  never duplicates this surface in a drawer.
- Overlays use a scrim and a visible close action.

### Feedback and Loading

- For actions that exceed 300ms, keep the current context visible and show a
  spinner, progress state, or running label.
- Disable a submitting control while its action is in flight; do not permit
  accidental duplicate submission.
- Use skeletons only when a whole content region is genuinely loading and
  reserve its final layout space.
- Never replace a known Session, Todo, or Execution with a blank screen while
  refreshing.
- Toasts confirm short-lived outcomes; errors remain near the failed action and
  include a recovery path.
- Live attention notices stay below the header and above the composer action
  area; they must never intercept Send, Queue, or Stop controls.

## Iconography

- Use one outline SVG language with round caps/joins and approximately 1.7px
  stroke.
- Use filled geometry only for brand marks and status dots.
- No emoji as structural icons.
- Icons reinforce a visible label unless the control has a clear accessible
  name and conventional meaning.

## Motion

Motion explains state changes; it is not decoration.

| Token | Duration | Usage |
|---|---:|---|
| `--motion-hover` | 140ms | Hover and surface response |
| `--motion-icon` | 160ms | Chevron and icon state |
| `--motion-overlay` | 220ms | Drawer and overlay entry/exit |
| `--motion-complete` | 180ms | One-shot completion feedback |
| `--motion-attention` | 700ms | Bounded attention feedback |
| `--motion-activity` | 1.8s | Running activity only |

- Do not add route-transition choreography or GSAP.
- Do not animate layout width/height for disclosure; switch content and rotate
  the chevron.
- Respect `prefers-reduced-motion` by reducing all animation and transition
  durations to effectively zero.

## Accessibility

- Use semantic buttons, tabs, regions, lists, headings, forms, and drawers.
- Expansion controls expose `aria-expanded`; use `aria-controls` when a stable
  detail ID exists.
- Icon-only controls have accessible names.
- Focus uses the indigo focus ring and is never removed without replacement.
- Status meaning always includes text or an icon in addition to color.
- Toasts use `role="status"` and `aria-live="polite"`.
- Preserve keyboard reading order when sidebars and inspectors become overlays.
- The mobile Session Composer uses 16px input text to avoid platform zoom.

## Forbidden Patterns

- purple/pink AI gradients;
- glassmorphism, blur as decoration, or translucent glass cards;
- Bento grids used as a generic AI-product signifier;
- card-inside-card compositions;
- all surfaces with large rounded corners;
- generic chat-only layout;
- vanity metrics, velocity charts, or activity graphs without a decision use;
- orange/brown styling that imitates Claude Code;
- monochrome terminal styling across the whole product;
- hidden Execution, inspector, Todo states, or lifecycle actions;
- decorative motion, parallax, animated gradients, floating shapes;
- marketing-page hero, testimonials, or conversion CTA patterns inside the app;
- cold corporate severity or sterile enterprise gray.

## Implementation and QA Checklist

- [ ] Read this Master and the relevant page override.
- [ ] Preserve every product entity and action shown in the current product.
- [ ] Use semantic theme tokens rather than page-local colors.
- [ ] Verify light and dark modes independently.
- [ ] Verify 390px, 760px, 1024px, and 1440px widths.
- [ ] Confirm no document-level horizontal overflow.
- [ ] Confirm global Home is cross-project and no project page reintroduces a
      Project Dashboard or persistent Sessions/Automations sidebar.
- [ ] Confirm the Composer Dock, headers, and drawers do not hide content.
- [ ] Confirm pending HITL is the first Composer decision surface and Goal uses
      no progress bar.
- [ ] Confirm settled Tool Runs expand and mutation/Bash ToolCards independently
      expand.
- [ ] Confirm settled Tool Runs use the ordered comma-separated tool-name list
      and expanded ordinary rows show their targets.
- [ ] Confirm the Session header preserves Tool count and Token usage without
      restoring Execution/model/message metadata at 390px, 760px, and desktop.
- [ ] Confirm keyboard focus and accessible expansion state.
- [ ] Confirm `prefers-reduced-motion`.
- [ ] Confirm browser console is clean.
