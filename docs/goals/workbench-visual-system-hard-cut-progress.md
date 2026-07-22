# Workbench Visual System Hard-Cut Progress

## Status

- State: Complete — implementation, verification, and independent final review approved.
- Started: 2026-07-22
- Goal: `docs/goals/workbench-visual-system-hard-cut-plan-goal.md`
- Product scope: `apps/web` presentation and tests only

## Locked Decisions

- The in-product component language is replaced as a hard cut; no retired theme, status class, wrapper, feature flag, or compatibility presentation path remains.
- Product state, data ownership, mutations, navigation, action order/visibility, and responsive shell behavior remain unchanged.
- Session/Execution Running, Tool loading, Session Todo progress, Project Todo workflow state, Goal protocol state, and Automation enabled state remain visually distinct.
- Project Todo is a non-draggable workflow board. `In Progress` means an Activation exists; it is not evidence that linked work is currently running.
- Missing Activation `resourceId` is static `Preparing resource…`; only authoritative Session family activity or live query loading may loop.
- `Archived` is a presentation override from `archivedAt`, not a new Project Todo status.

## Work Log

- Replaced the visual foundation across color, surface, type, 4px spacing, radius, shadow, focus, icon, control-size, and motion tokens in dark and light themes.
- Added cohesive low-level visual primitives (`ActivityArc`, `ProgressRing`, `StatusGlyph`, `IconAction`, transition ownership) and thin domain presentation adapters. Shared primitives do not read Store/API or own domain state.
- Removed the old status dot maps, Unicode glyphs, green Running, purple Completed, whole-control spin, pulse/glow, arbitrary type/spacing/control sizes, and retired compatibility styling paths.
- Added a dedicated accessible control-boundary token that reaches 3:1 contrast without changing the locked persistent-surface border palette.
- Rebuilt Running, Goal, Tool, Execution, Delegation, Recovery, Session Todo, HITL, Automation, Settings, Inspector, Diff, Dashboard, dialogs, menus, and empty/error surfaces without changing handlers or product state.
- Rebuilt Project Todo as a 4/2/1 responsive workflow board. Lane/status/association presentation is separate from lifecycle data; every existing action, expansion, Discussion, rejection reason, archive override, Session link, and Automation link remains available.
- Locked Project Todo association precedence to real resource-query loading, then authoritative linked Session activity, then missing-resource preparation, then stable resource state. A conflict test proves query loading wins over a simultaneous running snapshot.
- Locked Tailwind geometry to a real 4px unit despite the 14px UI root, so `h-7`, `h-8`, spacing, and named type now compute to the specified 28px/32px and 12/13/14px values instead of rem-shrunk approximations.
- Expanded interaction tests for the Project Todo action matrix, Goal actions/status transitions, Tool/Execution transitions, edit controls, accessible icon identity, reduced motion, and hard-cut design-token rules.
- Theme ownership moved to Root Layout so light theme survives below the desktop navigation breakpoint.
- Refreshed every browser artifact after the last source modification affecting that route or surface. All real-state QA data was created only in the existing `specra-test-projects` workspace.

## Implementation Phases

- [x] Audit current visual/status ownership and lock file boundaries.
- [x] Implement the new token, surface, typography, and motion foundation.
- [x] Implement shared status primitives and hard-cut old status maps.
- [x] Rebuild Running, Goal, Tool, Session Todo, HITL, Automation, and related workbench surfaces.
- [x] Rebuild Project Todo presentation and 4/2/1 responsive layout without changing behavior.
- [x] Complete automated gates and real-browser dark/light viewport QA.
- [x] Complete independent `sol(xhigh)` review and fix-review loop.

## Independent Review

- Reviewer: isolated `sol(xhigh)` agent.
- Final verdict: `VERDICT: APPROVED`.
- No P0/P1/P2 findings remain. Review-found mobile Automation header compression and Session Todo popover clipping were fixed, covered by tests, and recaptured in the real browser before approval.

## Automated Evidence

- `bun run typecheck`: pass, 5/5 workspaces.
- `bun run test`: pass, 8/8 Turbo tasks; Web 528 unit/component + 77 interaction tests; Agent Core 2,631 unit + 132 integration + 95 architecture tests.
- `bun run web:build`: pass; Vite production build completed in 2.12s.
- `git diff --check`: pass.
- Reduced motion is verified from the real stylesheet declarations: animation and transition durations compute to `0s`; there is no JavaScript animation timer to fake.
- Hard-cut tests reject retired status maps/tokens, pulse/glow/default spinners, arbitrary type/radius/shadow/duration, off-grid component spacing, 24/30px controls, broad transitions, double-faded semantic surfaces, structural-surface opacity, non-incidental muted text, and old Goal/status paths.
- Scope audit: product diffs are confined to `apps/web`; dependencies are unchanged. Other additions are this Goal, this progress record, and QA screenshots.

## Browser Evidence

All browser rows used the real Hono API on `127.0.0.1:4096` and a fresh current-tree Vite UI on `127.0.0.1:5174`. Each artifact was captured after the last source change affecting that route or surface; console error count was zero on every recorded route.

| Real state produced through product flow | Authoritative source | Stable selector / contract | Expected and observed visual | Theme / viewport | Artifact / console |
|---|---|---|---|---|---|
| Dashboard with persisted idle Sessions and paused Goal | Dashboard API projection | four fixed section headings; `aria-label="Running now"` | four sections remain present; empty Running heading is static; no horizontal overflow | dark + light / 1440 | `dashboard-dark-1440.png`, `dashboard-light-1440.png`; 0 errors |
| Real running `bash sleep 20` Tool and running Execution | Session stream + Execution/Tool records | Tool and Execution visual-kind attributes | local Loader rotates; Execution uses ActivityArc; card/control does not spin or glow | dark / 1440 | `session-running-tool-real-dark-1440.png`; 0 errors |
| Same Tool and Execution after completion | Persisted terminal records | completed Tool/Execution labels and glyphs | success glyphs are static after transition; no stale Running presentation | dark / 1440 | `session-completed-tool-real-dark-1440.png`; 0 errors |
| Real unresolved HITL request | durable project HITL queue | visible `Needs you` contract | warning glyph and rail are prominent without continuous looping | dark / 1440 | `session-needs-you-real-dark-1440.png`; 0 errors |
| Persisted paused Goal, stopped Execution, and 1/3 Session Todo | root Session goal + Execution + Todo records | `data-testid="session-goal-progress-row"`; named Goal actions | icon-led Goal row, objective remains primary, Pause/Resume/Edit/Clear matrix preserved, progress is deterministic | dark / 1440 + 390; light / 320 | `session-paused-goal-dark-1440.png`, `session-paused-goal-dark-390.png`, `session-paused-goal-light-320.png`; 0 errors |
| Pinned Session Todo details at the narrow breakpoint | Session Todo projection + local disclosure state | `aria-label="Todo progress details"` | fixed 12px viewport insets; computed rect `left=12`, `right=378`, `width=366`; title and progress summary fully visible; no horizontal overflow | dark / 390 | `session-todo-popover-dark-390.png`; 0 errors |
| Project Todo advanced Idea → Ready → Done | Project Todo lifecycle API | lane headings, card state name, lifecycle buttons | exact state/action contract preserved; Done is static and readable | light / 1440 | `project-todo-done-light-1440.png`; 0 errors |
| Rejected Project Todo with persisted reason | Project Todo lifecycle API | Rejected view/card and action names | reason visible; Edit/Discuss/Restore/Archive order preserved | light / 1440 | `project-todos-rejected-light-1440.png`; 0 errors |
| Archived Project Todo | `archivedAt` projection | Archived view/card and Restore action | neutral Archived override without inventing a lifecycle status | light / 1440 | `project-todos-archived-light-1440.png`; 0 errors |
| Ready Project Todo final state | Project Todo API | Ready lane and card | static Ready state; no false runtime activity | dark + light / 1440 | `project-todo-ready-final-dark-1440.png`, `project-todo-ready-final-light-1440.png`; 0 errors |
| Expanded Project Todo and Discussion | Todo route state + Discussion Session | expanded article and named lifecycle actions | 2px brand relation rail, detail hierarchy, action order, and disclosure preserved | light / 1440 | `project-todo-expanded-light-1440.png`; 0 errors |
| Todo linked to a real running Session | linked Session family snapshot | association row accessible label | ActivityArc appears only from authoritative running family state | dark / 1440 | `project-todo-linked-running-dark-1440.png`; 0 errors |
| Todo linked to active Automation | linked Automation record | association row accessible label | static Calendar/info treatment; enabled is not misrepresented as running | dark / 1440 | `project-todo-linked-automation-active-dark-1440.png`; 0 errors |
| Full Project Todo board matrix | responsive route rendering | four regions: Ideas, Ready, In Progress, Done | 4/2/1 columns at desktop/tablet/mobile; all lanes reachable; no horizontal overflow | dark + light / 1440, 1024, 700, 390, 320 | `project-todos-{dark,light}-{1440,1024,700,390,320}.png`; 0 errors |
| Real active Automation, responsive detail, and paused transition | Automation service | list/detail labels and controls | active Calendar static; mobile header forms two rows; title remains readable; icon actions are 28px and standard actions 32px; paused glyph static; no horizontal overflow | dark / 1440 + 390 + 320 | `automations-active-real-dark-1440.png`, `automation-active-detail-real-dark-{1440,390,320}.png`, `automation-paused-real-dark-1440.png`; 0 errors |
| Automation empty/list surface | Automation route | heading and empty-state contract | stable empty/list hierarchy with no loop or overflow | light / 1024 | `automations-light-1024.png`; 0 errors |
| Settings dialog opened through product control | Root Layout Settings action | dialog name `Settings` and existing fields | overlay/surface hierarchy and all controls remain reachable | light / 1024 | `settings-light-1024.png`; 0 errors |
| Inspector Changes tab on persisted Session | Session route state | `Changes` tab and inspector region | 360px inspector, readable Diff empty state, no canvas overflow | dark / 1440 | `session-diff-inspector-dark-1440.png`; 0 errors |
| Real not-found route | Router | heading `404` | fixed type scale and reachable compact shell at minimum width | light / 320 | `not-found-light-320.png`; 0 errors |

## Known Risks And Residue

- QA records were intentionally retained in `specra-test-projects` so the screenshots remain reproducible: one active single-run Automation scheduled for 2099 and one unresolved HITL request are still present. They do not affect source code or production projects.
- Browser tooling cannot emulate `prefers-reduced-motion` in this environment. The contract is therefore covered by a computed-style automated test over the actual reduced-motion declarations, not by a claimed browser-emulation screenshot.
- Vite still reports its existing `>500 kB` chunk-size warning. The production build succeeds; bundle splitting is outside this UI-only Goal.
- The main residual product risk is visual density on unusually long localized copy. The locked 320px tests prove reachability and no horizontal overflow for current product copy, not every future translation.
