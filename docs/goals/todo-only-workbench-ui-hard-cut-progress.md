# Todo-only Workbench UI Hard-Cut Progress

## Status

- Goal: `docs/goals/todo-only-workbench-ui-hard-cut-plan-goal.md`
- State: `complete`
- Started: 2026-08-17
- Working branch: `design/prototype-status-polish`
- Starting commit: `202fee6e2609007f584fcc86ec84498fb2bd1d9f`
- Starting prototype state: same commit; no tracked prototype changes present at start
- Pre-existing worktree change: untracked Goal document only

## Execution Log

### 2026-08-17 — Baseline and decomposition

- Re-read the approved Goal, current design-system baseline, page references, and the UI/UX Pro Max and browser-control workflows.
- Ran the required UI/UX design-system advisory query. Its generic purple AI landing-page direction was rejected; only accessibility, focus, font loading, layout stability, responsive, and reduced-motion guidance remains applicable.
- Confirmed the implementation must be judged from actual browser-rendered prototypes, while current product/API/store/persistence remain the functional authority.
- Started three bounded read-only audits in parallel:
  - current Web route/layout/component/test ownership;
  - rendered prototype state and responsive matrix;
  - Home deletion and Todo/Session/Automation functional boundaries.
- No product code has been changed yet.

### 2026-08-17 — Rendered baseline and first corrections

- Started an isolated prototype server on `127.0.0.1:4181` and a separate Vite Web surface on `127.0.0.1:4173`; the pre-existing user processes on 5173/4096 were not stopped or changed.
- Inspected the actual 1440×900 rendered Todos prototype and current product Home/project Todos surfaces in the in-app browser. The observed gap is structural, not cosmetic: the prototype is `52px rail + 276px Todo navigator + canvas`, while the product still renders Global Home and project top tabs.
- Confirmed all currently registered product projects have empty active Todo inventories; rich product-state visual QA will therefore require the existing mocked interaction surfaces or a disposable runtime later, not mutation of user project data.
- Prototype audit found objective defects that must be corrected before final baseline use:
  - global Search/Open project/Settings overlays are missing on four prototype pages;
  - navigator and Inspector overlays lack the approved focus/scrim contracts;
  - representative Direct/non-Todo Automation focused-child/full-diff states are unreachable;
  - New Todo has no pending demonstration state;
  - prototype still uses a runtime Google font import.
- Assigned those prototype-only corrections to a bounded worker; no product capability is being inferred from synthetic fixtures.
- Downloaded the official Inter v4.1 release asset and installed byte-identical `InterVariable.woff2` plus `LICENSE.txt` into Web public and prototype font directories. Verified archive/font/license SHA-256 values exactly match the Goal.
- Removed external Google font links from Web, added the local upright variable face, and updated the product sans stack to Inter with the full system/CJK fallback.
- Ran the starting full `bun run typecheck`: PASS (5/5 workspaces, cached baseline).

### 2026-08-17 — First implementation slice

- Applied the six-token motion hard cut across Web source and removed every use of the old four motion aliases; this is a mechanical vocabulary replacement, not a compatibility layer.
- Removed RootLayout's ownership of project/session navigation and Inspector presentation. RootLayout now owns only the persistent project rail, global Search dialog, work canvas, and global HITL notices.
- Moved the New Todo mutation/recovery controller into one `ProjectTodoCaptureDialog` component for ProjectLayout to own. Removed the duplicate route-local dialog, document-level `C`/`J`/`K`/`Enter` shortcuts, and capture state from `ProjectTodosRoute`.
- Updated Todo board responsive geometry to the approved four horizontally scrollable lanes at `<=720`, two columns at `721–1260`, and four columns from `1261`.
- Browser-rechecked the current 1440×900 prototype after the first prototype corrections. Its rendered baseline remains `52px rail + 276px navigator + Todo canvas`; production has not yet reached this geometry while the project-shell worker is in progress.
- Root/Home hard-cut implementation completed its focused server/protocol/Web tests; integration cleanup and full-workspace gates remain pending.

### 2026-08-17 — Root, navigator, prototype, and operations integration

- Completed the Global Home hard cut: `/` now resolves through the project registry to last/current All todos or the sole no-project registration state; `/api/search` remains, while the Home DTO/query/SSE/API path is removed end to end.
- Completed the project shell ownership move. `ProjectLayout` now exclusively owns the 276px Todo navigator, `<=980px` drawer, New Todo dialog, and Session Inspector sibling/overlay; `ProjectToolbar` and the top `Todos / Automations / Sessions` tabs were deleted.
- Completed the project-scoped navigator projection using existing queries/stores. Needs-you uses authoritative linked-root HITL and blocked/budget-limited Work/Automation Goals only; it never infers attention from coarse `waiting_for_human`.
- Completed objective prototype corrections and verified them in the real browser: global overlays on every page, navigator/Inspector scrim and focus contracts, Direct/non-Todo Automation focused-child/full-diff fixtures, New Todo pending lock, and local Inter loading.
- Completed Runs/Schedules shell integration without changing their canonical API behavior. Runs retains full Session inventory and the sole New Session action; Schedules retains Automation inventory/detail and the sole New Automation action.
- Performed the first 1440 product/prototype geometric comparison after integration. Product now matches the structural `52px rail + 276px navigator + canvas`, with All todos compact header and the command row separated as in the rendered prototype. Precise control anchors are being calibrated from browser-measured rectangles, not inferred from source.

### 2026-08-17 — Todo, Work, Session, and capture hard cut

- Completed the Selected Todo shell and canonical `/projects/:slug/todos/:todoId/work` surface. Todo remains the document/lifecycle owner; Work lists only the bound Todo's root Discussion, Work, and Automation Sessions, preserves filter/kind/scroll route state, and navigates to the canonical Session URL.
- Completed source-aware Session shells from canonical root `session.source`: Todo-bound Sessions retain one Todo shell plus context row; Direct and non-Todo Automation Sessions use one compact source row. Focused-child and full-diff replace only the canvas while the root composer, queue, HITL, and execution ownership remain intact.
- Completed the single ProjectLayout-owned New Todo capture controller, including stable retry IDs, exact typed recovery links, operation-token isolation, and a pending lock that blocks Escape, outside click, close, repeat submission, and every action.
- Deleted the former Home route/DTO/SSE projection, project toolbar, duplicate capture controller, document-level shortcuts, and legacy right-side Todo work rail. No compatibility path, fallback UI, duplicate provider/store, or tombstone test was added.
- Added inclusive media queries only for the approved exact boundaries. Non-target pre-existing arbitrary breakpoints (`559/639/761/799/1099`) were restored unchanged after an over-broad mechanical conversion was detected during the overdesign audit.

### 2026-08-17 — Browser calibration and review fixes

- Compared current prototype and product renders at matching sizes. Those comparisons found material misses that source inspection and tests had not exposed: Runs/Schedules command and row geometry, the 760px header/rail split, 720/721 Todo command density, 560/561 selected-Todo alignment, Inspector width, running-row treatment, and several focus/recovery paths.
- Fixed each reported implementation defect and added positive tests for the current contract. The latest 560/561, 720/721, and 760 geometry patches remain `RECHECK_REQUIRED` until a fresh product/prototype browser pass is recorded; earlier screenshots are not reused as proof.
- Corrected two prototype defects before using them as references: Open project now preserves the existing directory-search capability, and the no-project prototype no longer exposes project-scoped Search.
- Preserved the existing browser-notification permission action in the Needs-you popover while deleting only the obsolete aggregate `View all` footer.
- Added a disposable runtime at `/private/tmp/archcode-todo-only-qa.QC2ZIe` with one Todo, one Automation, Todo/Direct/non-Todo-Automation roots, three real child Sessions, a real diff, and a persisted running Direct execution. No registered user project data was changed.
- The in-app browser connection used by the primary implementer repeatedly timed out while navigating the latest local product build. Those attempts are not recorded as visual passes. The independent reviewer is re-running the latest matrix against stable product `5174`, prototype `4181`, and isolated API `4096`.

### 2026-08-17 — Final rendered calibration and disposable-state coverage

- Reused one product/prototype browser-tab pair for the final matrix and closed completed tabs immediately. No test or source inspection was substituted for rendered evidence.
- Calibrated and independently rechecked Root/no-project, rail/More, Search, Needs-you, Open project, Todo List/Board/New/preview, Selected Todo/Work, Runs, Schedules, Settings, Inspector, Composer, focused-child, and full-diff surfaces at their exact responsive boundaries. Fixed every measured anchor, token, focus, scroll-owner, and dark-theme mismatch reported by review.
- Prepared additional durable fixtures only inside `/private/tmp/archcode-todo-only-qa.QC2ZIe`: Ready/In-progress/Done/Rejected/Archived Todos, Discussion and Todo-origin Automation roots, active `ask_user` HITL, edited queued input, an uploaded attachment chip, a failed terminal execution, and five registered disposable projects. The real user registry and project data were not touched.
- Ran a separate empty-registry host on `4183` and verified no-project plus delayed real registry failure/Retry states. The temporary host was stopped after evidence collection.
- Removed remaining source-string tombstone assertions found by review and updated positive visual contracts to the current rendered ownership and geometry.

### 2026-08-17 — Completion

- Final `gpt-5.6-sol` max independent review verdict: `APPROVE`; no unresolved P0/P1/P2, capability drift, fallback, compatibility path, tombstone test, duplicate state owner, or unnecessary abstraction.
- Latest-tree gates all passed: typecheck 5/5, test 8/8, production build with 310 embedded assets, binary `archcode 0.0.8`, prototype JavaScript syntax, byte-identical local Inter, and diff-check.
- The reviewer reset the viewport and closed the remaining product/prototype QA tabs; final known QA tab count is zero.
- Stopped the agent-started QA listeners on 4096, 4181, 5175, and IPv4 5174; preserved the pre-existing unrelated IPv6 5174 listener.

### 2026-08-17 — Todo-only Needs-you follow-up

- Kept the persistent project navigator strictly Todo-only: one row remains one Todo, while the trailing value is the exact number of actionable requests and Goal gates under that Todo.
- Added an authoritative Needs-you section at the top of the Todo Work surface. It renders one row per pending HITL request or blocked/budget-limited Work/Automation Goal, preserving simultaneous Build, Analyst, and other child-Session actions instead of collapsing them into one Todo-level label.
- Projected the exact owning Agent and Session title through the existing global HITL snapshot/event boundary. This metadata remains presentation-only and is not persisted into the HITL queue or a new store.
- Kept response ownership in the canonical Session: each action row deep-links to the root Session with the exact `hitl` request and child `focus` parameters. The Todo Work surface does not duplicate permission/question controls.
- Updated the Todos specification and current prototypes to show the approved hierarchy: Todo-only navigation first, action-level detail only after opening that Todo's Work surface.
- Used a disposable runtime to verify two simultaneous child-Worker requests under one Todo. The browser showed two distinct action rows and each navigated to the exact focused child Session and active request. The single QA tab and all agent-started temporary listeners were closed afterward.
- Latest-tree gates passed after the follow-up: typecheck 5/5, test 8/8 tasks, production build with 310 embedded assets, binary `archcode 0.0.8`, prototype JavaScript syntax, and diff-check. One visual-contract failure found by the first full run was corrected before the clean rerun.
- The independent sol(max) review found one unnecessary dependency: a Schedules-only loading/error state could hide otherwise authoritative Needs-you rows. Needs-you now depends only on Todos, Session inventory, and HITL; Automation/runtime state remains isolated to operational presentation. A positive regression test covers this exact boundary.
- Final independent follow-up verdict: `APPROVE`; no unresolved capability drift, multi-Worker collapse, persistence leak, fallback, compatibility path, tombstone test, or unnecessary abstraction.

## Decisions and Corrections

- No user decision remains pending.
- The prototype is the rendered visual authority, but it cannot invent product capability. Existing product/API/store/persistence behavior remains authoritative unless this Goal explicitly hard-cuts it.
- Product-only states have no fabricated prototype twin; they are visually judged against the shared shell contract and functionally judged against product facts.
- Local Inter is pinned and byte-identical in product and prototype. No external font fallback path is retained.
- The implementation reuses `WorkbenchLayoutProvider`, route outlet context, existing queries, and existing stores. No generic shell framework, new domain store, or second capture state owner was introduced.

## Risks Being Tracked

- The worktree is on an existing user branch; all unrelated user changes have been preserved and no commit was created.
- Rich browser QA used only a disposable runtime. No registered user project data was mutated.
- No acceptance risk remains open. Disposable browser state, temporary listeners, and QA tabs were cleaned after evidence collection.

## Browser QA Ledger

`direct prototype` names a real same-state reference. `nearest` is used only for product-only preserved behavior. `RECHECK_REQUIRED` means the latest implementation has not yet been viewed after its final patch.

| qa_state_id | Product / browser action | viewport / theme | evidence lane | reference | named anchors or visible contract | result |
|---|---|---|---|---|---|---|
| ROOT-NO-PROJECT | isolated `/`; registry success-empty | 1440 light, 390 dark | prototype-backed | direct `index:no-project` | rail, static brand, Open project, Settings, empty canvas | browser PASS; anchors within 0.32px |
| ROOT-REGISTRY-TRANSIENT | isolated `/`; loading then error + Retry | 390/1440 light | product-only-preserved | nearest `index:no-project`, root error primitive | rail remains stable; no false empty state | browser PASS; real delayed 500 and Retry cycle |
| GLOBAL-SEARCH-EMPTY | click visible Search | 1440 light | prototype-backed | direct `global-search:empty` | 640px dialog, 44px field, 114px result region, focus return | visual PASS; product 640×245 vs prototype 640×246.5 |
| GLOBAL-SEARCH-RESULTS | search project/Todo/Session/Automation and open each | 1440 light | prototype-backed | direct `global-search:results` | result density, exact canonical deep links | browser + exact-link tests PASS |
| GLOBAL-NEEDS-YOU | click Bell; enable desktop alerts; open exact item | 1440 light, 390 dark | prototype-backed + preserved local action | direct `global-needs-you`; nearest header action | popover/sheet, badge, permission action, focus return | browser PASS; 58px header/rows and exact focus |
| GLOBAL-OPEN-PROJECT | click Open project | 1440 light | prototype-backed | direct corrected `open-project:initial` | 560px dialog, 65px header, 56px search region, 32px field, disabled action | visual PASS |
| RAIL-MORE | 4/5+ marks, More, Add | 1440/760 light | product-only-preserved | nearest prototype rail primitives | registration order, 52/48px rail, More inventory | browser PASS; five projects + compact picker |
| PROJECT-NAV-PERSISTENT | open project Todos | 1440 light/dark | prototype-backed | direct `todo-nav:persistent` | 52px rail + 276px navigator + canvas | browser PASS in light/dark; current dark token table verified |
| PROJECT-NAV-DRAWER | open/close navigation; resize 980↔981 | 980/981, 390 light | prototype-backed | direct `todo-nav:drawer` | scrim, close, focus trap/restore, 52/48px rail | browser + interaction PASS |
| TODOS-LIST-BOARD | switch List/Board and selected controls | 720/721/1440 light | prototype-backed | direct `todos:list`, `todos:board` | header, command row, 430px search, lane geometry/scroll owner, selected brand inset | browser PASS |
| TODOS-NEW-PREVIEW | open New Todo; pending; preview drawer | 390/1024/1440 light | prototype-backed | direct `todos:new`, `todos:new-pending`, `todos:preview` | content-fit modal, disabled pending controls, preview/scrim | browser + interaction PASS |
| TODO-SELECTED-WORK | open Todo then Work | 560/561/720/721/1440 light | prototype-backed | direct `selected-todo:todo`, `selected-todo:work` | 88/58px shell, trigger/title/tab alignment, lifecycle and Work rows | browser PASS; boundary anchors <=1px |
| TODO-WORK-NEEDS-YOU | open a Needs-you Todo with two child Workers; open each action | 1440 light | prototype-backed + real durable HITL | direct `selected-todo:work-needs-you` | one Todo navigator row with exact count; one 58px row per action; exact Agent/Session/mechanism; canonical root + `hitl` + child `focus` | browser PASS; two simultaneous child requests remained distinct, no horizontal overflow |
| RUNS-INVENTORY | open Runs; compare idle/recent rows | 760/761/1280/1440 light | prototype-backed | direct `runs:inventory` | command bar, 30/27px orbit, 66px row, status/time/chevron | browser PASS |
| RUNS-RUNNING | refresh Runs with persisted running Direct root | 760/1440 light | prototype-backed | direct `runs:running-featured` | 5px margin, brand-tinted border/field, 8px radius, 2px inset | browser PASS |
| SCHEDULES-LIST-DETAIL | open list/detail and selection | 760/761/840/841/1440 light | prototype-backed | direct `schedules:list`, `schedules:detail` | command bar, orbit/status/chevron, split boundary, 64px canvas gutter | browser PASS; 841 scrollHeight 718/max 159/bottom gutter 64.422px |
| SCHEDULES-NEW-EDIT | open New/Edit Automation | 390/1024/1440 light | prototype-backed | direct `schedules:new`, `schedules:edit` | dialog hierarchy, focus return, current domain fields | browser PASS |
| SESSION-ROOT-SHELLS | open Todo Work/Discussion/Todo-Automation/Direct/non-Todo-Automation roots | 390/1024/1440 light/dark | prototype-backed | direct five source-shell fixtures | source-aware 145/115/108/58px insets; one root composer | browser PASS; canonical Discussion/Todo-Automation/Direct fixtures used |
| SESSION-FOCUSED-DIFF | open focused child then full diff for Todo/Direct/non-Todo Automation | 1024/1440 light | prototype-backed | direct three focused-child and three full-diff fixtures | root shell/composer retained; only canvas replaced | browser PASS; full diff x354/w900 and focused heading x378/w852 |
| SESSION-COMPOSER-STATES | normal/running/HITL/Queue edit/model menu/failed/attachment | 390/1024/1440 light/dark | prototype-backed | direct Composer state fixtures | priority/input surface, queue ownership, failure and attachment recovery | browser PASS; real HITL/edited queue/attachment/failed fixtures; model menu x529.023/y373/w308/h280 |
| INSPECTOR-STATES | Agents/Changes/Context, collapse, sibling/overlay, resize | 1260/1261/1440 light/dark | prototype-backed | direct Inspector fixtures | 280/360/460px width, source-aware scrim inset, focus migration | browser + interaction PASS |
| SETTINGS | open/close Settings; 640↔641 | 390/640/641/1024/1440 light/dark | prototype-backed | direct `settings` on current prototypes | modal nav/grid, footer, focus return | browser + regression tests PASS |
| FONT-LOCAL-INTER | cold load product and every prototype | 1440 light | prototype-backed | direct shared typography | loaded Inter, identical WOFF2, no external host, stable anchors | visual/resource PASS |

## Verification Ledger

| Gate | Result | Evidence |
|---|---|---|
| Starting worktree inspected | PASS | branch and commit recorded above |
| Goal review | PASS | approved independent Plan review from prior phase |
| Starting product render | PASS | 1440×900 Home and project Todos visually inspected in browser |
| Starting prototype render | PASS | 1440×900 Todos List visually inspected in browser |
| Official Inter asset | PASS | archive/font/license SHA-256 match Goal; product/prototype font bytes identical |
| Baseline typecheck | PASS | `bun run typecheck`, 5/5 workspaces |
| Product implementation | PASS | Todo-only shell, Todo/Work, Runs/Schedules, source-aware Session, capture, root hard cut |
| Prototype/product visual matrix | PASS | current prototype and product were visually compared in real browsers for every required row and exact boundary in the ledger |
| Focused tests | PASS | shell, Todo/Work, Session, capture, visual-contract, compact-surface, ProjectBar |
| Local font/runtime | PASS | byte-identical SHA-256, HTTP 200, `document.fonts.check`, stable measured anchors, no external font hosts |
| Architecture/overdesign audit | PASS | one layout provider, one capture owner, no new store/framework/fallback/legacy compatibility path |
| Full typecheck/test/build | PASS | follow-up latest tree: `bun run typecheck` 5/5; `bun run test` 8/8 tasks; `bun run build` with 310 assets; binary `archcode 0.0.8`; prototype syntax and `git diff --check` |
| Independent implementation review | PASS | sol(max) follow-up verdict `APPROVE`; review fix decoupled authoritative Needs-you from Schedules-only failure; no unresolved P0/P1/P2 |
