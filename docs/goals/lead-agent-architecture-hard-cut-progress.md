# Lead Agent Architecture Hard-Cut Progress

本文件只记录 `lead-agent-architecture-hard-cut-plan-goal.md` 的执行进度、验证证据和审查修复，不修改 Goal/验收定义。

## Current Status

- Goal: complete
- Phase: complete
- Started: 2026-07-21
- Compatibility policy: hard cut; no migration, alias, fallback, dual read, or dual write

## Workstreams

- [x] Profile config/model resolution and five-Agent catalog
- [x] Agent permissions, Skills, and bounded delegation
- [x] Plan file guard and Todo Discussion Lead
- [x] Goal authorization, continuation, and Analyst final-review gate
- [x] Protocol/server/web hard cut and observable surfaces
- [x] Typecheck, tests, build, and real browser acceptance
- [x] Independent review -> fix -> fresh review

## Progress Log

- Reviewed and repaired the architecture Draft and Plan Goal before implementation.
- Confirmed the final delegation topology preserves existing depth: Lead -> Analyst/Build/Explore/Librarian; Analyst -> Explore/Librarian; Build -> Explore; Discussion -> Explore/Librarian.
- Began repository implementation from the current worktree; the two approved design documents were initially untracked.

### Protocol / Server / Web surfaces — 2026-07-21

- Hard-cut Protocol model routing from `agent_default` / `agentDefaults` to `profile_default` / `profileDefaults`, with strict `principal|deep|fast` config Profiles.
- Replaced user-facing Agent catalog metadata with `lead|analyst|build|explore|librarian`; Server root-session creation now requests `lead` and model-selection APIs accept only the Profile-default mode or a Session override.
- Replaced Settings’ per-Agent model bindings with a Profiles editor. Root Lead Composer exposes the principal-profile reset and model override picker; it has no primary-Agent selector or Visual entry point.
- Added child-session observability to the shared contract and UI: immutable child Profile and Skills, status/depth, hierarchy inspector metadata, and existing HITL source presentation remain visible. Todo discussion copy now names Lead while retaining the Discussion product surface.
- No agent-core execution behavior was edited by this workstream. The required persistence producers are `Session.profile` and `ToolChildSessionLink.childProfile` / `childSkillNames`.

### Core hard cut and execution contracts — 2026-07-21

- Replaced the seven-Agent catalog with exactly `lead|analyst|build|explore|librarian`; removed the Engineer, Plan, Reviewer, and Shaper definitions and all production aliases/fallbacks.
- Replaced per-Agent model defaults with strict `principal|deep|fast` Profile bindings. Root Lead uses `principal`, Analyst uses `deep`, Explore/Librarian use `fast`, and Build accepts `deep|fast`; root Session override remains an Execution-level replacement.
- Replaced delegation with the strict six-field Agent + Profile + Skills contract and deleted owned scope, Build ownership lease, path overlap admission, and their compatibility paths. The existing shallow re-delegation topology and general concurrency limit remain authoritative.
- Moved lifecycle methods into the six core workflow Skills. Ordinary Lead, active Goal Lead, and Todo Discussion Lead derive `orchestrate-work`, `run-goal`, and `shape-todo` from existing runtime facts instead of a workflow state.
- Added the narrow `.archcode/plans/*.md` protected-path exception for non-Discussion root Lead structured file tools; no Plan domain, state, API, or Goal link was introduced.
- Replaced Shaper Discussion with a Todo-bound restricted root Lead, preserving investigation, `ask_user`, Memory, guarded Bash, Todo update, and Explore/Librarian child capabilities. Ready creates a fresh ordinary Lead Session.
- Hard-cut `create_goal` to exact `{ objective }` authorization from a fresh explicit persistent user request or the current resumed `ask_user` confirmation. Replaced Reviewer completion with runtime-bound fresh direct `analyst + deep + goal-review` provenance and artifact-freshness checks.
- Added child identity consistency at both durable schema and execution admission: `activeSkillNames` must remain the canonical deduplicated Skills from the immutable delegation request.
- Kept Goal artifact-write detection as a consumer of the existing generic Bash analysis fact instead of adding a second parser or a new review state.

### Independent review repairs — 2026-07-21

- Closed child model-selection bypasses: only a root Lead may set or clear a durable Session model override. Child and non-Lead Sessions fail closed at both service and persisted-schema boundaries; Todo Discussion remains a root Lead and follows the same documented override contract.
- Tightened Goal creation authorization: negated, ambiguous, or refusal text cannot authorize a Goal, and the `ask_user` route accepts only the stable start action from the exact current resumed confirmation template.
- Made Goal completion atomic against instance/generation replacement and retained the narrow fresh direct `analyst + deep + goal-review` provenance check without adding Review workflow state.
- Removed Goal execution instructions from non-active overlays; the runtime overlay now carries facts only and `run-goal` is the sole workflow method.
- Corrected Discussion Lead delegation depth to two while preserving Analyst/Build re-delegation and terminal Explore/Librarian behavior.
- Removed the last legacy Engineer and owned-scope references from the tool-contract and `resume_session` surfaces; the measurement script now targets Lead's exact 34-tool surface.
- Added exact ordered tool-matrix tests for all five Agents and three full-runtime acceptance flows: ordinary Lead multi-child aggregation, Todo Discussion -> Ready -> fresh Lead, and Goal authorization -> Build -> changes requested -> remediation -> fresh approval -> completion.
- Full-runtime tests exposed and fixed two integration defects missed by unit tests: asynchronous Todo Discussion lookup was not awaited, and Goal review freshness treated usage telemetry as a semantic Goal update. No new mode, review state, or compatibility path was introduced.

### Fresh-review repairs — 2026-07-21

- Made successful Goal completion an Execution terminal boundary. The durable tool-batch record marks the boundary, rejects later calls in the same batch, archives recovery state, and stops the query loop before another model call can perform work after completion.
- Tightened direct Goal authorization so interrogative requests cannot be treated as imperative authorization. A successful `create_goal` consumes the current `ask_user` confirmation route, while localized three-option labels remain valid because runtime verifies stable structure and the selected first option rather than hard-coded English or Chinese copy.
- Aligned root Lead model overrides with the accepted product contract: ordinary and Todo Discussion root Leads may select or clear an override; delegated children cannot.
- Strengthened the Goal full-runtime flow so the first Build performs a real write and remediation performs a real read-before-edit, with the final file content asserted after fresh approval and completion.
- Real HTTP browser QA exposed `crypto.randomUUID()` being unavailable outside secure contexts. Web request/message correlation now uses a shared UUID v4 helper backed by `crypto.getRandomValues()` when needed, preserving normal self-hosted LAN access without adding a compatibility mode.

### Documentation and hard-cut audit — 2026-07-21

- Updated the current README, configuration guide, multi-Agent design, Web architecture, and repository Agent instructions to the five-Agent/Profile/Skill architecture.
- Production-source searches find no removed Agent identity, per-Agent config, owned-scope/lease, Plan runtime field, review generation, or Visual runtime registration. Generic prose such as “implementation plan” and the `plan-work` Skill remain intentionally valid.

### Goal completion audit repairs — 2026-07-21

- Replaced model-authored Goal confirmation choices with the `ask_user` `goal_authorization` preset. Runtime now owns the start/decline/adjust actions, rejects supplied options, and accepts only the exact start response from the current resumed Execution.
- Added execution-manager proof that two legal Build children can simultaneously hold `running` links under the ordinary concurrency policy; no Build-specific lease, scope, or scheduler was added.
- Corrected the Draft so seven-Agent language is explicitly historical and the five-Agent hard cut is the current implementation.
- Removed a flaky integration-test assumption that independently drained stdout/stderr pipes have deterministic cross-stream preview order. Runtime behavior is unchanged; the test still proves complete mixed-stream artifact recovery, search, paging, persistence, and child-process reopen.

## Validation Evidence

- `bun run typecheck` — pass, 5/5 workspaces.
- `bun run test` — pass, 8/8 tasks, including Agent Core unit/integration/architecture lanes and the Web interaction suite.
- `bun run build` — pass; Web production build and 308-asset manifest generation completed. Vite reports only the existing large-chunk advisory.
- `bun run tool-contract:measure` — pass; Lead exposes exactly 34 measured tools.
- `git diff --check` — pass.
- Real browser acceptance passed against an isolated temporary HOME/config, clean temporary project, local fake model provider, and the actual Server + Vite UI over its LAN URL. Profile save survived refresh; ordinary and Todo Discussion root Lead overrides could be selected, cleared, and verified after refresh; Todo Discussion -> Ready opened a fresh ordinary Lead Session; a real Lead execution delegated a `deep` Analyst with `analyze-work`, and Agent/Profile/Skills/status plus the child transcript remained visible after refresh. A clean browser tab ended with zero console errors and zero warnings.
- Browser QA found and repaired the non-secure-context UUID failure described above, then reran the affected real message/delegation path successfully.
- Final post-repair run: `bun run typecheck`, `bun run test`, `bun run build`, `bun run tool-contract:measure`, and `git diff --check` all exited zero. The root test graph passed 8/8 tasks; Agent Core passed 2,610 unit, 132 integration, and 93 architecture tests. Production-source hard-cut searches returned no removed Agent ID/config/scope/Review/Plan runtime or Visual registration.

## Review Findings

- Self-review fixed a persisted child-identity drift: a different but otherwise legal Skill set could previously replace the original delegated Skills before resume. Session schema and execution admission now reject the mismatch, with focused regression tests.
- Self-review removed a direct Goal-provenance dependency on the Bash parser by exposing one generic mutation-analysis fact from the existing security owner; the single-analysis-consumer architecture test passes.
- The first independent review returned seven findings. All six code/architecture findings were repaired and covered by focused or full-runtime regressions; its browser evidence gap is now closed by the real Browser run above.
- The second independent review returned six findings: post-completion execution, question-shaped Goal authorization and confirmation replay, Discussion override policy drift, localization overfitting, non-mutating Build fixtures, and incomplete browser evidence. All six were repaired and revalidated.
- The next independent review caught one stale API test assertion plus non-rejection legacy Agent vocabulary in tests. The assertion now matches the root Lead contract, and legacy test references remain only in strict rejection fixtures. Targeted and full repository validation passed afterward.
- The Goal completion audit found three final gaps: model-authored Goal action semantics, missing simultaneous-Build evidence, and stale current-state wording in the Draft. All three were repaired; three subsequent fresh independent reviews, including one after the test-contract correction, returned `VERDICT: APPROVED` with no blocking findings.
- Final fresh independent review: `VERDICT: APPROVED`, with no open findings. AC-01 through AC-08 are complete.
