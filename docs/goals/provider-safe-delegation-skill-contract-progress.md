# Provider-safe contextual delegation and Skill contract progress

Status: complete
Started: 2026-08-10
Completed: 2026-08-10
Plan: `docs/goals/provider-safe-delegation-skill-contract-plan-goal.md`

## Execution log

### 2026-08-10 — baseline and decomposition

- Confirmed execution is isolated in Worktree `/Users/bo/.codex/worktrees/system-qa/archcode` on `codex/system-qa` at `4b2be9b8`.
- Preserved the accepted Plan Goal as the normative scope; progress and evidence are recorded only in this file.
- Confirmed the only pre-existing Worktree change is the untracked Plan Goal document.
- Reconfirmed the live blocker: internal Skill-name regexes are projected into Provider JSON Schema, while delegation capability and target Skill discovery are not projected from one contextual authority.
- Locked implementation boundaries: no full Skill enum, no persisted projection/catalog state, no fallback schema, no legacy compatibility, no tombstone tests, and no new Skill lifecycle.
- Started three independent codebase investigations: Agent capability/model projection, target-aware `skill_list` recovery context, and stable delegation error mapping/test seams.
- Reproduced the Provider boundary from the current source: both `delegate.skills.items` and `skill_read.name` serialize the negative-lookaround Skill regex.

## Decisions and corrections

- First-principles correction: `factoryResolveAllowedTools` currently hides delegation at the global depth `3`, while Discussion, Analyst, and Build declare `childPolicy.maxDepth = 2`. The model projection and runtime admission can therefore disagree at depth 2. The accepted exact-capability criterion requires replacing the global filter with each Agent definition's own child policy; the old global behavior will not be retained.
- Recovery-safe target discovery will execute through the global `skill_list` descriptor and a capability resolver reconstructed in `ToolExecutionContext`; model-call descriptor clones will contain presentation only.
- Known child-admission exceptions will be translated narrowly at the `delegate` Tool boundary. Generic `TOOL_DELEGATE_FAILED` remains only for genuinely unclassified failures.

## Verification evidence

- Internal/Provider boundary reproduction before the fix:
  - `delegate.skills.items.pattern = ^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$`
  - `skill_read.name.pattern = ^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$`
- Parallel implementation completed:
  - Factory capability authority and model-call-local `delegate`/`skill_list` presentation.
  - Recovery-safe target Skill resolver in every reconstructed `ToolExecutionContext`.
  - Strict internal schemas plus regex-free Provider schemas.
  - Stable delegate admission error mapping.
  - Fresh and resumed child admission migrated to the same capability snapshot.
- `packages/agent-core` typecheck passed after integration.
- Focused Session Agent/Execution tests passed: 119 tests, zero failures.
- Skill, scheduler, Tool contract, Factory, ConfiguredAgent, and delegation focused tests passed in their scoped runs. A combined first run exposed only sandbox-denied fixture writes plus two stale depth-error expectations; the fixture tests passed when rerun with Worktree write access, and the expectations were updated to the new capability-level rejection.
- Repository `bun run typecheck` passed: 5/5 packages, zero failures.
- Repository `bun run test` passed with exit code 0: 8/8 Turbo tasks, including Agent Core unit, integration, and architecture lanes.
- Production `bun run build` passed with exit code 0 after its required typecheck, Vite build, generated embedded-asset entrypoint, and binary compilation pipeline.
- `git diff --check` passed, and source search confirms the removed `MAX_SUB_AGENT_DEPTH` and `getDelegateTargetsFor` contracts have no remaining references.

### 2026-08-10 — real default-model browser acceptance

- Built and launched the isolated QA Worktree production binary on `127.0.0.1:4196` with the configured default `principal` model, `local:gpt-5.6-luna`; no alternate Provider or model was substituted.
- Temporarily isolated the global project index because unrelated registered projects contain pre-hard-cut Session records that the current strict schema rejects. The original index was restored byte-for-file after QA; the QA-only index was retained as `/Users/bo/.archcode/projects/index.provider-safe-qa-20260810.json`. The old QA fixture runtime was moved, not deleted, to `.archcode/runtime.pre-provider-safe-qa-20260810`.
- Used the real in-app browser against the rebuilt product and completed all required lanes:
  - Discussion / Generate Plan: Session `cba19064-00c1-4c7b-9540-344e5a9ee73d` reached `completed`, wrote the ordinary Plan, and displayed a nonempty final response.
  - Todo Ready / Start Work: Session `3dd6ec36-2158-40a7-a522-f523b2e2f99d` reached `completed`, executed `bun test` through the Agent, displayed `1 pass, 0 fail`, and returned a nonempty final response.
  - Direct Session: Session `16c16944-f185-4222-81ce-591c132a7ddb` reached `completed`, displayed finalized `file_read / README.md / Completed`, and returned the exact heading plus a nonempty summary.
  - Manual Automation: invocation `cad41c98-907b-4e69-82bb-517c7432d0cc` is exactly `dispatched`, links to Session `48ee77b2-71f8-4d9b-992f-b4b4f2694c13`, and that Session reached `completed` with finalized `file_read` work and a nonempty final response.
- Persisted records for all four latest Executions are exactly `completed` with `error = null`; final-answer text lengths are 567, 790, 153, and 57 characters respectively.
- Browser console errors were zero before restart and zero after restart.
- Performed a full graceful service shutdown and production-binary restart. After reload, all four Sessions remained `Completed`; the Automation remained paused with its latest invocation `Dispatched`, and the invocation-to-Session link remained visible and usable.
- The configured Provider accepted every real Tool schema; no `Invalid JSON schema`, lookaround rejection, or Tool Schema finalization error occurred.

### 2026-08-10 — independent review and fix-review loop

- An independent `gpt-5.6-sol` reviewer at maximum reasoning reviewed the complete Plan Goal, progress evidence, active architecture contract, production diff, tests, and browser evidence.
- First review found and fixed:
  - Existing child/resume Profile admission still read `AgentDefinition.profiles`; that second authority was deleted, and recovery now validates target, Profile, and Skills from the same parent/depth capability snapshot before activation side effects.
  - The global Registry contract test still treated the unprojected static `delegate` schema as contextual truth; contextual target/Profile assertions now live only in Factory/ConfiguredAgent/model-projection tests.
  - The now-unreachable `DelegationToolNotAllowedError` mapping and test were hard-deleted rather than retained as a legacy branch or tombstone.
- Second review found and fixed:
  - AC-05 now uses one shared `SkillService` and one concurrent `Promise.all` to prove two projects isolate both Prompt catalogs and `skill_list` pages.
  - Internal/global delegation descriptions no longer copy the target-to-Profile authorization matrix; exact mapping exists only in the contextual capability projection.
- Third review found only one stale `aiInputSchema` comment; it now documents the hard-cut portable model-schema versus strict internal-schema boundary for both builtin and MCP tools.
- Final independent verdict: `PASS`, with no blocking or material finding. The reviewer independently passed 240 focused tests, the full 8/8 repository test graph, production build, and `git diff --check` on the final diff.
- Primary-agent post-review gates also passed: 168 combined delegation/Skill/recovery tests, cold-cache repository typecheck 5/5, repository test 8/8 with exit code 0, production build with exit code 0, and `git diff --check`.

## Residual risks

- Recovery, target-only Skill read isolation, and zero-child-artifact rejection are closed by automated tests and the independent review.
- Out-of-scope baseline finding: one registered project containing an incompatible pre-hard-cut Session currently aborts startup for the entire multi-project Runtime. This Goal does not add a migration, fallback, or compatibility branch; a separate product decision is needed if per-project quarantine is preferred over the current fail-fast behavior.
- The real browser gate exercised default-model Tool schema acceptance through all four required product entry paths, while the exact custom-Skill `skill_list → delegate` chain remains covered by automated capability, recovery, and admission tests rather than a dedicated browser run.
