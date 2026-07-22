# Orchestration Workbench UI Hard-Cut Progress

## Status

- State: Complete
- Started: 2026-07-22
- Goal: `docs/goals/orchestration-workbench-ui-hard-cut-plan-goal.md`
- Visual reference: `docs/web/orchestration-workbench-demo.html`

## Locked Decisions

- Historical Session data will be removed before deployment; no migration, legacy reader, fallback, or guessed grouping.
- Current/latest Execution opens by default; historical Executions are independently expandable.
- Composer keeps Goal and Input visible; Queue and HITL remain direct, unaggregated, independently scrollable surfaces.
- Goal budget remains editable only when `budget_limited`.
- This Goal optimizes Web DOM mounting for large Sessions; Server pagination/archival remains out of scope.

## Work Log

- Audited the accepted plan-goal, Demo, current worktree, and existing Session/Dashboard/Composer ownership.
- Confirmed the starting worktree contains only the untracked plan-goal and Demo artifacts; no product-code edits existed before implementation.
- Added a pure `buildExecutionWorkstream` projection with deterministic Execution/activity ordering, typed diagnostics, authoritative Tool/Child counts, Session identity, and a 1,000/10,000/20,000 fixture.
- Hard-cut the Session route from the flat `ChatMessages` renderer to `ExecutionWorkstream`; removed the production transcript/Queue owner and Agent appearance mapping.
- Added Execution cards with current/latest default expansion, unmounted collapsed bodies, full existing part renderers, visible model binding, route-lifecycle expansion/scroll memory, and the 100px follow boundary.
- Moved Queue/local sending state into the Composer, compressed Goal controls into a single row/Dialog, and fixed Dock order and scroll ownership.
- Reworked Delegation as a special Tool card, removed Agent avatars/initials from the Inspector, reordered Project Dashboard before Todos, and expanded the Session Header with real Execution/model state.
- First integrated targeted gate: 48 projection/content/Header/Goal/Delegation/surface tests passed with zero failures.
- Closed the independent gap audit findings: snapshot compression hydration, Dashboard/Sidebar tab preservation, route-scoped root/Child UI state, authoritative Inspector status, narrow Queue rows, and stale route-test fixtures.
- Real browser QA exposed and fixed an 11px scrollbar-gutter mismatch between Workstream and Composer rails, then proved exact `0px` rail delta at 1024px.
- Real browser QA exposed and fixed Strict Mode clearing the route cache during its simulated effect teardown; root → focused Child → root now preserves the original expansion state while true route exit still clears it.
- Public product-flow QA created 8 Executions, foreground Delegation, expandable Tool details, active then paused Goal, two direct Queue rows, permission HITL, and two-question HITL; both HITL cards disappeared immediately after response.
- Browser matrix passed at 1440/1024/390/320 with Project Dashboard, root, focused Child, Inspector on/off, Focus Mode, mobile navigation/Inspector drawers, zero horizontal document overflow, and zero console warnings/errors.
- Live scrolling QA measured a historical reader staying at `scrollTop=78` while content grew by 240px, then near-bottom output growing by 263px while remaining within 1px of the bottom.
- Updated the DCP executable parity test to point from the deleted `ChatMessages.test.tsx` to its hard-cut replacement `ExecutionWorkstream.parts.test.tsx`; no Agent Core runtime code changed.
- Full gates pass: `bun run typecheck`, `bun run test`, `bun run web:build`, and `git diff --check` all exit 0.
- First fresh independent `sol(xhigh)` review found three concrete gaps: cold-load Dynamic Compression, nested Child status authority, and missing mounted-shell/Inspector-keyboard interaction evidence.
- Corrected the existing Session read boundary so persisted structured Compression state becomes the already-defined Protocol snapshot; persistence schema and Server routes remain unchanged.
- Nested Agent status now resolves each generation from that Child's own authoritative parent Session links, with Session detail invalidation on live delegation updates and a mounted root/child/grandchild test.
- Added mounted `RootLayout` route tests proving Project Bar/Sidebar node identity plus width/tab/search/collapse preservation, and direct Arrow/Home/End Inspector interaction coverage.
- A second fresh independent `sol(xhigh)` review found two real consistency defects: Dynamic Compression cards had separate live/cold status sources, and Queue hid requested-model/invalidation information at 320/390px.
- Hard-cut Workstream Compression to one authoritative snapshot projection with deterministic `compression:{ref}:{id}` identities; the Session API no longer returns or hydrates a second display-part list.
- Kept Queue requested-model and invalidation text visibly present as a compact one-line column at 320/390px; only duplicate local send-status prose may hide.
- Re-ran all gates after the second review fixes: typecheck `5/5`, test tasks `8/8`, Agent Core unit `2627/0`, integration `132/0`, architecture `95/0`, Web interaction `71/0`, production Web build and `git diff --check` all pass.
- Real browser cold-load QA used a durable Queue row and proved its requested model remains rendered at both 320px and 390px with zero document/row horizontal overflow; browser console warnings/errors remained zero. The QA execution was stopped and its queued row deleted afterward.
- Final fresh independent `sol(xhigh)` review returned `VERDICT: APPROVED` with no reproducible P0/P1/P2 acceptance blocker across AC-01 through AC-08.
- Follow-up status correction first removed stale `Waiting for you`, then replaced the insufficient static historical label with a runtime-authored input-checkpoint read projection: unresolved input shows `Needs you`; answered input shows `Input received` and its continuation Execution; abnormal terminal states remain `Stopped` with their specific runtime reason.
- Real browser QA on the reported question Session now confirms `Input received · Continued in Execution 2` + `Completed`; a separate persisted cancellation Session confirmed `Stopped · Cancelled` in the Header and cards plus the detailed `Session family cancelled` reason when expanded.
- Follow-up gates pass: full typecheck, Web/unit/interaction suites, 2,627 Agent Core unit tests, 132 integration tests, 95 architecture tests, production Web build, and diff hygiene. One full-suite worktree test had a single 5s environmental timeout; the same test passed in 286ms alone and again inside the complete integration lane.
- Final checkpoint review removed two unsafe inferences: an unrelated later `tool_batch` Execution cannot be linked without `continuationStartedAt`, and only an explicit cancel response projects `cancelled`. The fresh full monorepo suite, production Web build, and `git diff --check` all pass.

## Implementation Phases

- [x] Build the pure Execution workstream projection and diagnostics.
- [x] Replace the flat Session transcript with Execution cards while preserving all SessionPart renderers.
- [x] Move pending/local messages into the Composer queue and hard-cut the old transcript ownership.
- [x] Compress Goal controls into a single row and Dialog.
- [x] Remove Agent avatars/initials from Session, Delegation, and Inspector surfaces.
- [x] Preserve Dashboard scope semantics while tightening project-shell navigation.
- [x] Complete full-repository automated and independent-review gates.

## Risks Under Test

- SessionPart regressions during the `ChatMessages` hard cut.
- Incorrect message/Tool/Compression ordering in the new projection.
- Composer height competition when Queue and HITL are both populated.
- Large collapsed Sessions mounting hidden bodies.
- Existing Child focus, Diff, model audit, Queue/Steer, Goal, and HITL flows losing behavior.
