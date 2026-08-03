# Project Workbench UI Hard-Cut Progress

## Status

- State: `complete`
- Branch: `codex/project-workbench-ui-hard-cut`
- Base: `9679bfc5`
- Goal: [`project-workbench-ui-hard-cut-plan-goal.md`](project-workbench-ui-hard-cut-plan-goal.md)
- Started: 2026-08-03

## Locked Execution Constraints

- Hard-cut to Home + ProjectToolbar + Todos/Automations/Sessions; no legacy UI, compatibility reader, fallback, migration, feature flag, API alias, or tombstone test.
- Historical project `.archcode/runtime/` deletion, including Session, Todo state, Automation and linked runtime records, remains the user's responsibility.
- Plan remains ordinary Markdown; Session remains the full execution workbench and a direct entry.
- Prefer page-owned projections and narrow commands; no generic Work/Task/state/filter/transaction framework.

## Workstreams

| Workstream | Status | Evidence |
|---|---|---|
| Design specs and prototype | completed | Master, Todos and Automations contracts synchronized; Automation prototype updated |
| Protocol and persistence hard-cut | completed | Required root `source` and immutable Automation `origin`; old source fields deleted |
| Run now, Plan, inventories, Home/Search | completed | Narrow composed command, fixed-path bounded Plan read, batched inventories, stateless global reads |
| Router and workbench shell | completed | Nested ProjectLayout/Toolbar; Dashboard and production Sidebar removed |
| Todos, Automations and Sessions UI | completed | Production routes, filters, direct creation, detail/deep-link flows and responsive layouts |
| Automated and browser verification | completed | Full command suite and two real-Server browser passes green |
| Independent final review | completed | `sol(max)` read-only review concluded Clean after the fix/review loop |

## Execution Log

### 2026-08-03

- Created and switched to `codex/project-workbench-ui-hard-cut` from `9679bfc5`.
- Used bounded parallel agents for domain mapping, architecture feasibility, product/UX review, fixture cleanup, and browser QA.
- Hard-cut Session persistence/API to `direct | todo | automation` source. Root identity is required and child identity is forbidden; all creation paths now write a source.
- Hard-cut Automation persistence/API to `direct | session | todo` origin. Server owns direct origin, tools derive origin from their root Session, updates cannot change it, and `start_session` persists Automation/Invocation identity.
- Implemented Todo `Run now` as one application command with project-local in-flight deduplication, durable success receipts, stable request hashing, and directed compensation. A durably accepted first message is never deleted because a later wake-up fails.
- Added fixed `.archcode/plans/<todo-id>.md` read with Todo existence check, symlink/realpath containment, regular-file validation, and a 1 MiB bound; no Plan service or edit API was added.
- Added one-read Session/Automation inventories. Home and Search collect projects in parallel, isolate project failures, and return page-specific DTOs; no persistent index or shared `WorkItem` classifier was introduced.
- Replaced Dashboard/Sidebar layout with global Home plus project-level `Todos / Automations / Sessions`. Direct Sessions remain first-class; Session detail retains Workstream, Composer, HITL, Goal, Agents, Changes, Context and Inspector.
- Implemented complete Todos capture/detail/Plan flows, Automation list/detail/create/edit flows, Sessions inventory/direct-create flow, stable source breadcrumbs, one global search, and theme-aware Project Rail.
- First-principles corrections made during implementation:
  - kept list aggregation server-side to avoid browser N+1 reads;
  - moved durable-message lookup into `SessionInputService`, its existing lifecycle owner;
  - treated accepted-message wake-up failure as recoverable accepted work rather than rollback authority;
  - removed permanent-black rail styling and used semantic light/dark tokens;
  - kept filters page-owned instead of introducing a generic entity-filter framework.
- Independent review found no remaining actionable defect after the final fix/review loop. It confirmed AC-01 through AC-09, the hard-cut deletion boundary, Run now recovery semantics, Home/Search projections, source deep links, and the absence of an added compatibility layer or unnecessary framework.

## Acceptance Evidence

| AC | Result | Evidence |
|---|---|---|
| AC-01 | pass | Strict Session source and Automation origin schemas, creation paths, dispatch/send-message behavior, fixture conversion, and production-source scans |
| AC-02 | pass | Nested router/ProjectToolbar tests; Dashboard, Sidebar, resize/drawer/toggle production owners deleted; Session Inspector behavior retained |
| AC-03 | pass | `/api/home` and `/api/search` Server tests cover grouping, body matching, query bounds, 100 cap and project failure isolation; one Rail search dialog with stable links |
| AC-04 | pass | Run-now service/route tests cover success, sequential/concurrent replay, key conflict, durable acceptance, compensation and typed partial recovery; Todo Plan and lifecycle interactions pass |
| AC-05 | pass | Batched Automation inventory, direct create, immutable origin, unique Invocation Session, filters, list/detail/back focus, structured dialog and unsaved-close protection pass |
| AC-06 | pass | Complete root-only Session inventory, mutually exclusive grouping, filters, source selector, Direct creation and three source breadcrumbs pass |
| AC-07 | pass | Semantic rail theme tests, accessible controls/dialogs, coarse-pointer rules, reduced-motion contract and responsive browser checks pass |
| AC-08 | pass | Source scans find no old Dashboard/source contracts, production Sidebar, compatibility/fallback/migration/tombstone additions, or duplicate global search |
| AC-09 | pass | Automated suite, production build, diff check and real-Server browser matrix are green; detailed evidence below |

## Verification Evidence

### Automated

- `bun run typecheck`: 5/5 packages passed.
- `bun run test`: 8/8 Turbo tasks passed.
  - Agent Core unit: 2809 pass, 0 fail, 12023 assertions.
  - Agent Core integration: 140 pass, 0 fail, 605 assertions.
  - Agent Core architecture: 79 pass, 0 fail, 237 assertions.
  - Server: 266 pass, 0 fail, 733 assertions.
  - Web unit: 581 pass, 0 fail, 2198 assertions.
  - Web interaction: 94 pass, 0 fail, 514 assertions.
- `bun run web:build`: passed.
- `git diff --check`: passed.
- Production-source scans for removed Dashboard/source names and fallback/legacy/deprecated/tombstone additions: clean. The only remaining `Sidebar` name is the independent Settings dialog's internal `SettingsSidebar`.

### Real Server + Browser

- Used a temporary isolated registered project and real Hono/React build; the temporary launcher and runtime were removed after QA.
- Verified Save creates only an Idea Todo; Run now creates the In Progress Todo, its Todo/work Session and accepted first message, then opens the exact Session.
- Verified a Direct Session can be created from Sessions and reopened as Direct without a Todo.
- Verified Todo Markdown/Plan display and Todo, Discussion, work Session and Automation stable links.
- Verified direct Automation form creation, fixed `Lead + principal` disclosure, Automation detail/origin, Run now Invocation and exact Automation-source Session deep link.
- Verified global Search returns production Project/Todo/Session/Automation data and opens exact stable URLs.
- Verified Home `Needs you` opens exact root Session and HITL (`article[data-testid="hitl-decision-card"]`).
- Verified Automation filter is preserved across detail and UI Back; the selected row is active and receives restored focus.
- Verified Project Rail computed colors: light `rgb(236, 238, 234)`, dark `rgb(12, 14, 12)`; restored light theme.
- At 390x844, Home, Automation workspace and HITL Session had `scrollWidth === clientWidth === 390`; the broader first pass also exercised the locked desktop/tablet breakpoints and the three Session source routes.
- Browser console warnings/errors: none.

## Final Review

- Reviewer: independent `gpt-5.6-sol` at `max` reasoning, read-only.
- Result: `Clean`; no new actionable finding and no reopened fixed issue.
- Rechecked directly by the reviewer: acceptance-contract consistency, hard-cut source/origin semantics, Run now recovery, Home/Search batching, Session/Automation deep links, `git diff --check`, and monorepo typecheck.

## Post-completion Refinements

### 2026-08-03 — Todo execution actions and operational state

- Made Todo execution entry unambiguous: `Start Work` appears only before the
  first linked Work Session; afterward the drawer shows primary `Continue Work`
  plus secondary `New Work Session`.
- Added one page-local operational projection to In Progress cards without a
  new Todo status, persistence field, API, migration, fallback, or workflow
  framework. Existing Session inventory, runtime activity, HITL, Goal,
  Execution and Automation facts derive `Needs you`, `Working`,
  `Needs attention`, `Ready to review`, `Scheduled`, or `Idle`.
- Gated the projection on authoritative inventory and realtime snapshots so a
  loading page never flashes a false `Idle`. New active or terminal work
  supersedes historical failure; unresolved user attention remains highest
  priority; Automation dispatch is never treated as completion.
- Verification: Web typecheck passed; Web unit suite passed with 589 tests and
  2211 assertions; Web interaction suite passed with 96 tests and 521
  assertions; production build and `git diff --check` passed. Real local-server
  browser QA confirmed the existing In Progress Todo renders `Ready to review`
  as a quiet secondary line while preserving the lifecycle label, with no
  browser warnings or errors.

## Residual Risks / Preconditions

- This intentionally rejects historical project runtime files. The user must delete the old project `.archcode/runtime/` data, including Session, Todo state, Automation and linked runtime records, before first launch; no migration, fallback, backup or cleanup code exists.
- Browser QA used an unreachable fake model endpoint, so it proves real persistence, routing, projections, source identity and UI interactions, but not a successful external model response. The execution/model path remains covered by Agent Core integration tests.
- Home/Search are bounded live scans by design. A persistent index is deliberately deferred until measured project scale justifies it.
