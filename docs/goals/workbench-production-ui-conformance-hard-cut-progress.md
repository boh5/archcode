# Workbench Production UI Conformance Hard-Cut Progress

## Goal

- Plan: `docs/goals/workbench-production-ui-conformance-hard-cut-plan-goal.md`
- Design baseline: `df7613c85bc614c6a36e0ebe5f702c3b6de4ff6e`
- Started: 2026-08-23 23:43 CST
- Stop deadline: 2026-08-24 04:00 CST
- Status: Complete — user visual approval recorded 2026-08-24 15:21 CST

## Locked Decisions

- The rendered current prototypes are the visual delivery authority; Master and
  page specifications are the interaction/design contract; production remains
  authoritative for domain facts and persisted behavior.
- Todos becomes List-only. Board, its URL state, drag-and-drop implementation,
  dedicated dependencies, and obsolete tests are removed as one hard cut.
- Todo lifecycle and linked Work state remain independent. Preview may move only
  the four ordinary lifecycle stages; only moving to Done while linked Work is
  Running or Needs you asks for confirmation.
- Runs Sources becomes a real ArchCode listbox, with no hidden native-select
  fallback.
- Root and Settings keep their existing product capability and information
  architecture; this Goal only aligns their shared visual system and verifies
  regressions.
- No Protocol/Server expansion is authorized implicitly. If the Web cannot
  obtain an acceptance-critical fact from its current authoritative projection,
  that workstream stops for a user decision.

## Workstreams

| Workstream | Scope | Status | Evidence / Notes |
|---|---|---|---|
| Baseline and capability audit | Record design commit, inspect current product and rendered prototypes, verify required facts | Complete | Baseline is fixed at `df7613c8`. Every current prototype was opened in a real browser; required production facts were available without Protocol/Server expansion. |
| Shared foundation, Root, Settings | Semantic tokens, surfaces, focus, selection, status/elevation/motion; Root and Settings regression | Complete | Shared tokens and explicit popover/modal/drawer/composer elevation roles are implemented. Root redirect and Settings ready dialog were checked in light/dark and narrow/desktop states. Zero-project, Config Recovery, and Runtime Data recovery presentation were additionally rendered through an isolated browser fixture that intercepted only that browser's canonical API responses and never changed the user's registry, Config, or Runtime data. |
| Todos and Todo detail | List-only hard cut, lifecycle/runtime projection, Preview Stage menu, empty/recovery states, responsive behavior | Complete | Board, DnD dependencies, URL/view branch, Board metadata/CSS and obsolete tests are removed. Revision-safe Stage, linked Work independence, focus recovery and 720/721 behavior have positive coverage and real browser evidence. |
| Runs and Schedules | Custom Sources listbox, flat grouped inventories, Automation precedence/detail/editor/responsive behavior | Complete | Sources is a custom listbox with no native fallback. Readiness gates prevent false Recent/Scheduled projection; Invocation rows use one status/link projector and cannot create a ghost Session link. Product matrices pass; populated Schedules is covered by the rendered prototype plus deterministic production presenter/interaction fixtures because all registered projects currently have zero Automations. |
| Session detail | Source-aware shell, Work/Reasoning/Tool projection, ask_user, Inspector, Composer | Complete | 114 focused unit and 24 interaction tests pass; fresh-cache desktop/390px light-dark product/reference review passed with no overflow or Vite error overlay. |
| Integration and automated gates | Focused tests, typecheck, full tests, build, diff check, dependency cleanup | Complete | Root typecheck 5/5 packages, full test graph 8/8 tasks, production build and `git diff --check` all exit 0 after the final hard-cut fixes. |
| Browser acceptance | Prototype/product comparison, light/dark, viewport and exact breakpoint checks, keyboard/focus/overflow/console | Complete with disclosed real/fixture split | Todos, Runs, Schedules and Session were recorded in light/dark at 390/760/1024/1440 with no horizontal overflow. Exact 560/561, 640/641, 720/721, 840/841, 980/981 and 1260/1261 boundaries were exercised. Zero-project and recovery presentation add 16 isolated-browser states with zero captured errors, no Vite overlay, and no overflow. Fixture evidence proves only presentation; unavailable rare Session and populated Automation facts remain prototype/test-backed. |
| Independent review | sol(max) architecture, hard-cut, behavior, and visual-evidence review; fix/review loop | Complete | The full fix/review loop is closed. Later theme-specific reviews found and drove fixes for pre-React first-paint mismatch and storage exceptions; the final Sol(max) review reports P0/P1/P2 all at zero and reconfirms AC-08. |
| User visual review | Representative production/reference evidence and final design judgment | Complete | The user explicitly approved the delivered production visuals on 2026-08-24 at 15:21 CST. AC-09 is closed. |

## Risks And Decisions Needed

- No unresolved product or architecture decision remains. The independent
  review loop is closed with no P0, P1, or P2 finding left open.
- No remaining product, architecture, or visual decision is open. The user has
  explicitly accepted the delivered production visuals.
- Main stop condition: a required Todo, Automation, Session, Tool, Reasoning, or
  finalized `ask_user` fact is absent from the current Web projection and would
  require Protocol/Server changes.
- Browser fixtures may prove a rare presentation state only; mutations,
  revision conflicts, deep links, Back behavior, and persistence must use real
  product paths.
- The 04:00 CST deadline is absolute. If acceptance remains incomplete then,
  implementation stops and this file records exactly what passed and what did
  not.

## Verification Log

- 2026-08-23 23:43 CST — Worktree started at design baseline `df7613c8`; the
  plan-goal file was the only untracked path.
- 2026-08-23 23:43 CST — Read the complete UI/UX Pro Max guidance. Its generated
  style recommendation was rejected as visual authority where it conflicts with
  Master (for example landing-page structure and exaggerated typography); its
  accessibility, focus, responsive, light/dark, and reduced-motion checks remain
  applicable.
- 2026-08-23 23:43 CST — Re-read Design Master and all relevant Root, Todos,
  Runs, Schedules, Session, and Settings page contracts before implementation.
- 2026-08-23 23:50 CST — Opened current `todos.html`, `index.html`, and the
  Settings dialog in a real browser, then compared them with the live production
  UI at the same normal desktop viewport. Production visibly still exposed the
  Board toggle, `Todo workspace` footer, read-only Preview stage, and native
  Sources baseline before the implementation workstreams landed.
- 2026-08-23 23:53 CST — Synchronized the shared semantic palette, auxiliary
  blue, rail and terminal materials, opaque 2px focus token, shape roles,
  restrained primary fill, and role-based elevation. Dialog, dropdown/context
  menu, navigation drawer, Inspector drawer, Composer, and Root entry now consume
  those shared roles instead of page-local shadow ladders.
- 2026-08-23 23:55 CST — Root entry and shared primary-action focused tests pass
  when run independently (6 tests total). The full Web gate remains pending
  until parallel page work is integrated.
- 2026-08-24 00:06 CST — Removed generic visual-depth usage from shared Root,
  Settings, search, tooltip, toast, project rail, HITL, and modal surfaces in
  favor of explicit role tokens. Their six test files pass in isolated Bun
  processes (35 tests total). A combined ad-hoc command exposed pre-existing
  cross-file module-mock contamination, so the evidence records the repository's
  isolated lanes instead of retrying a polluted process.
- 2026-08-24 00:09 CST — A stale 5174 Vite process was rejected as browser
  evidence after its live DOM still contained the pre-change native `select`.
  The Runs/Schedules workstream started a fresh current-worktree server and
  verified the replacement DOM as a button-triggered listbox before continuing
  visual acceptance.
- 2026-08-24 00:16 CST — Session detail workstream completed. Work shows only
  settled Tool counts, token-only Reasoning stays visually empty, repeated Tool
  calls keep source order, finalized `ask_user` summaries cannot report failed
  calls as answered, Inspector stays on its three approved tabs, and Composer
  implements plain Enter versus modifier/IME behavior. Seven cache-busted
  prototype states plus live desktop/390px light/dark product states were
  inspected; the live history supplied `16 tools` and repeated `file_read` calls.
  Finalized answered-question presentation remained prototype/test-backed rather
  than being claimed from an unverified live state.
- 2026-08-24 00:16 CST — Board-only `@dnd-kit` dependencies and lock entries
  were removed after source/tests stopped importing them. Web typecheck, the
  updated visual-contract tests, semantic-token tests, and compact-control tests
  pass. The authoritative isolated full Web lanes remain pending final merge of
  the Runs/Schedules formatter.
- 2026-08-24 00:44 CST — Read-only hard-cut audit found two P1 issues: Recent
  Invocation rows could link a non-existent Session and Runs/Schedules could
  classify before authoritative HITL/runtime snapshots initialized. Both were
  fixed at their existing projection/readiness boundaries. Failed, missed,
  cancelled and pending Invocation facts now outrank linked Session state, and
  only a Session present in inventory receives an `Open Session` link.
- 2026-08-24 00:44 CST — The same audit removed Board-only presentation
  metadata and `.todo-card-selected`, corrected live Running to lime and ordinary
  Composer Syncing to neutral, and deleted the unmounted `ChatHeader`, legacy
  delete dialogs and their dedicated obsolete tests. No compatibility layer,
  fallback or tombstone test was added.
- 2026-08-24 00:55 CST — Root `bun run typecheck` passed all 5 packages. Root
  `bun run test` passed all 8 tasks, including Web isolated unit/interaction,
  Agent Core unit/integration/architecture, Server, Protocol and Utils. Existing
  Settings test `act(...)` warnings remain warnings only; there were no failures.
- 2026-08-24 00:58 CST — Root `bun run build` passed the production Web build,
  generated the embedded production entrypoint, and completed the compile path.
  Only the repository's existing Vite large-chunk warning was emitted.
- 2026-08-24 01:12 CST — Runs Sources was operated in the real product with
  keyboard `End` + `Enter`: focus moved to Direct, selection committed, the
  listbox closed, focus returned to the trigger, and the inventory contained
  only the two real Direct Sessions. The live DOM contains no native `select`.
- 2026-08-24 01:13 CST — Product Runs and Schedules were visually inspected and
  captured in light/dark at 390, 760, 1024 and 1440px. Every measured viewport
  had `scrollWidth === clientWidth` and no Vite error overlay. The registered
  project inventory contains six real Sessions and zero Automations; therefore
  Schedules product evidence truthfully covers the first-use empty state, while
  populated split/detail, failed/missed and narrow Back remain prototype-backed
  plus deterministic production interaction tests rather than fake production
  data.
- 2026-08-24 01:38 CST — A shared Session-family presentation helper replaced
  duplicated active/attention counting. Navigator `All todos` now uses the
  canonical active Todo count, Runs uses authoritative active Session facts,
  Schedules shows an unknown marker until inventory is authoritative, and Toast
  announcements use a polite status live region.
- 2026-08-24 01:45 CST — First Sol(max) final review found three P1 issues:
  Preview capability fail-open behavior, `waiting_for_human` rendered as live
  Running, and Automation Pause/Resume discarding a dirty editor draft. The
  implementation was corrected and positive tests were added.
- 2026-08-24 01:48 CST — Second review found the Preview readiness fix was too
  broad. Session-inventory readiness now controls only Start/Continue/Discussion;
  full operational readiness controls only entering Done. Idea, Ready and In
  progress changes and Open details remain available when unrelated runtime,
  HITL or Automation facts are unavailable.
- 2026-08-24 01:54 CST — Third review found two transition-boundary P1 issues.
  Entering Done now rechecks readiness at the actual submission boundary for
  first selection, confirmation and retry, and revokes stale confirmation/retry
  UI without PATCH when readiness expires. Runs rows now enter the elapsed/live
  branch only when their final presentation kind is Running, so Waiting remains
  visible on desktop and mobile.
- 2026-08-24 02:01 CST — Fourth Sol review reported no P0/P1 and marked AC-08
  pass. Its remaining P2 noted that reverse Tab from an open Sources listbox
  skipped a visible Clear button when a query existed. The Runs-page-local focus
  target was corrected, a positive interaction test was added, and a narrow
  re-review confirmed the P2 closed with no new architecture issue.
- 2026-08-24 02:02 CST — Independent real-browser Session QA completed one real
  Direct completed Session in light/dark at 390/760/1024/1440. All eight states
  had no horizontal overflow; Composer was 16px at 390/760, Inspector was a
  sibling at 1440 and an overlay with scrim at 390, and same-viewport prototype
  comparisons at 390/1440 showed no P0/P1.
- 2026-08-24 02:03 CST — Root redirect and Settings ready dialog were captured
  in light/dark at 390/1440, Settings exact 640/641, Todo exact 560/561,
  720/721 and 980/981, Schedules exact 840/841, and Inspector exact 1260/1261.
  A final Todo 720/721/980/981 rerun confirmed canonical detail versus Preview,
  the Navigator boundary, enabled Stage/primary actions, zero overflow, zero
  captured browser errors, and no Vite overlay.
- 2026-08-24 02:05 CST — Final post-review gates passed: root typecheck 5/5
  packages, root test graph 8/8 tasks (Web interaction lane 165 tests), production
  build with an arm64 Mach-O binary, and `git diff --check`. No Server, Protocol
  or Agent Core source file changed.
- 2026-08-24 02:18 CST — Isolated browser preparation rendered zero-project,
  Config Recovery link-required, and Runtime Data recovery states without
  mutating the user's registry, Config, or Runtime data. The first matrix exposed
  a real defect: recovery surfaces mounted before the old RootLayout-owned theme
  hook and therefore remained dark when the saved theme was light.
- 2026-08-24 02:25 CST — Theme ownership was hard-cut to one global
  `ThemeProvider` above `BootstrapGate`; RootLayout now consumes that owner and
  no fallback path was kept. The repeated 16-state isolated matrix passed in
  light/dark at 390/1440 for zero-project and Config Recovery, plus
  390/640/641/1440 for Runtime Data recovery. Every state had zero captured
  browser errors, no Vite overlay, no horizontal overflow, and destructive
  Runtime data selection remained empty by default. Root typecheck 5/5, test
  graph 8/8, production build, arm64 binary check, and `git diff --check` passed
  again.
- 2026-08-24 02:29 CST — The narrow Sol(max) review found one first-paint P1:
  the static document default could paint dark before React applied a saved
  light theme. A synchronous head bootstrap and one application-root theme
  owner now agree before and after React mounts. StrictMode side effects were
  removed from state updaters, and a paused-before-main browser probe confirmed
  the saved light theme was already applied while the React root was still
  empty.
- 2026-08-24 02:35 CST — The next Sol(max) review found one storage-exception
  P1: denied reads or quota-denied writes could blank the application or block a
  theme change. Safe reads now fall back to system preference and failed writes
  still update in-memory and rendered state. Positive SecurityError and
  QuotaExceeded tests pass; no second theme owner, compatibility branch, or
  fallback implementation was introduced. Final Sol(max) review reported
  P0/P1/P2 all at zero and signed AC-08.
- 2026-08-24 02:38 CST — Final post-review gates passed again: root test graph
  8/8 tasks, root production build and typecheck 5/5 packages, arm64 Mach-O
  binary verification, and `git diff --check`. The final diff remains confined
  to Web UI, its dependency lock changes, and the two Goal documents; Server,
  Protocol, and Agent Core source trees are unchanged.
- 2026-08-24 15:21 CST — The user explicitly approved the representative
  production visuals. No implementation work occurred after the 04:00 CST stop
  deadline; this entry records the later user acceptance and closes AC-09.

## Completion Audit

- AC-01: `PARTIAL_WITH_DISCLOSED_STATE_SPLIT` — all current prototypes and the
  prepared production surfaces were opened and compared. Real browser evidence
  is complete for the primary inventories and one representative Session.
  Zero-project and recovery presentation now have isolated-browser visual
  evidence, explicitly not persistence evidence. Populated Schedules and several
  rare Session runtime states remain prototype plus deterministic production-test
  evidence rather than fabricated live data.
- AC-02: `PASS_IMPLEMENTATION_AND_OBSERVED_MATRIX` — shared visual owners,
  focused tests and prepared light/dark browser matrices pass. The user has
  explicitly accepted the delivered visual result.
- AC-03: `PASS_IMPLEMENTATION_AND_INTERACTION` — Todos is a clean List-only hard
  cut with a revision-safe custom Stage menu, separated readiness boundaries and
  no Board fallback. The 720/721 and 980/981 browser boundaries pass.
- AC-04: `PASS_WITH_DISCLOSED_FIXTURE_SPLIT` — Runs is proven with real Sessions;
  Schedules first-use is proven with real empty data and populated behavior with
  the current prototype plus production view-model/interaction fixtures.
- AC-05: `PASS_IMPLEMENTATION_WITH_DISCLOSED_REAL_STATE_GAPS` — Session work,
  tools, reasoning, ask-user, Inspector and Composer tests pass; a real Direct
  completed Session passed the full light/dark width matrix. Permission,
  question, Automation-source-only and failed-Bash combinations remain
  prototype/test-backed rather than fabricated live data.
- AC-06: `PASS_WITH_ISOLATED_PRESENTATION_FIXTURES` — Root redirect and Settings
  ready dialog pass product checks. Zero-project, Config Recovery and Runtime
  Data recovery pass isolated canonical-response browser presentation checks in
  light/dark and narrow/desktop states; the fixture is not claimed as API,
  mutation, or persistence evidence, which remain covered by existing direct
  and interaction tests. No user registry, Config, or Runtime data was changed.
- AC-07: `PASS_FOR_PREPARED_STATES` — primary 390/760/1024/1440 matrices and all
  named exact breakpoint pairs pass with zero measured overflow; captured CDP
  scenarios have zero browser errors and no Vite overlay. Rare unavailable
  product states remain covered by interaction tests.
- AC-08: `PASS` — the complete Sol(max) fix/review loop is closed. The final
  review reports no remaining P0, P1, or P2 issue, including the global theme,
  first-paint, and browser-storage exception paths.
- AC-09: `PASS` — focused and full automated gates, production build, prepared
  browser QA, and the user's explicit visual approval are all complete.
