# ArchCode 最近工作问题综合修复 Progress

> 本文只记录 `runtime-state-compression-skill-contract-plan-goal.md` 的执行过程、验证证据和偏差。Goal/Plan 契约保持在原文，不在这里重写或修改。

## Baseline

- Started: 2026-09-04 (Asia/Shanghai)
- Implementation worktree: `/private/tmp/archcode-runtime-reliability-goal`
- Branch: `codex/runtime-reliability-goal`
- Base: `origin/main` at `e3be98a0138b2b2846db93f966ea56e7517f5e74`
- Source checkout observed: `codex/add-marketing-skills` at `2f96ee99151b2c54edfd2e9fdae087d07ad14208`
- Plan SHA-256: `3df5c1324306a8d4edc9006485ddeea91b34793d96904abed19e29e173b49e72`
- Isolation: implementation must not copy tracked changes from the source marketing branch.

## Execution Log

### Phase 0 — Baseline and decomposition

- Status: complete
- Fetched current `origin/main` and created the isolated worktree above.
- Confirmed the active Goal and copied the reviewed Plan Goal into the implementation worktree unchanged.
- UI advisory: `ui-ux-pro-max` suggested a generic purple AI-SaaS language that conflicts with ArchCode's authoritative design system. Only accessibility, disclosure, responsive, focus, and reduced-motion checks will be used; the existing visual language remains authoritative.
- Baseline `bun run typecheck`: passed (5/5 tasks; shared cache hits).
- Three read-only Luna(max) mappings completed for I-01/I-02/I-05, I-03/I-04, and I-06. They confirmed the Plan's intended owners and existing test seams.
- Rendered the current Session permission and Todos prototypes in real Chrome at 1440×1000; baseline screenshots are `/private/tmp/archcode-session-prototype-before.png` and `/private/tmp/archcode-todos-prototype-before.png`.
- Read the current `design-system/MASTER.md`, Session/Todos page contracts, and current effective prototypes. The active contracts still describe the old Todo display-lead and `In progress` navigation semantics, so UI work must update design docs/prototypes before product code.

### Phase 1 — Runtime and compression implementation

- Status: complete
- Work split:
  - Luna(max): Skill Tool descriptions/errors and Plan Prompt/template (I-02/I-05).
  - Sol(high): repeated deterministic failure termination and child final gate (I-03/I-04).
  - Luna(max): Compression protection/schema hard cut, excluding `ConfiguredAgent` integration (I-06 core).
- `ConfiguredAgent` lifecycle/current-context integration is intentionally serialized after the first wave because I-01 and I-06 share that owner.
- Compression core hard-cut is implemented: only `latest_tail`, `pending_tool`, `running_tool`, `unknown_result`, and `protect_tag` remain; settled child links, Todos, and Reminders no longer veto a legal range. The worker reported 239 focused tests passing, workspace typecheck passing, and `git diff --check` passing.
- Root Lead lifecycle/current-state integration is complete: only the lifecycle slot is recomputed per model boundary, while ordinary/explicit Skill package snapshots remain fixed for the logical Execution. Current Context now contains complete sorted Session Todos and latest direct-child-link facts as deterministic JSON. A second architecture pass hard-deleted an unnecessary Agent Tree snapshot from this path; complete descendant topology remains exclusively owned by `list_agents`. The main-agent rerun passed all 57 `ConfiguredAgent` tests, Agent Core typecheck, and `git diff --check`.
- Skill Tool / Plan Prompt changes are implemented: entry-first and cursor-safe examples, exact recovery hints, the split `TOOL_SKILL_RESOURCE_PATH_INVALID` code, Active-Skill already-loaded wording, and concise single-writer Plan guidance. The worker reported 49 focused plus 34 model-visible/contract tests passing, the 3,084-test agent-core unit lane passing, package typecheck passing, and `git diff --check` passing.
- `RepeatedFailureTracker` now rebuilds one logical Execution from canonical Tool batches, keys failures by Tool name + stable JSON input + the closed 14-code deterministic allowlist, clears a call's history after success, and stops only after the third real error and all siblings settle. Old `DoomTracker`, `TOOL_DOOM_LOOP`, and obsolete code aliases were deleted. A focused integrated lane passed 227 tests; a real Plan attempt also demonstrated the live gate by stopping a repeated invalid `skill_list` path before another model boundary.
- Delegated-child completion now passes through one pre-`execution-end` classifier. Missing/blank and whole-response protocol-only finals fail with the same stable code/message in the Execution, child link, synchronous delegate, background output, and reminder; no report is synthesized and a queued child is not started. The fixed ASCII/fullwidth DSML corpus and normal-report counterexamples pass.

### Phase 2 — UI and Todo presentation

- Status: complete
- Updated the authoritative Session/Todos page contracts before product code: paused Work and HITL are independent disclosures; Running is a derived live view distinct from lifecycle; Todo display lead is a finite Markdown-aware presentation rule.
- Updated the Todos prototype navigator to show `Running` after `Needs you` while retaining lifecycle `In progress`. Real Chrome desktop render confirms the groups are visually distinct.
- Implemented the canonical Todo display lead and hard-deleted caller-level fallback chains. It ignores fenced code, finite builtin structural labels/placeholders, and standalone HTTP(S) URLs; `Untitled Todo` is the only fallback. Focused tests pass (9/9) and Web typecheck passes.
- Implemented the Running projection and navigator target: exact `running | resuming | stopping`, stable latest target selection, Needs-you precedence, no Direct/rejected/archived/terminal entries, and no provisional group. Focused projection tests pass (7/7); component tests pass in their isolated test lane (3/3), and Web typecheck passes.
- Work/HITL product behavior is assigned to an independent Sol(high) worker because it owns disclosure persistence and scroll/focus semantics.
- Work/HITL implementation is complete: the latest HITL-paused Work defaults open without overriding a segment-level manual choice; Question/Permission cards own an independent per-`hitlId` disclosure; composer-height changes preserve historical reading and only keep an existing follow-latest view pinned. The Session prototype now mirrors the two-layer disclosure and multi-request state. Main-agent rerun of the complete Web lane passed: 713 isolated tests + 170 interaction tests, followed by Web `tsc --noEmit` (exit 0).
- Real Chrome interaction QA passed on the authoritative prototype at 1440×1000 and 390×844: Work/card toggles stay independent, the card is keyboard-operable with retained focus, Composer remains visible, request 1/2 and 2/2 navigate correctly, final response stays outside Work, Running and In progress remain distinct, the narrow drawer opens, reduced motion resolves to `0.01ms`, and no console error occurred. Screenshots: `/private/tmp/archcode-permission-desktop.png`, `/private/tmp/archcode-question-desktop.png`, `/private/tmp/archcode-todos-desktop.png`, `/private/tmp/archcode-todos-narrow.png`.
- Actual source Web UI was served at `127.0.0.1:5174` against the ready installed Runtime on `4096`. The real `/projects/archcode/todos` surface rendered with no React/console error. This exposed and then verified a final display-lead correction: inline Markdown markers and exact builtin field prefixes are removed while unmatched underscores remain; screenshot `/private/tmp/archcode-product-todos.png`. The current project has no authoritative live family, so product Running correctly hides; the live-state product component tests and prototype supply that state matrix without mutating user data.
- Follow-up review required a product-side Session/HITL browser gate in addition to the prototype. The actual Vite React product was rendered in Chrome with browser-level fetch/SSE fixtures only for the synthetic `qa-session`, its tree/diff, and its two HITL/runtime snapshots; the installed Runtime still supplied bootstrap, project, Agent, and current model catalog responses. At 1440×1000, paused Work and Permission 1/2 defaulted expanded, commentary and the enabled `Queue a message…` Composer were visible; collapsing Work left the card/Composer reachable, collapsing the card did not alter Work, and Space reopened the card with focus retained. The product card then navigated to Question 2/2. At 390×844, Work, Question, and Composer remained visible with no horizontal overflow. There were no React or browser-console errors. Evidence script: `/private/tmp/archcode-source-session-qa.ts`; screenshots: `/private/tmp/archcode-source-session-desktop-initial.png`, `/private/tmp/archcode-source-session-desktop-question.png`, and `/private/tmp/archcode-source-session-narrow.png`.

### Phase 3 — Integrated runtime and delivery gates

- Status: complete
- Current-config Plan fixture final accepted run: 9,579 Unicode characters, 9,595 UTF-8 bytes, one `file_write`, one writer, 4 model boundaries, 3 Tool calls, 0 Tool failures, 67,298 total tokens, and 141,523 ms wall time. All required content classes and I-01–I-08 mappings are present; there are no unresolved markers. Manual review confirmed the locked Work-collapse and standalone HTTP(S)-URL semantics and found no command outside the supplied repository command list.
- The fixture exposed three real test-design corrections before the accepted run: its first version hid the 12,000-character ceiling; its Work-collapse wording allowed an incorrect acceptance condition; and a closed fixture with no checkout asked for exact commands without supplying them. These were made explicit. Earlier over-budget results (18,246, 17,126, 14,763, 14,165, and 12,551 characters), a 9,372-character result with the wrong Work acceptance boundary, and a 10,140-character result that invented `test:e2e` were treated as failures, not averaged into a pass. The Prompt/template was tightened to a compact matrix, one fact per owner, pre-write allocation, and a last-action final write; the fixture supplies only real verification commands.
- Final integrated `bun run test` passed all Turbo tasks (8/8), including Web 713 isolated + 170 interaction, Agent Core 145 integration + 83 architecture, with zero failures. `bun run typecheck` passed 5/5 and `bun run build` exited 0. `git diff --check` passed.
- The first independent Sol(max) review found one AC-02 correctness gap: the ordinary `SkillService` null return for a missing/not-allowed Skill bypassed the exception-only recovery hint and inherited the generic file-not-found advice to create a file. All `TOOL_SKILL_NOT_FOUND` paths now share one Skill-owned result factory that instructs the model to restart `skill_list({})`, copy an exact current-Agent name, and never create or modify a read-only Skill. Three null-path assertions were added; the focused 29-test lane, Agent Core typecheck, full 8/8 Turbo test gate, build, and `git diff --check` all pass after the fix. The same reviewer verified and closed the correction during follow-up review.
- The follow-up Sol(max) review independently reran the actual React product Session/HITL QA without writes, verified that Vite loaded this worktree's `/src/main.tsx`, and confirmed that only synthetic Session/tree/diff plus runtime/HITL network state were mocked. It closed the AC-07/AC-10 evidence gap and returned `READY` with no remaining Blocking, High, or obvious correctness issue.
- The new compiled binary started and served embedded Web on port 4190. Its Runtime activation was intentionally not escalated after the sandbox denied a write to another registered project outside this worktree; the installed binary on 4096 remained `mode=ready`, `authenticated=true`, `runtime.state=ready`. Source Web runtime behavior was verified through that ready backend rather than running two writers against user data.

### Phase 4 — Post-completion incident replay QA

- Status: complete
- Replayed I-01 through I-09 as an incident matrix instead of accepting the earlier aggregate green run. Three independent QA agents covered Runtime/Skill/delegation, Plan/compression, and the actual React UI. No production defect recurred.
- The first Runtime QA pass found an evidence gap rather than a product failure: equivalent invalid Skill inputs were covered, but the original literal `resource: "/"`, cursor `":first"`, and `PLACEHOLDER` calls were not all executed by regression tests. Test-only cases now pass those exact values through the public schemas and real `skill_read` / `skill_list` execution boundaries, then assert the stable error code and copyable recovery hint. No production implementation changed.
- The same test-only closeout now exercises AC-03 literally: different deterministic A/B/C codes and inputs interleave until the third A stops before another model call; every excluded permission, timeout, cancel/abort, HTTP/network, generic, prepare-input, and old Skill-validation code remains fail-open; three `TOOL_SKILL_RESOURCE_PATH_INVALID` results stop exactly as intended.
- Focused Runtime evidence after the additions: Skill Tool incident replay 35/35; Query Loop plus error-code boundary 55/55; randomized five-file lane with `--seed=7` 93/93; child final/protocol gate, execution propagation, delegate, and background output 219/219 in the main-agent rerun.
- Focused Plan/compression evidence: compression lane 39/39; compression/store/Session projection 90/90; Protocol reducer/guards 93/93; `ConfiguredAgent` 57/57; builtin manifest 4/4. The accepted real current-config Plan fixture remains 9,579 Unicode characters and one final write; this QA pass did not spend another model-generation run.
- Focused Web evidence: Todo navigation/presentation 19/19; Work/HITL/Composer interaction 26/26; independent Web-focused lane 85/85 and complete interaction lane 170/170.
- Actual React/Vite Chrome 152 QA passed at 1440×1000 and 390×844. Work and HITL disclose independently, Composer remains reachable, Space reopens the card with focus retained, request navigation reaches Question 2/2, and narrow layout has no horizontal overflow or console error. The Todo fixture shows distinct `Needs you`, `Running`, and lifecycle `In progress`; mobile drawer mouse-open and Escape-close/focus restore pass; structural labels and standalone URLs do not become display leads.
- Final post-addition gate: `bunx turbo run test --force` passed 8/8 tasks with 0 cache hits; Server 316/316, Web interaction 170/170, Agent Core integration 145/145, and architecture 83/83 were visible in the run. `bun run build` passed, including 5/5 typechecks and production Web/binary compilation. `git diff --check` passed, the installed 4096 Runtime remained ready, and the frozen Plan SHA-256 remained unchanged.
- Evidence boundary: the synthetic Session/Todo fixtures supply rare simultaneous HITL and running-family states through browser-level fetch/SSE interception while rendering the actual worktree React application. Long-transcript scroll anchoring is covered by interaction tests because the short 390px browser fixture does not create a long scroll history.

## Acceptance Evidence

| AC | Status | Evidence |
| --- | --- | --- |
| AC-01 | complete | `ConfiguredAgent` boundary test proves only root Lead changes `orchestrate-work` → `run-goal`; static Skills and other Agents remain unchanged. |
| AC-02 | complete | Actual Tool projection and execution tests cover entry-first `skill_read`, first-page/target `skill_list`, literal incident inputs `/`, `:first`, and `PLACEHOLDER`, copied resources/cursors, stable codes, same-scope recovery, and normal missing/not-allowed null paths using the same `skill_list({})`/no-create hint as exception paths. |
| AC-03 | complete | Different-code A/B/C interleaving, success-clear, third-hit batch settlement, HITL/child resume rebuild, the complete excluded-code fail-open matrix, and three-hit `TOOL_SKILL_RESOURCE_PATH_INVALID` termination all pass through the real Query Loop boundary. |
| AC-04 | complete | Fixed corpus and propagation tests produce zero false Completed states for missing/blank/protocol-only finals while accepting normal/mixed reports and root Tool completion. |
| AC-05 | complete | Accepted current-config fixture: 9,579 Unicode characters, one final write, complete rubric, valid supplied commands only, and no Plan service/runtime limit/Provider branch. |
| AC-06 | complete | Dynamic-range test commits with settled links/Todos/Reminders, preserves canonical messages and owner state, blocks live mechanics, and projects deterministic Todos/direct children. |
| AC-07 | complete | Web interaction suite plus real Chrome prototype and actual React product desktop/narrow/keyboard/focus/multi-request evidence; Work/card collapse is independent, Composer stays reachable, and final response remains outside Work. |
| AC-08 | complete | Exact activity/exclusion/precedence/stable-target tests and desktop/narrow browser evidence; lifecycle remains unchanged and zero Running hides. |
| AC-09 | complete | Markdown-aware helper/shape-todo contract, 9 focused presentation tests, no caller fallbacks/title persistence, and actual product render with structural Markdown removed. |
| AC-10 | complete | Full forced no-cache test/typecheck/build/diff/isolation gates are green; independent Sol(max) review completed a finding → fix → revalidation loop, and post-completion independent QA reran Runtime, compression, and actual product browser incident paths. |

## Risks / Corrections

- No unresolved product decision at start.
- The generic UI Skill recommendation is non-authoritative and was rejected where it conflicts with `design-system/MASTER.md`.
- First-principles correction from source audit: `active_permission`, `active_question`, and `user_constraint` have no valid production protection emitter. I-06 will remove them together with `todo`, `reminder`, and `subagent_link`; the Protocol hydration path must not relabel untyped refs as a compatibility fallback.
- Real Plan fixture correction: the first two fixture attempts passed the outer `{ status, activation }` startup result where `createRuntime()` requires the inner activation capability. `ServerConfigService` correctly rejected it as foreign. This was a fixture-call error, not duplicate Bun module loading and not a product defect; the safety check remains unchanged.
- The next fixture attempt reached 7 model boundaries and 14 successful Tool calls, then stopped before the next durable `step-start`. Source review found that the initial Current Context implementation took a full Agent Tree snapshot even when a Session had zero children, adding a model-boundary dependency on the current family's persistence snapshot. The attempt was interrupted rather than counted; the projection now consumes canonical direct-child links only, and the fixture is being rerun from a fresh isolated project.
- Actual UI rendering revealed that the first display-lead implementation did not strip inline Markdown or a finite known field prefix before evaluating concrete content. The helper now strips those presentation markers, removes only the exact builtin prefixes, and keeps nonmatching content; the real project surface confirms the correction.
- Independent review correction: `skill_read` initially supplied the correct not-found recovery hint only when a `SkillNotFoundError` was thrown. Ordinary service misses return `null`, so those paths accidentally inherited a generic file creation hint. One `skillNotFoundResult()` owner now handles both paths, and tests assert the exact discovery/no-create recovery behavior.
- Independent review evidence correction: the first browser record proved Session/HITL behavior only in the authoritative prototype, while the source-product render covered Todos. A real Chrome run now exercises the actual Vite React Session route under explicit browser-network fixtures, including independent Work/card disclosures, enabled Composer reachability, keyboard focus, request navigation, and the 390px layout; no product implementation change was needed.
- The compiled Runtime check on 4190 reached a sandbox `EPERM` while reconciling another registered project's Automation file. Escalating would have introduced a second live Runtime writer, so only embedded Web/startup and the explicit recovery state were checked there; Runtime-ready behavior used the already-running installed instance on 4096.
