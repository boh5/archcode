# Conversation-Driven Goal and Automation Creation Progress

## Status

- Started: 2026-07-13
- Current phase: complete
- Goal: `docs/goals/conversation-driven-goal-automation-creation-goal.md`

## Acceptance Matrix

| AC | Status | Evidence |
|---|---|---|
| AC-01 Provenance and source identity | Verified | Required immutable provenance, same-project ordinary root Engineer validation, weak-reference deletion coverage |
| AC-02 Conversation and creation Skills | Verified | Two reserved built-ins, Engineer allowlist, suggestion/confirmation negative contracts |
| AC-03 Remove Goal Draft and initial Run | Verified | Schema/runtime/routes/Web hard cut; architecture audit rejects removed surfaces |
| AC-04 Cohesive recoverable Goal creation | Verified | GoalRunner sole owner, stable IDs, crash-window and recovery coverage |
| AC-05 Narrow Automation creation | Verified | Engineer-only `automation_create`, schema v2 provenance, existing scheduler/state path, POST create removal |
| AC-06 Session-driven create entry points | Verified | Both real browser paths entered ordinary Sessions through `/messages` and deterministically loaded the creation Skill |
| AC-07 Related work and navigation | Verified | Browser-verified `Created here`, resource links, and `Created from`; interaction coverage includes keyboard links and execution/source separation |
| AC-08 Hard cut, verification, final review | Verified | Full commands and browser paths pass; independent Reviewer returned `DONE` with AC-01–AC-08 all verified |

## Log

### 2026-07-13 — Kickoff

- Confirmed the worktree starts on `main` with only the Goal document untracked.
- Started parallel audits for Goal runtime, Automation/Skill boundaries, and Web UX.
- Initial inventory confirms the old Goal Draft/Run routes and UI create dialogs remain and must be removed rather than adapted.
- Found and corrected a contract hole: project/user Skills currently shadow builtins, so the two creation Skill names must be reserved to prevent bypassing their confirmation contract.

### 2026-07-13 — Implementation slices

- Automation state hard-cut to schema v2 with immutable required provenance; added only the Engineer `automation_create` tool and removed the direct POST create route.
- Added the two reserved built-in creation Skills and the Engineer suggestion/confirmation contract, including negative prompt contract tests.
- Web create entry points now open ordinary Engineer Sessions and send the existing `/skill use` message; create dialogs/mutations were deleted and Automation editing is edit-only.
- Session Context derives related Goal/Automation resources from authoritative lists; detail pages link back to the source Session or render `Unavailable` after deletion.
- Goal StateManager/Runner hard-cut is in progress with committed-running creation, stable Goal Lead identity, and restart recovery tests.
- Protocol and Web typechecks are green at this checkpoint; focused Web Goal detail tests are 14/14 green.

### 2026-07-13 — Architecture review corrections

- Browser verification corrected an earlier static-review mistake in AC-06: `/skill use` must enter through ordinary Session message execution. Query Loop `maybeHandleCommand()` validates the Skill and replaces the literal command with a deterministic first-`skill_read` continuation; the HTTP command endpoint only dispatches to an already-active Agent and returned 404 for a newly created idle Session.
- All Goal/Automation creation entry points therefore use `usePostMessage({ content: "/skill use ..." })`; a hard-cut source audit rejects the inactive command-endpoint path.
- Removed the remaining Draft/manual-start contract from the prompt-injected `AGENTS.md` and the current multi-agent architecture document.
- Added direct Goal evidence that deleting the source Session preserves the committed Goal, its provenance, and its independent Goal Lead Session.
- Deleted the residual Web `CreateAutomationPayload`; the retained edit-only dialog now uses an explicitly update-only payload contract.
- Isolated Worktree tests with per-module temporary repositories, moved `view_tool_output` tests off the real user cache through an explicit execution dependency, and serialized agent-core tests because their documented LLM/LSP adapters are process-global seams. This removes cross-file races without production retries, skipped tests, or relaxed timeouts.

### 2026-07-13 — Browser acceptance

- In an isolated HOME and Git project, the Goals list `New Goal` entry created an ordinary Engineer Session and posted `/skill use goal-create`; Query Loop forced `skill_read goal-create`, the Agent collected the objective, presented the final acceptance summary, waited for a later explicit confirmation, then created and activated the Goal.
- The source Session Context immediately showed the Goal under `Related work` / `Created here`; the row opened the Goal detail, whose `Created from` link returned to the exact source Session. The Goal had a distinct stable Goal Lead execution Session and continued independently into normal HITL blocking.
- The Automations list `New Automation` entry followed the same ordinary-Session flow with `automation-create`; after summary and confirmation it created an active interval Automation through `automation_create`.
- The source Session Context showed the active Automation and `nextFireAt`; the row opened Automation detail and its `Created from` link returned to the exact source Session.
- The isolated dev server was stopped and all browser tabs were finalized after visual inspection.

## Verification

- `bun run typecheck`: pass, 5/5 workspaces.
- `bun run test`: pass, 8/8 tasks; agent-core 3085 pass / 0 fail.
- `bun run build`: pass; Web build, 308-asset manifest, and compiled binary completed.
- Goal and Automation browser creation paths: pass in isolated runtime.
- `git diff --check`: pass.
- Final AC-by-AC Reviewer audit: `DONE`; no blocking findings, AC-01 through AC-08 all verified, and architecture assessed as cohesive without extra creation state machines or compatibility layers.
