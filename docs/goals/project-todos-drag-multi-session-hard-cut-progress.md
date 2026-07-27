# Project Todos Drag And Multi-Session Hard-Cut Progress

## Status

- Goal: complete; independent final review passed with no blocker, high, or medium findings
- Worktree: `codex/project-todos-drag`

## Execution Log

- 2026-07-27: Created the dedicated worktree and started implementation from the approved plan-goal.
- 2026-07-27: Imported the approved plan-goal unchanged into the worktree.
- 2026-07-27: Started three parallel implementation streams:
  - Todo canonical domain, ordering, service, and four HTTP endpoints.
  - Root Session source identity, Discussion authorization, Automation provenance, and deletion decoupling.
  - Web four-column drag-and-drop board, direct related resources, action semantics, and interaction coverage.
- 2026-07-27: Completed the Todo domain and API hard cut:
  - Canonical status is `idea | ready | in_progress | done | rejected`.
  - `state.todos` is the sole ordering authority; flat PATCH owns content, state, archive, and `beforeTodoId`.
  - Todo no longer stores Session or Automation identity, and the route family now has exactly four endpoints.
- 2026-07-27: Completed source-owned work relationships:
  - Root Lead Session owns optional `{ todoId, entry }`; backend owns Session ID generation.
  - Automation owns optional `projectTodoId`; Invocation Sessions do not copy or infer the relationship.
  - Session deletion has no Todo-specific protection, callback, detachment, or tombstone.
- 2026-07-27: Completed the Web hard cut:
  - Four responsive sortable lanes use pointer, touch, and keyboard sensors with a dedicated handle and accessible announcements.
  - Rejected and Archived views are non-sortable.
  - Todo details derive direct Sessions and Automations from existing project lists; no Todo join endpoint or Invocation join was added.
  - Global Session runtime events invalidate the project Session list for cross-window updates.
- 2026-07-27: Corrected implementation details found during first-principles review:
  - Lanes are droppable containers rather than sortable pseudo-items.
  - Removed the fixed board minimum width; the board is one, two, or four columns by viewport size.
  - Session detail exposes the Protocol-owned `projectTodo` contract directly, removing a Web-side type cast.
  - Ready `Continue Work` now updates the Todo to In Progress before navigation.
  - Added separate `Continue Discussion` and `New Discussion` actions so continuing never substitutes for creating another Discussion.
  - Corrected same-lane downward ordering, so `beforeTodoId` is computed from the final board rather than an adjusted source index.
  - Session bootstrap prompts now use the Todo revision returned by the state mutation.
  - Drag announcements identify the Todo title, destination lane, and final position rather than exposing internal IDs.
  - `automation_create` now explicitly allows Todo work/automation setup Sessions while continuing to reject Todo Discussions.
  - Removed legacy-compatibility assertions instead of preserving tombstone tests.
- 2026-07-27: Updated current architecture documentation and removed current-production references to Activation, singleton resource ownership, return-to-ready, old Todo routes, and resource-bound deletion.
- 2026-07-27: Validation passed after the final product-action correction:
  - `bun run typecheck`: 5/5 workspaces.
  - `bun run test`: 8/8 tasks; Agent Core unit 2675/2675, integration 126/126, architecture 78/78, Server 247/247, and the complete Web/Protocol/Utils suites.
  - `bun run build`: TypeScript, Vite Web build, generated production entrypoint, and compiled production build all passed.
  - Focused Web Todo presentation tests: 6/6.
  - Real drag interaction tests: 5/5, covering KeyboardSensor, PointerSensor, and TouchSensor through DOM events, including cancellation and rejected persistence.
  - Complete Web interaction suite: 101/101.
  - `git diff --check`: passed.
- 2026-07-27: Completed production-build browser QA against an isolated temporary ArchCode home and project:
  - At 1440px the board rendered four columns with no horizontal overflow; at 390px and 320px it rendered one column with no horizontal overflow.
  - Pointer cross-lane drag, same-lane reorder, keyboard cross-lane drop, and keyboard Escape cancellation succeeded.
  - A 390px touch-sized viewport browser drag succeeded; the implementation registers a dedicated `TouchSensor`, but no physical touch device was used.
  - UI Start Work created a backend-generated Session and moved Ready to In Progress.
  - One Todo successfully exposed multiple distinct Work and Discussion Sessions; Continue Discussion opened the newest Discussion.
  - Ready Continue Work moved the Todo to In Progress before opening the existing Work Session.
  - Rejected and Archived views exposed no drag handles.
  - A second browser tab observed a newly created Todo Discussion through SSE invalidation without reload.
  - Both browser tabs had zero console errors.
- 2026-07-27: Completed the remaining linked-Automation browser acceptance case:
  - The Todo drawer listed its directly related `Linked QA automation`.
  - Clicking the relation opened `/projects/project/automations/a1111111-1111-4111-8111-111111111111`.
  - The detail page rendered the expected schedule, action, message, and source Session with zero console errors.
- 2026-07-27: Independent `sol(xhigh)` final review returned DONE:
  - All acceptance criteria passed.
  - No blocker, high, or medium findings remained.
  - The reviewer independently reran the dedicated drag interaction suite: 5/5.
- 2026-07-27: An interrupted security test left an ignored test fixture containing a root symlink, which caused broad filesystem traversal during validation. The two exact generated fixture directories were moved to `/private/tmp`; no user data or repository source was removed, and clean validation then passed.

## Current Risks

- Todo status, Session creation, and first-message acceptance intentionally remain separate durable writes. The accepted failure states are an In Progress Todo without a new Session, or a directly related empty Session.
- Todo Session creation intentionally has no client-visible creation idempotency key. The ordinary Session message path retains only its existing internal request identity.
- Old Todo runtime data is intentionally unsupported and will not be migrated, read through a fallback, or modified by this implementation.
- Browser QA verified the touch interaction at a touch-sized viewport through browser input automation, not on physical touch hardware.
