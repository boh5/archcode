# Signal Workbench UI Conformance — Execution Progress

Status: Complete
Started: 2026-08-11
Source: [`signal-workbench-ui-conformance-hard-cut-plan-goal.md`](./signal-workbench-ui-conformance-hard-cut-plan-goal.md)

This file records implementation progress and verification evidence. The approved Goal, scope, and acceptance criteria remain in the source document above.

## Locked decisions

- Visual structure and numeric values are authoritative in the current effective prototype and are synchronized back to Master/page specs; current product remains authoritative for domain behavior, state semantics, routes, APIs, stores, and persistence.
- This is a hard cut: no fallback UI, legacy compatibility branch, or tombstone test is permitted.
- Scope is Web-only except the approved New Todo `Start discussion` hard cut: one narrow Protocol contract, Todo receipt/service, Server route, and Runtime `ensureSessionFile` adapter replace the unsafe client-side two-step creation. No generic transaction framework, compatibility fallback, or entity-schema expansion is permitted.
- Shared shell, Todos, inventory pages, and Session Detail have disjoint implementation ownership; integration remains with the root agent.
- UI/UX Pro Max's generic OLED/landing-page recommendation is rejected because it conflicts with ArchCode's normative quiet, dual-theme engineering-workbench system. Its accessibility and responsive checks remain advisory QA inputs.

## Workstream status

- [x] Shared shell, project rail/picker, skip navigation, Home
- [x] Todos list/board, capture modal, preview, recovery, detail, Result
- [x] New Todo Start discussion single-command exactly-once coordination and retained-entity recovery
- [x] Automations list/detail responsive hierarchy
- [x] Sessions inventory hierarchy and direct creation
- [x] Session Detail header, Work status, model picker, attachments, inspector
- [x] Focused tests and interaction tests
- [x] Typecheck, full relevant test lanes, Web production build
- [x] Real browser QA at 1440 / 1024 / 760 / 390 in light and dark themes, plus exact 720 / 1180 / 1181 boundaries
- [x] Keyboard, focus, Escape, reduced-motion, overflow, attachment, HITL, and touch-target QA
- [x] Independent `gpt-5.6-sol(max)` final review of the current tree; fix-review loop completed
- [x] Final AC-01 through AC-09 audit after the current-tree review

## Evidence log

| Time | Evidence | Result |
| --- | --- | --- |
| 2026-08-11 | Approved Plan Goal received an independent review, five concrete gaps were fixed, and the second review approved it. | Baseline locked |
| 2026-08-11 | UI/UX Pro Max design-system search rerun for this implementation turn. | Generic landing/OLED direction rejected; normative Master retained |
| 2026-08-11 | Shared Shell/Home: ProjectBar 11, picker 2, Home 3, Project touch 4, RootLayout 3, token contracts 6. | 29 focused tests passed; Web typecheck/build passed |
| 2026-08-11 | Automations/Sessions: inventory, dialog, and surface contracts. | 30 focused tests passed; scoped diff check clean |
| 2026-08-11 | Session Detail: ModelPicker, ChatInput, header, workstream, inspector, and structural contracts. | ModelPicker 9 and ChatInput 30 passed; related interaction/contract tests passed |
| 2026-08-11 | Todos: inventory, dialog, preview action matrix, partial-success recovery, detail, and deterministic Result extraction. | 63 focused tests passed; Todo-only and Todo+Session recovery and every preview lifecycle/link variant covered |
| 2026-08-11 | Final Web integration after all production changes. | 647 unit/contract + 128 interaction tests passed; Web typecheck and production build passed |
| 2026-08-11 | Full monorepo validation. | `bun run typecheck` and `bun run test` passed across all five workspaces and all eight Turbo tasks; Agent Core integration and architecture lanes passed |
| 2026-08-11 | Browser QA at 1440 / 1024 / 760 / 390 across light and dark. | Home, Todos List/Board/preview/dialog/detail, Automations, Sessions, Session detail/Model menu, picker, Settings, skip/focus/Escape, and overflow checks passed; console errors = 0 |
| 2026-08-11 | Exact 760px browser inspection exposed strict `max-[760px]` range gaps and a mobile surface-group minimum width. | Command bars were hard-cut to mobile-first styles with `min-[761px]` desktop overrides; Todo group was changed to mobile `min-w-0`; browser recheck passed |
| 2026-08-11 | QA cleanup. | Browser tabs finalized, viewport reset, QA services stopped, and ports 4096/5173 verified free |
| 2026-08-11 | Independent `gpt-5.6-sol(max)` implementation review. | `NEEDS_FIX`: eight material findings accepted; Todo modal/keyboard/Result, Inspector counts/1180, rail/shared CTA, and omitted browser evidence entered the fix-review loop |
| 2026-08-12 | Todo fix cycle: exclusive preview/capture surfaces, pending dismissal guard, preview focus loop/restoration, canonical visual-order keyboard routing, exact 720 threshold, non-Active direct detail, and real Result-route fetch/render coverage. | 79 focused tests passed; Web typecheck and diff check passed |
| 2026-08-12 | Shared-shell fix cycle: authoritative Inspector counts/projection, exact 1180/1181 placement, rail active/hover tokens, visible zero Needs-you count, and one narrow shared primary-action primitive. | 61 focused tests passed; Web typecheck/build and diff check passed |
| 2026-08-12 | Combined Web integration after the fix cycle. | Full Web unit/contract suite and 143 interaction tests passed; Web typecheck/build passed |
| 2026-08-12 | Granular browser recheck on the Runtime-ready product. | Canonical Todo keyboard order and drag, modal focus containment/restoration, exact 720/1180/1181 geometry, 2-Agent/M-A-D Inspector data, attachment remove, active HITL/cancel, Automation binding, global search, and the 4-viewports × 2-themes Settings matrix passed; console errors = 0 |
| 2026-08-12 | QA cleanup. | Both temporary projects unregistered through the product API; temporary workspaces/attachment removed; browser viewport reset/tabs finalized; only the two started services stopped; ports 4096/5173 free |
| 2026-08-12 | Final combined repository validation after every fix and QA cleanup. | `bun run typecheck`: 5/5 tasks; `bun run test`: 8/8 tasks including Web 143 interaction tests and Agent Core integration/architecture lanes; `bun run web:build`: passed with only the existing chunk-size warning; `git diff --check`: clean |
| 2026-08-12 | Second independent `gpt-5.6-sol(max)` review. | `NEEDS_FIX`: exact-760 CTA height, real reduced-motion Chrome evidence, and a positive New Session create/navigation/focus test were accepted as three material gaps |
| 2026-08-12 | Second code fix cycle. | Shared primary action is mobile-first `h-11` with `min-[761px]:h-9` and coarse-pointer `h-11`; the Todo-local duplicate was removed. A real `ProjectSessionsRoute` interaction test proves one bodyless create, exact URL, `focusComposer` handoff, and actual Composer textarea focus. Web interaction lane: 144/144; Web typecheck and diff check passed |
| 2026-08-12 | Exact-height and reduced-motion Chrome recheck. | At both 760×844 and 390×844, New Todo/New Automation/New Session each computed to 44px. Isolated Chrome with `--force-prefers-reduced-motion` reported `matchMedia(...)=true`; real Automation overlay and real Running Session activity orbits resolved to 0s / one iteration / no transform. Normal-media comparison retained 220ms overlay and 1.8s infinite activity motion. Page console errors = 0 |
| 2026-08-12 | Second QA cleanup. | Temporary running Session stopped/deleted, temporary project unregistered, exact workspace and isolated Chrome profile removed, exact Chrome/Vite/Server processes stopped, connector viewport reset/tabs finalized, and ports 4096/5173/9224 verified free |
| 2026-08-12 | Final combined validation after the second fix cycle. | `bun run typecheck`: 5/5 tasks; `bun run test`: 8/8 tasks including Web 144 interaction tests and Agent Core integration/architecture lanes; `bun run web:build`: passed with only the existing chunk-size warning; `git diff --check`: clean |
| 2026-08-12 | Third independent `gpt-5.6-sol(max)` final review. | `APPROVED`: all prior findings #1–#8 closed; no material findings across AC-01–AC-09, hard-cut architecture, responsive/accessibility boundaries, or validation evidence |
| 2026-08-12 | Rail fixed-order correction and Composer hard cut. | Project navigation now preserves registration-order positions across switches; Composer expand/collapse and its HITL collapsed branch were deleted, with the textarea always present. |
| 2026-08-12 | Post-correction combined validation. | Web 654 unit/contract + 145 interaction tests passed; root typecheck 5/5, root test 8/8, production build, and diff check passed. |
| 2026-08-12 | Post-correction real browser QA. | Two project switches preserved exact rail y positions; failed Session Composer remained visible and bottom-aligned at 1440 and 390px, with 16px narrow input and zero overflow; five prototypes had zero overflow and local-only styles; console errors = 0. |
| 2026-08-13 | Prototype-authority reconciliation and final focused fix cycle. | Goal authority was corrected so current prototype wins visual/numeric conflicts; stale visual tests now lock exact prototype geometry instead of forbidding exact pixel values; Todo command controls gained the missing pointer cursor; stale Todo Session and Composer width assertions were updated to current positive contracts. |
| 2026-08-13 | Current-tree automated verification. | Web typecheck passed; full Web suite including 149/149 interaction tests passed; root typecheck 5/5 and root test 8/8 passed including Agent Core integration/architecture lanes; `bun run build` passed with only the existing chunk-size warning; diff check passed. |
| 2026-08-13 | Final current-tree browser boundary recheck. | 840 Automation detail-only with visible 44px back; 841 split at exact 360/429px with back hidden; 760 Todo toolbar 81px and command buttons use pointer cursor; Todo detail has no inventory filter or extra status controls; 760/390 Session Composer remains bottom-aligned with 16px input and no Composer toggle; Model menu is 308px/12px and pointer focus stays on trigger; Session Source has 0 native selects, 220px custom menu and >=44px options; every checked page has zero horizontal overflow and console errors = 0. |
| 2026-08-13 | Independent current-tree `gpt-5.6-sol(max)` review. | `NEEDS_FIX`: removed the remaining image-preview attachment path, added Enter/Space focus transfer to the custom Session Source menu, and removed duplicate Upcoming next-fire copy. |
| 2026-08-13 | Final fix-cycle verification. | ChatInput + Home 34/34 and Sessions interaction 2/2 passed; full Web suite including 149/149 interaction tests, Web typecheck, Web production build, and `git diff --check` passed. |
| 2026-08-13 | Independent fix-cycle re-review. | `APPROVED`: all three findings closed; no remaining material finding across AC-01–AC-09 or the hard-cut architecture. |
| 2026-08-13 | Final QA cleanup. | Temporary Session family stopped, Automation deleted, project unregistered, exact temporary workspace removed, browser viewport reset/tabs finalized, only agent-started services stopped, and ports 4096/5173/4181 verified free. |
| 2026-08-13 | Start discussion architecture hard cut. | Replaced New Todo's client-side Todo-then-Session sequence with one `POST /todos/start-discussion` command. Durable receipt stores request hash plus exact Todo/Session IDs before Session creation; Runtime ensures the preallocated Session identity and first-message acceptance reuses the same durable request ID. Ordinary Todo-bound `createSession` remains available for explicitly creating additional Discussions. |
| 2026-08-13 | Start discussion failure-window verification. | Protocol wire contract, Todo state/service, real Runtime adapter, and Server route tests cover concurrent and sequential replay, accepted restart replay, restart before/after Session persistence, response loss, non-durable acceptance compensation, durable acceptance with wake-up failure, indeterminate Session/message state, exact recovery IDs, strict request validation, and conflict mapping. |

## Browser QA record

All rows below used the Runtime-ready product at the Vite origin, not a static prototype. DOM measurements were taken in the in-app browser; each inspected viewport had `scrollWidth <= clientWidth`.

| Viewport / theme | Page and state | Operation | Visible result / direct evidence |
| --- | --- | --- | --- |
| 1440, dark + light | Home with the live global projection | Navigate Home; switch theme; inspect section coordinates and rail geometry | Four authoritative sections render as paired 2×2 flat bands; rail outer width is 52px; no overflow |
| 1440, dark | Session detail | Open a live Session; inspect header, Work, model trigger/menu and main canvas | One model trigger/menu, title/status and workstream stay reachable; unique `main#work-canvas`; no overflow |
| 1024, light | Todos Active/Board | Switch List→Board; open a row preview; press `C`; press Escape | Board is two columns; preview is 420px and does not move the inventory content box; 560px New Todo dialog focuses the textarea; Escape restores `New Todo` focus |
| 1024, dark | Automations | Open inventory and select a definition | Wide list/detail split is present, exact selected definition remains on the same canvas, no overflow |
| 760, light | Todos Active/Board | Inspect exact breakpoint before and after correction | Two-row command area, 48px rail, two Board columns, 44px controls; exact-760 strict-range defect is absent |
| 760, dark | Automations and Sessions | Navigate both inventories; inspect command controls and list placement | Search/select/primary controls are 44px mobile controls; Sessions header uses the narrow grid; no overflow |
| 390, light + dark | Todos inventory and direct detail | Select a Todo; navigate back; switch theme | Board is one column; no preview DOM is mounted; direct detail uses main-then-context order and has no horizontal overflow |
| 390, dark | Home and project picker | Open More; inspect/search the complete project set; press Escape | Home hides direct project marks; More shows every project with path/current/running/Needs-you metadata, focuses filter, and restores focus to More on Escape |
| 390, dark | Session detail | Open model menu; press Escape; inspect compact header | cwd/source/separators are absent while tools/tokens remain; one model trigger, Default badge and Effort section; Escape restores trigger focus |
| 390, dark | Settings | Open Settings and inspect its sections/footer | Existing settings sections remain reachable and the dialog has no horizontal overflow |
| 390 / 760 / 1024 / 1440, light + dark | Settings | Open the full dialog at every viewport/theme pair; reach About & Updates and Runtime Data; inspect footer actions | All eight combinations have zero dialog overflow; Save, Reload, and Close remain visible/reachable; active theme matches the selected theme |
| 720, light | Todos | Select a Ready Todo | Routes directly to canonical detail with no preview dialog; horizontal overflow is zero |
| 1024, light | Todos List / Board | Press `j`, `k`, Enter; keyboard-drag an Idea with Space/Arrow/Space | Focus follows canonical lane order rather than API order; Enter opens the focused Todo; live region confirms the new Board position |
| 1024, light | Todo preview / capture | Open preview; exercise Tab/Shift+Tab, Escape, and `C` | Focus is contained and wraps; Escape restores the exact source row; `C` replaces preview with one focused New Todo dialog rather than mounting both |
| 1024, dark | New Automation | Open creation dialog | Read-only binding is explicit as `Lead + principal`; no editable Agent/Profile controls exist |
| 1180 / 1181, dark | Session Inspector | Inspect placement and main-canvas rectangles at the exact boundary | 1180 is an absolute 360px overlay without shrinking main; 1181 is a 360px sibling and main contracts; both have zero overflow |
| 1181, dark | Session Inspector | Use End/Home/ArrowRight/ArrowLeft and inspect live session data | Tabs rove and update URL/panel; Agents shows Lead + Explore; Changes shows authoritative M/A/D entries with matching counts |
| 390, dark | Session composer | Upload and then remove a real text attachment | Filename chip appears, then removal clears it; no layout shift or overflow |
| 390, dark | Active HITL | Trigger a real `ask_user`; inspect paused state and cancel it | Needs-you question, Alpha/Beta options, note, Submit and Cancel are reachable; cancellation clears the prompt and the Session completes |
| 390, dark | Global search | Press Meta+K, inspect initial focus, press Escape | One search dialog opens with focus in the search input; Escape closes and restores focus to Search all work |
| 760 / 390, Chrome | Inventory primary actions | Open Todos, Automations, and Sessions; inspect each visible primary action | All six direct measurements report `rect.height=44` and computed `height=44px` |
| Cross-page | Keyboard/focus | Activate Skip link; open/close Todo preview, New Todo, project picker and model menu | Skip focuses `main#work-canvas`; each transient surface restores its exact origin focus |
| Cross-page | Reduced motion, Runtime and diagnostics | Launch isolated primary Chrome with `--force-prefers-reduced-motion`; verify media match; inspect a real Automation overlay and real Running Session against normal-media Chrome; inspect console; shut down QA services | Media match is true. Overlay backdrop/dialog are 0s, one iteration, transform none; authoritative running orbits are 0s, one iteration, transform none versus normal 1.8s/infinite/non-identity motion. Product console error count is 0; ports 4096, 5173, and 9224 are free after cleanup |

## Findings and corrections

No requirement needed a new product or architecture decision. The implementation defects found across the review and real-QA cycles were corrected without changing the locked contract:

- Tailwind's strict range behavior did not apply the intended mobile layout at exactly 760px. The affected command controls now use mobile-first classes and `min-[761px]` desktop overrides.
- The Todo surface group retained a desktop minimum width at 390px and clipped `New Todo`. The mobile minimum is now zero, with the desktop minimum restored only above 760px.
- Todo preview and capture are now mutually exclusive, pending mutation cannot be dismissed, keyboard traversal follows the canonical lane projection, and non-Active Todos always use canonical detail.
- Todo Result is selected only from the latest successful completed Todo-bound Work Session and is now verified through the real route/query/render boundary.
- Session Inspector tabs and panels consume one shared authoritative projection; exact placement is `<=760` mobile, `761–1180` overlay, and `>=1181` sibling.
- Rail tokens and project Needs-you counts are hard-cut to the new grammar, and New Todo/New Automation/New Session share one deliberately narrow primary-action primitive.
- The shared primary-action primitive now owns the inclusive narrow-height rule itself: 44px through 760px, compact from 761px on precise pointers, and 44px on coarse pointers. No page-local mobile CTA override remains.
- New Session creation now has a route-level positive interaction contract covering one direct bodyless mutation, exact Session navigation, navigation-state handoff, and production Composer focus consumption.
- Project navigation is fixed by registration order; changing the active project no longer writes recency or changes any desktop mark position.
- Composer has no expand/collapse state or legacy collapsed rendering path; HITL, Goal, and Queue remain above an always-present bottom input.
- Composer attachments use one file-glyph chip grammar for every media type; the image preview/ObjectURL path was deleted.
- The custom Session Source menu transfers keyboard focus to the current option for Enter, Space, ArrowUp, and ArrowDown while pointer opening retains trigger focus.
- Home Upcoming renders its next-fire time once in the trailing signal and includes that value in the row's accessible name.
- New Todo Start discussion no longer performs a Web-owned `create Todo → create Session` sequence. A stable content-bound request identity now owns exactly one Idea Todo, one preallocated Discussion Session, and one durable first-message receipt across concurrency, retries, response loss, and restart; unresolved state fails closed with exact retained links.

## Acceptance audit

| Criterion | Evidence | Status |
| --- | --- | --- |
| AC-01 shared shell and rail | Rail active/hover tokens are hard-cut; picker always shows Needs-you including zero; fixed registration order and unchanged switch geometry are covered by tests and live browser checks | Pass |
| AC-02 Home | Existing four-section projection retained; flat bands and >=920px 2x2 pairing covered by tests and verified at 1440/390 in both themes; Upcoming has one accessible next-fire signal without duplicate row copy | Pass |
| AC-03 Todos inventory and preview | Exclusive transient surfaces, pending guard, focus containment/restoration, canonical lane keyboard order, Board drag, exact 720, non-Active direct detail, exact 760/390 CTA height, and single-command Start discussion exactly-once/recovery contracts all have positive interaction, domain, route, and Runtime evidence | Pass |
| AC-04 Todo detail and Result | Deterministic selector/extractor plus real route/query/render tests prove exact Session selection, one detail request, raw block order, labels, and tool-only suppression | Pass |
| AC-05 Automations | Needs-you/error precedence, split breakpoint, filter, explicit binding, and dialog contracts pass; live 1024/760 creation/list checks have no overflow | Pass |
| AC-06 Sessions inventory | Canonical Todo/Automation filter, authoritative running elapsed, direct Agent source, grouping, live elapsed, exact 760/390 CTA height, direct-create/navigation/composer-focus, and custom Source pointer/Enter/Space/Arrow focus contracts pass | Pass |
| AC-07 Session Detail | Header/Work/model/attachments pass, with one file-glyph chip path and no image-preview compatibility branch; Composer is always present across HITL and terminal failure; shared Inspector counts and exact 1180/1181 placement have focused and live M/A/D plus 2-Agent evidence | Pass |
| AC-08 hard-cut architecture and regression | Shared primary action owns one inclusive mobile-first rule; Start discussion is the sole capture path with no two-step fallback or client Session scan, while ordinary explicit Discussion creation remains distinct; all eight Settings viewport/theme combinations pass | Pass |
| AC-09 automated and real-browser verification | Full repository commands and the 149-test interaction lane pass; real Chrome directly proves the six CTA heights and an active reduced-motion overlay/running comparison in addition to all prior viewport/theme, keyboard, focus, attachment, HITL, Inspector, Automation, Settings, overflow, and console evidence | Pass |
