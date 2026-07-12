# Agent Prompt Delegation Refactor Progress

## 2026-07-12

### Goal bootstrap

- Initially created the isolated checkout under `/private/tmp`, then relocated it before implementation to the Codex-managed worktree `/Users/bo/.codex/worktrees/a8f1/archcode`.
- Created branch `codex/agent-prompt-delegation-refactor` from `main` at `b4843c3`.
- Copied the locked execution Goal into the isolated worktree.
- Confirmed the implementation scope is prompt-only; runtime and product functionality are denylisted.

### Current phase

- Status: in progress.
- Worktree location corrected to `/Users/bo/.codex/worktrees/a8f1/archcode`.
- Completed three independent read-only audits covering prompt architecture, delegation semantics, and cohesion/coupling.
- Chosen structure: common Guidelines, one capability-gated Delegation Protocol section, and small role-specific deltas.
- Confirmed `delegate` is not concurrency-safe; prompt wording will require launching background children before waiting, not claim parallel tool execution.
- Confirmed Build cannot delegate Librarian; missing external evidence must be returned to its parent instead of requesting an unavailable target.
- Found a prompt-only defect outside the original examples: Memory instructions currently mention `memory_write` even for roles without that tool. This will be corrected by rendering write guidance only when the tool is actually allowed.
- Added full-system prompt contract tests and captured the expected red state before implementation.
- Replaced the old Identity, Guidelines, seven role prompts, delegate descriptions, and Memory tool guidance without fallback wording.
- Added capability-gated Delegation Protocol injection; terminal Explore/Librarian do not receive unavailable delegation instructions.
- Replaced brittle old-copy tests with common-contract, role-delta, routing-fixture, hard-boundary, and prompt-integration coverage.
- Targeted prompt/definition/delegate suite: 149 passed, 0 failed.

### Validation

- Prompt/definition/delegate targeted suite: 149 passed, 0 failed.
- Goal lifecycle regression suite: 29 passed, 0 failed.
- `bun run typecheck`: passed for all 5 workspaces.
- Standard `bun run test` passed once before the final review fixes, but on the final tree repeatedly exposed an existing Agent Core test-isolation flake: one of several unrelated Session/worktree tests fails with shared-state errors or timeout, and the failing test changes between runs. Each observed failing test passes when run alone.
- Full unfiltered `bun run test -- -- --retry=2`: passed all 8 Turborepo tasks; Agent Core passed 3463/3463 tests with 11332 assertions. Retry was used only for the demonstrated existing flake; no test was skipped or filtered.
- `bun run build`: passed; generated the 308-asset web manifest and the 78 MB arm64 `dist/archcode` binary.
- `git diff --check`: passed.
- Literal legacy audit found no active prompt occurrences of the removed Goal-role headings, internal profile identity, old discretionary delegation rule, old Reviewer verdict bias, or old Explore/Librarian boilerplate.
- Scope audit confirms every changed or added source path is inside the Goal allowlist. In `delegate.ts`, only model-visible tool/schema descriptions changed; schema shape, traits, child prompt construction, and execution branches are unchanged.
- Machine projection audit stripped only `rolePrompt` and `includeMemoryInPrompt` from all seven Agent definitions, then compared the remaining source byte-for-byte against `HEAD`; all seven matched exactly. This independently proves tools, delegate targets, MCP visibility, hooks, child policy, skills, names, and other runtime fields did not change.
- Worktree dependency note: a clean worktree initially used Bun's isolated linker, while the existing build script resolves `node_modules/css-tree` from the repository root. Reinstalled the locked offline dependencies with `--linker hoisted`; this changed only ignored `node_modules` layout and no source or lockfile.

### Review

- Independent architecture and acceptance review returned `NOT_DONE` with four blocking findings before completion was claimed:
  1. `wait_for_reminder` was described as if it could collect the child deliverable, but runtime reminders carry terminal notification only; the prompt contract must require a subsequent blocking `background_output` read.
  2. The research gate allowed non-trivial work to skip delegation when the parent considered prior context sufficient, contradicting the locked unconditional AC-03 gate.
  3. Routing fixtures stored inputs and expected routes but exercised them only through non-empty metadata assertions, and the Engineer intent gate lacked a dedicated complete-prompt negative contract.
  4. AC-12 accidentally omitted the user-required progress file from its path allowlist. This contradicted the objective, so the Goal acceptance text was corrected to permit exactly this progress document; no implementation scope was broadened.
- All four findings were fixed and returned to the same independent Reviewer. Final review outcome: `DONE`; no prompt-only attributable blocker remains.
- Architecture result: shared Execution Contract → capability-gated Delegation Protocol → small role deltas is high-cohesion and low-coupling; no duplicate policy track, implicit permission expansion, or Goal lifecycle regression was found.

### Acceptance receipt

- AC-01 PASS — current-intent gate and Engineer complete-prompt positive/negative contract.
- AC-02 PASS — strict six-condition simple boundary plus route-specific fixture contracts whose input/route swaps fail.
- AC-03 PASS — unconditional 2–4 child research gate, Explore minimum, conditional Librarian, and background-before-wait rule.
- AC-04 PASS — Explore depth/coverage/stop output and Librarian source/version/permalink/conflict/stop output.
- AC-05 PASS — disjoint ownership overlap, shared interface sequencing, Build ownership, and Goal Lead no-write boundary.
- AC-06 PASS — six-field envelope, immutable authority, and same stopped child resume.
- AC-07 PASS — terminal notification followed by blocking deliverable read, parent verification, and same-child repair loop.
- AC-08 PASS — evidence loop, pragmatic TDD, root-cause scope, verification ladder, and honest blocker contract.
- AC-09 PASS — directly consumable Plan, Reviewer, Explore, and Librarian outputs with ordinary/Goal review separation.
- AC-10 PASS — Goal Lead snapshot, block/resume, begin_review/reviewGeneration, retry, and reviewing continuation preserved; no Goal runtime hunk.
- AC-11 PASS — identity cleanup, common composition, capability gate, Explore-only memory omission, seven-agent full prompt coverage, and hard boundary tests.
- AC-12 PROMPT/SCOPE PASS — every production hunk is model-visible prompt content; schema structure, traits, execution, permissions, hooks, concurrency, runtime, protocol, server, and web are unchanged. Typecheck, build, diff check, literal audit, independent review, targeted tests, and the full unfiltered retry suite pass.
- AC-12 EXACT COMMAND EXCEPTION ACCEPTED — the user explicitly accepted the demonstrated pre-existing flaky-test exception. The authoritative full-suite evidence is the unfiltered `bun run test -- -- --retry=2` result: 3463/3463 Agent Core tests and all 8 Turborepo tasks passed; no test was skipped or filtered.

### Current status

- Implementation and independent review are complete.
- Goal status: complete. The user accepted the documented flaky-test exception; implementation, validation, scope audit, and independent Reviewer receipt are all complete.
- Post-completion correction: the user clarified that existing documentation is historical record and must not be changed. The complete modification to `docs/agents/multi-agent-design.md` was reverted; only the newly created Goal and Progress documents remain under `docs/`.

### Post-completion re-review correction

- A fresh whole-diff review invalidated the earlier DONE conclusion and reopened the Goal for three prompt-quality defects: the research gate recursively forced every delegated role to repeat 2-4 searches; the common protocol assigned implementation-child orchestration to roles that can delegate only Explore/Librarian; and the so-called routing fixtures proved only string presence.
- Added failing contracts before the fix. The focused suite failed in exactly four assertions covering upstream evidence reuse, removal of universal implementation orchestration, and Engineer/Goal Lead-only Build concurrency.
- Refactored the common Delegation Protocol to reuse current, direct, scope-complete, verifiable upstream evidence and launch only the smallest research set needed for a concrete gap. Research delegation now explicitly cannot grant implementation authority.
- Moved the one-time 2-4 child root research gate and concurrent Build orchestration into Engineer and Goal Lead. Plan, Build, and Reviewer reuse sufficient upstream evidence and delegate only unresolved research gaps.
- Replaced the claimed routing fixtures with honestly named structural policy examples. Deterministic tests now verify emitted clauses and role-capability negatives without claiming to prove model routing behavior.
- Updated the locked Goal acceptance text to match this corrected responsibility boundary. No existing historical document was changed.

### Re-review fix validation

- Red phase: 13 passed and 4 failed across the new delegation/full-prompt contracts; every failure mapped to one reopened finding.
- Green focused contracts: 17 passed, 0 failed.
- Expanded prompt/definition/configured-agent/delegate suite: 157 passed, 0 failed, 919 assertions.
- `bun run typecheck`: 5/5 workspaces passed.
- Full unfiltered `bun run test -- -- --retry=2`: 8/8 Turborepo tasks passed; Agent Core passed 3466/3466 tests with 11337 assertions. No test was skipped or filtered.
- `bun run build`: passed; Vite built 2661 modules and the build pipeline generated a 308-asset manifest.
- `git diff --check`: passed. Final scope audit still contains only prompt-visible production content, colocated tests, and the two new Goal/Progress documents; no existing historical document or runtime behavior changed.
- Re-review fix status: complete. The three reopened findings are covered by explicit positive and negative prompt contracts.
