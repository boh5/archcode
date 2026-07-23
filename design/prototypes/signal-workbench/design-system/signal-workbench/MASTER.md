# Signal Workbench Design System

> Persisted from the approved interactive prototype on 2026-07-23.
>
> When designing or implementing a page, read this file first and then read
> `pages/[page-name].md`. A page file overrides this Master only where it says
> so. The interactive prototype remains the rendered reference:
> [`../../index.html`](../../index.html).

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
4. The interface is dense, but hierarchy and whitespace must keep it calm.
5. Light and dark modes are designed together. The theme control stays at the
   bottom of the project rail; do not move it into the main header.

## Design Concept

**Operational warmth.** The interface combines the clarity of a developer tool
with a warm, mineral material palette. It should feel focused and alive without
becoming severe, sterile, playful, or decorative.

Design dials:

| Dial | Value | Meaning |
|---|---:|---|
| Variance | 5/10 | Balanced composition with asymmetric workbench rails |
| Motion | 3/10 | Subtle, state-driven motion only |
| Density | 8/10 | Compact operational information, progressively disclosed |

Core visual principles:

- warm canvas rather than pure white or cool gray;
- indigo for selection and intentional actions;
- lime only for live/running signals;
- thin rules and surface changes before shadows;
- mostly 4–8px radii;
- editorial reading rhythm in the conversation;
- monospace only for code, paths, commands, metrics, and tool names.

## Color System

Use semantic tokens. Do not place raw colors in page-specific components.

### Light Theme

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#f3f1e9` | Warm mineral workspace background |
| `--surface` | `#faf9f4` | Rails, headers, large work surfaces |
| `--surface-raised` | `#ffffff` | Inputs, ToolCards, compact controls |
| `--surface-muted` | `#ebe8de` | User messages and secondary fields |
| `--surface-hover` | `#e4e1d7` | Hover state |
| `--surface-active` | `#dcd9ce` | Pressed or selected neutral state |
| `--border-soft` | `#e2ded3` | Internal separators |
| `--border` | `#d2cec2` | Default boundary |
| `--border-strong` | `#aaa69b` | Structural boundary |
| `--ink` | `#24241f` | Primary text |
| `--ink-secondary` | `#5e5d55` | Body and explanation text |
| `--ink-tertiary` | `#696860` | Secondary metadata |
| `--ink-muted` | `#6f6e66` | De-emphasized metadata |
| `--brand` | `#4b50c8` | Selection, primary action, active navigation |
| `--brand-hover` | `#3f43af` | Primary action hover |
| `--brand-field` | `#e8e7f8` | Selected/brand-tinted field |
| `--brand-ink` | `#ffffff` | Text on brand |
| `--signal` | `#b8d94a` | Running/live only |
| `--signal-ink` | `#252c0b` | Text on signal |
| `--signal-field` | `#edf4cf` | Running row background |
| `--success` | `#397454` | Completed/success |
| `--success-field` | `#e3efe8` | Completed field |
| `--warning` | `#91651c` | Attention/decision required |
| `--warning-field` | `#f3e8ce` | Attention field |
| `--danger` | `#b4473f` | Error/destructive/diff removal |
| `--danger-field` | `#f5dfdc` | Error/removal field |
| `--rail` | `#24241f` | Project rail |
| `--rail-ink` | `#f4f2e9` | Active rail content |
| `--rail-muted` | `#85847a` | Inactive rail content |
| `--focus` | `0 0 0 3px rgb(75 80 200 / 22%)` | Focus ring |

### Dark Theme

| Token | Value | Role |
|---|---|---|
| `--canvas` | `#141512` | Workspace background |
| `--surface` | `#1b1d19` | Rails, headers, large work surfaces |
| `--surface-raised` | `#22241f` | Inputs, ToolCards, controls |
| `--surface-muted` | `#282a24` | Secondary fields |
| `--surface-hover` | `#2f322b` | Hover state |
| `--surface-active` | `#383b33` | Pressed neutral state |
| `--border-soft` | `#292b26` | Internal separators |
| `--border` | `#393c34` | Default boundary |
| `--border-strong` | `#595d51` | Structural boundary |
| `--ink` | `#f1f0e8` | Primary text |
| `--ink-secondary` | `#b8b7ad` | Body text |
| `--ink-tertiary` | `#a3a198` | Secondary metadata |
| `--ink-muted` | `#85847c` | De-emphasized metadata |
| `--brand` | `#858bff` | Selection and primary action |
| `--brand-hover` | `#9ca1ff` | Primary action hover |
| `--brand-field` | `#2b2d4b` | Selected/brand-tinted field |
| `--brand-ink` | `#151626` | Text on brand |
| `--signal` | `#c5e85a` | Running/live only |
| `--signal-ink` | `#1c2206` | Text on signal |
| `--signal-field` | `#2c3518` | Running field |
| `--success` | `#72b88a` | Completed/success |
| `--success-field` | `#1d3224` | Completed field |
| `--warning` | `#dfb85d` | Attention/decision required |
| `--warning-field` | `#382e18` | Attention field |
| `--danger` | `#ec7b72` | Error/destructive/diff removal |
| `--danger-field` | `#3b211f` | Error/removal field |
| `--rail` | `#0f100e` | Project rail |
| `--rail-ink` | `#f1f0e8` | Active rail content |
| `--rail-muted` | `#74746d` | Inactive rail content |
| `--focus` | `0 0 0 3px rgb(133 139 255 / 25%)` | Focus ring |

### Color Discipline

- Indigo means selected, navigable, or user-triggered action.
- Lime means currently live or running. Never use it as a general accent.
- Green means completed; amber means attention; red means error/destructive.
- Large surfaces remain neutral. Semantic colors appear as narrow fields,
  status glyphs, labels, or inset rules.
- Never introduce purple/pink gradients or an orange imitation of another
  developer tool.

## Typography

No network font dependency is required.

```css
--font-ui: "Avenir Next", Avenir, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif;
--font-mono: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
```

Type scale:

| Role | Size | Weight | Notes |
|---|---:|---:|---|
| Dense metadata | 8–9px | 500–700 | Counts, elapsed time, tool metadata |
| Compact label | 10px | 600–750 | Buttons, row labels, section labels |
| Operational title | 11–12px | 650–700 | Navigation, cards, rows |
| Body | 12–13px | 400–500 | Conversation and explanations |
| Page title | 18px | 700 | Dashboard and flat Todo views |
| Session objective | 22–30px | 650 | Responsive `clamp`, −0.03em tracking |

Rules:

- Body text uses 1.6–1.7 line-height and a maximum of 68ch.
- Code inside a large Session objective inherits the UI font so the heading
  reads as one sentence; inline and operational code uses monospace.
- Numeric timers and counters use tabular figures.
- Small text is metadata only; primary mobile input text remains at least 16px.

## Spacing, Radius, and Elevation

Use a 2/4px-derived dense scale:

`2, 4, 6, 8, 10, 12, 14, 18, 24, 30, 40px`.

Radius strategy:

| Radius | Usage |
|---:|---|
| 3–4px | Status badges, tight metadata fields |
| 5–6px | Tool children, rows, cards, page marks |
| 7–8px | Inputs, segmented controls, primary icon buttons |
| 12px | Composer and the user message bubble only |
| 50% / 999px | Status orbits, pulses, compact numeric counters only |

Do not make every surface a rounded card. Structural groups should prefer
dividers, background changes, and inset rules.

Elevation:

- Ordinary rows and cards have no drop shadow.
- The compact Composer input surface uses one soft shadow inside its bottom dock.
- Inspectors, drawers, and off-canvas navigation use
  `0 18px 48px rgb(31 30 25 / 18%)` in light mode and
  `0 18px 48px rgb(0 0 0 / 46%)` in dark mode.
- Do not raise cards on hover; use border, fill, or a 2–3px inset rule.

Layer scale:

| Layer | z-index | Usage |
|---|---:|---|
| Base | 0 | Canvas, rails, ordinary content |
| Composer dock | 4 | Session controls and input |
| Local scrim | 18 | Todo detail scrim |
| Local drawer | 19 | Todo detail |
| Inspector | 30 | Responsive context inspector |
| Navigation | 40 | Responsive project navigation |
| Accessibility | 1000 | Skip link while focused |

## Workbench Layout

Desktop shell defaults:

```text
52px project rail | 248px project navigation | flexible work canvas | 330px inspector
```

- Project navigation is resizable from 210–340px.
- Context Inspector is resizable from 280–460px.
- User-adjusted widths persist across visits. Collapse and focus mode never
  discard the last expanded width.
- Header height: 56px; page headers may use 58px.
- Conversation reading width: 760px; agent response max: 740px.
- Dashboard content max: 1100px.
- Todos content max: 1500px.
- Main regions scroll independently only where the product structure requires it.

Responsive behavior:

| Breakpoint | Behavior |
|---|---|
| `>1180px` | Four-region Session shell; inspector and sidebar may collapse |
| `761–1180px` | 52px rail + 228px sidebar + canvas; inspector becomes a right overlay |
| `≤760px` | 44px rail + canvas; project sidebar and inspector become overlays |
| `≤620px` | Todo Board becomes one column; flat rows reflow actions below copy |

Narrow-screen rules:

- no document-level horizontal scrolling;
- Diff and terminal overflow stays inside its own component;
- secondary metadata may hide, but the entity and primary action remain;
- the Composer Dock participates in the vertical layout rather than covering
  conversation content;
- page titles truncate only where a reachable detail surface preserves the full
  text.

## Navigation

- Project rail is the stable global anchor and uses initials or consistent
  outline SVG icons.
- Active project uses a lime edge marker because it represents the live
  workspace; active in-project navigation uses indigo.
- Project Dashboard and Todos remain explicit destinations above the
  Sessions/Automations switcher.
- The theme switch stays at the bottom of the project rail.
- Project navigation and Context Inspector retain resize, collapse, persisted
  width, and focus-mode behavior on desktop.
- On mobile, navigation becomes off-canvas; do not replace it with an unrelated
  bottom-tab model.

## Status Language

Use a status orbit, icon, or narrow bar plus visible text:

| State | Visual |
|---|---|
| Running/live | Filled lime orbit, optional outer ring, `Running` text |
| Completed | Green check/status text |
| Needs attention | Amber orbit/field and explanatory copy |
| Selected/active | Indigo field or inset rule |
| Idle/neutral | Outline neutral orbit |
| Error/destructive | Red icon/field and recovery wording |

Avoid decorative status animation. Only a live Execution pulse and terminal
cursor may loop.

## Component Specifications

### Buttons

- Primary: indigo fill, 6–8px radius, 34px default height.
- Secondary: raised neutral surface, 1px border, 6px radius.
- Icon button: 34–38px visible control; expand the hit area to 44px on coarse
  pointers.
- Hover changes color, border, or surface only. No scale or vertical movement.
- Each view has one visually dominant primary action.

### Rows and Cards

- Dashboard and archived/rejected items are rows separated by rules.
- Todo cards are one card level only; never nest a card inside another card.
- Selection uses a 2px indigo inset rule plus border change.
- Running or attention rows may use a semantic field and 3px inset rule.

### Execution, Work, and Final Response

Execution is a mandatory product entity, not an optional visual section.

- One Execution's process is presented through a `Work` disclosure. Keep the
  Execution number and real counts as quiet metadata rather than wrapping the
  whole turn in an Execution card.
- Running Work is expanded so progress remains visible. Completed Work may
  collapse to a summary with state, elapsed time, step/Tool/Child counts, and an
  expansion affordance.
- A final Agent response is editorial content after Work and remains visible
  when Work is collapsed. Never place the final response inside the disclosure.
- An Execution without final Agent text does not receive a fabricated empty
  response block.
- Binding row shows Agent/Profile, model/variant, and continuity state.
- Timeline includes Tool Runs, singleton tool calls, delegation, and running
  commands.
- The running step uses lime; completed steps use green; delegation uses indigo.
- Opening historical Work preserves the user's reading position and does not
  trigger live bottom-follow behavior.

### Tool Calls

- Project two or more consecutive ordinary tool calls within one Execution as a
  Tool Run, including calls split across model-step Assistant messages.
- Reasoning does not split a Tool Run. Rendered Assistant text, `delegate`,
  `ask_user`, Recovery, and Compaction do.
- While a Tool Run is active, its single collapsed row shows the last tool in
  authoritative order; parallel calls use the same last-entry rule.
- After every call settles, the collapsed row returns to the first tool.
- Do not layer semantic read-only aggregation on top. The row shows the
  representative tool summary, a quiet numeric count, and state.
- Tool Runs and singleton ToolCards use the same row skeleton: status on the
  left and the disclosure chevron on the right. Count is the only additional
  collapsed-row element for a Tool Run.
- Expanding a Tool Run reveals the flat ordered list; each ToolCard keeps its
  own independent expansion state.
- A singleton tool renders directly as a ToolCard without an extra disclosure.
- Independent ToolCards show tool name, target, change/result summary, state,
  and chevron in the collapsed row.
- Expanded write tools disclose input parameters, Diff preview, completion
  boundary, observed amount, and stored amount.
- Use monospace for tool names, paths, Diff, commands, and output metrics.
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

### Inspector and Drawers

- Context Inspector owns Agents, Changes, and Context; do not remove or merge
  these tabs.
- Inspector is a persistent right column on wide Session layouts and an overlay
  below 1181px.
- Persistent desktop navigation and Inspector widths are user-resizable and
  restored after collapse or focus mode.
- Todo detail is a right drawer with objective, confirmed decisions, linked
  work, and lifecycle actions.
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

## Iconography

- Use one outline SVG language with round caps/joins and approximately 1.7px
  stroke.
- Use filled geometry only for brand marks and status dots.
- No emoji as structural icons.
- Icons reinforce a visible label unless the control has a clear accessible
  name and conventional meaning.

## Motion

Motion explains state changes; it is not decoration.

| Interaction | Duration |
|---|---:|
| Hover/surface response | 140ms |
| Chevron expansion | 160ms |
| Theme color transition | 180ms |
| Drawer/sidebar movement | 220ms, `cubic-bezier(0.16, 1, 0.3, 1)` |
| Live pulse | 1.8s loop, running state only |
| Terminal cursor | 1.1s stepped loop |

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
- Mobile input text is 16px to avoid platform zoom.

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
- [ ] Confirm the Composer Dock, headers, and drawers do not hide content.
- [ ] Confirm pending HITL is the first Composer decision surface and Goal uses
      no progress bar.
- [ ] Confirm grouped and independent ToolCards both expand/collapse.
- [ ] Confirm keyboard focus and accessible expansion state.
- [ ] Confirm `prefers-reduced-motion`.
- [ ] Confirm browser console is clean.
