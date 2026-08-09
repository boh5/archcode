# Memory System Hard-Cut Progress

> 本文仅记录 [`memory-system-hard-cut-plan-goal.md`](./memory-system-hard-cut-plan-goal.md) 的执行过程、风险、修正和验收证据。Goal 契约保持独立，不在这里重写。

## Status

- Goal: complete
- Branch: `codex/memory-improvements`
- Worktree: `/Users/bo/.codex/worktrees/memory-improvements/archcode`
- Started: 2026-08-09
- Current phase: complete; ready for user review

## Locked Decisions Carried Into Execution

- Existing `memory_write` schema, return contract, preferences append, topic upsert/index rebuild, and Lead/Discussion/Build visibility stay unchanged; only the confirmed capacity boundary is added.
- Automatic learning runs only for successful root Lead/Discussion work after 10 minutes idle; new input resets the deadline and children never auto-learn.
- `Use Memory` controls prompt injection; `Auto learning` is an opt-out with no later backfill.
- Storage remains Markdown: personal `preferences.md`, project `index.md`, and `knowledge/{topic}.md`.
- Recall remains complete preferences + complete index, with exact topic reads on demand; no vector store, embedding, or hidden top-k retrieval.
- Automatic reconciliation reads only complete touched files and emits `ADD | UPDATE | NOOP`; explicit correction may replace conflict, inference may not, and there is no automatic delete.
- Limits are 8 KiB final preferences, 16 KiB final topic Markdown, and 200 project topics.

## Workstreams

| Workstream | Owner | Status | Notes |
| --- | --- | --- | --- |
| Memory domain and explicit tool path | delegated `sol(high)` + root | complete | `MemoryService`, locking, CAS, capacities, deterministic apply; public `memory_write` unchanged |
| Idle learning and policy lifecycle | delegated `sol(high)` + root | complete | Cursor/receipt recovery, target concurrency, restart recovery and durable Execution policy are closed |
| Config, protocol and project API | delegated `sol(medium)` + root | complete | Hard-cut config, CRUD routes, warnings and revisions |
| Settings Memory UI and tests | delegated Luna worker + root | complete | Project-aware CRUD, switches, warnings, capacity, responsive dialogs |
| Integration, hard cut and full verification | root | complete | Old hooks/tasks/config/cursors removed; latest full test and production build pass |
| Independent final review | fresh `gpt-5.6-sol(max)` | complete | Fix-review loop closed with FINAL PASS and no remaining Blocker/Major |

## Execution Log

### 2026-08-09 — Baseline and decomposition

- Confirmed the dedicated worktree is clean except for the approved plan document.
- Read the complete `ui-ux-pro-max` Skill, `design-system/MASTER.md`, the Goal, and existing progress-document convention.
- Started three parallel read-only explorers with deliberately mixed cost/strength: complex Memory lifecycle on `sol(high)`, API/config on `sol(medium)`, and bounded UI/test mapping on `terra(high)`.
- Ran the Skill design-system search. Its generic purple/pink AI-SaaS recommendation conflicts with ArchCode's normative quiet operational clarity, light/dark token system, and explicit ban on generic purple AI SaaS. Rejected its visual direction; retained only accessibility, visible feedback, confirmation, keyboard, and responsive checks.

### 2026-08-09 — Domain hard cut and automatic learning

- Added the protocol Memory DTOs and made project `MemoryService` the only production mutation boundary. It owns CRUD/CAS, secret and final UTF-8 capacity checks, legacy shrink-only remediation, user/project mutation lanes, exact document reads, explicit append/upsert, deterministic receipt replay, and topic/index consistency.
- Kept the model-facing `memory_write` input/output and Agent visibility unchanged. Lead, Discussion, and Build still receive it; the implementation now calls `MemoryService` and fails atomically at the agreed capacity boundary.
- Replaced old loop hooks/background extraction and consolidation with `MemoryIdleCoordinator`. Durable root-Session state now owns processed/eligible message ids, idle time, one warning, and one bounded pending receipt. Startup recovery, shutdown, target changes and project removal are wired through Runtime.
- Added bounded evidence construction and strict fast-Profile extraction/reconciliation: at most 8 candidates, 4 touched files, 64 KiB per model input, complete required Memory documents, `ADD | UPDATE | NOOP`, explicit-only conflict replacement, marker-based suppression of already-saved `memory_write` content, and no third LLM call.
- Hard-cut config is now only `memory.{useMemory,autoLearning}`. `Use Memory` is claim-time prompt state; `Auto learning` is a live opt-out policy with a boot id plus monotonic generation and no disabled-period backfill.

### 2026-08-09 — API, Settings and browser QA

- Added authenticated project-scoped Memory snapshot/preferences/topic routes with strict revisions, 409 conflict handling, 64 KiB request admission, 422 domain errors, no absolute paths, and no Memory-body logging. The generated index has no mutation route.
- Replaced the old threshold panel with Settings → Memory: global switches, Personal and Current Project CRUD, topic metadata, capacity/warnings, delete confirmation, draft-preserving conflict reload, and a no-project unavailable state that never guesses a recent project.
- Real-browser QA covered project and Global Home behavior at desktop and 390×844. Personal save, topic create/read/delete, index rebuild, and `Auto learning=false` persistence were observed. A mobile dialog layering defect was found: Settings' z-55 rail covered the generic z-50 dialog. The shared dialog was corrected to overlay/content z-70/z-71, tested, and visually rechecked with zero console errors.

### 2026-08-09 — First-principles corrections during integration

- Topic reconciliation now numbers and mutates parsed body blocks while preserving/rebuilding frontmatter; treating complete raw Markdown as block 1 could otherwise destroy metadata.
- `MemoryFileManager.listTopics()` now swallows only `ENOENT`. Other I/O failures propagate, so `rebuildIndex()` cannot silently replace a valid index with an empty one after an unreadable directory.
- Memory policy publication is two-phase: re-enable preconditions run before durable commit, and post-commit listeners are awaited with errors surfaced. Listener failure is no longer silently reported as a successful Settings save.
- A queued newer user input leaves the older terminal Execution ineligible for idle scheduling until the newer root Execution completes, matching “continuous idle after the latest successful turn”.
- Removed dead `AgentHookPolicy.memoryExtraction/memoryConsolidation` fields from all six definitions and fixtures; no ignored compatibility contract remains.

### 2026-08-09 — Independent implementation review, pass 1

- A fresh `gpt-5.6-sol(max)` review returned `NOT_DONE` with no Blocker and seven Major findings: newer eligible-window preservation, concurrent automatic target reconciliation, Execution-scoped Memory policy persistence, unsafe artifact-recovery evidence, accidental all-topic reads, sanitized unknown API failures, and missing fault/restart/concurrency acceptance evidence.
- The same review also identified two concrete liveness/UI defects: topic-count blocking was attached to the proposed topic instead of the project capacity, and displayed topic bytes omitted canonical frontmatter. Both entered the fix cycle rather than being deferred.
- A first-principles follow-up found that making the new Execution Memory snapshot optional would create an unapproved legacy fallback. The implementation is being hard-cut to a required durable field, as required by the user's refactor rule.
- The first real configured `fast` Profile eval exposed a provider incompatibility with forced `tool_choice` while thinking mode is active. `runLlmObject` now keeps the single strict schema tool but leaves tool selection to the provider; all existing Zod validation, repair, retry, usage, abort and redaction behavior remains. A second eval through the corrected production seam and current `local:deepseek-v4-flash` fast binding passed all three observation cases: contextual “同意” produced a project `build_tools` candidate, the semantic duplicate returned `NOOP`, and the explicit correction returned `UPDATE` for block 1.

### 2026-08-09 — Review fixes and acceptance closure

- Receipt commit now compares only the processed cursor and policy epoch, preserves a newer eligible window, and reschedules it. Automatic writes to the same real target serialize across coordinator instances; a stale revision receipt is discarded without cursor advance so the next permitted trigger can rebuild it instead of replaying forever.
- The Memory policy snapshot is a required durable Execution field and is reused across suspend/resume. There is no optional-field or legacy-read fallback. Policy disable and receipt persistence share the short admission gate, so the disable response cannot race with an old receipt commit.
- Automatic evidence no longer trusts artifact-recovery wrappers, filters secrets across every persisted candidate field, and rejects reserved project targets. Reconciliation reads only selected complete documents; index projection replaces the former full snapshot read in the model path.
- Unknown CRUD and resolver failures map to a safe error without paths, Memory bodies or secrets in responses or structured logs. Topic-count blocking is project-wide, and displayed topic capacity is calculated from the exact canonical frontmatter plus body.
- Acceptance coverage now includes three real disk crash/restart positions, deterministic zero-LLM receipt replay, two-project personal-memory concurrency, real `memory_write` marker suppression after restart, policy ABA/disable behavior, warning ordering/source/clearing, legacy 25/20 KiB and 201-topic remediation, exact prompt-injection boundaries, and Settings CRUD/conflict/capacity flows.

### 2026-08-09 — Final fix-review closure

- The independent delta review found and the implementation fixed additional concrete edges: missing-target `NOOP` no longer creates empty files; an in-flight manual change can wake a conflicted batch without requiring restart; automatic apply builds the verified index from the system-owned index plus touched frontmatter and does not scan unselected topic bodies; empty descriptions and existing project topics with `type:user` remain valid.
- Topic metadata is validated before any write, and Memory read/write failures are mapped to stable safe errors. Regression tests prove absolute paths, secret sentinels and nested causes do not enter Prompt traces, logs, raw tool results, finalized results or model-visible output.
- Re-enabling Auto learning now uses explicit `enable_preparing → enable_pending → enabled` admission and per-Session durable message-id baselines. Two-Session deferred-baseline tests cover both successful enable and failed config commit without wall-clock ordering assumptions.
- The same independent `gpt-5.6-sol(max)` reviewer rechecked the frozen tree after the final fixes and returned FINAL PASS: AC-01 through AC-08 all pass, with no remaining Blocker or Major.

## Risks / First-Principles Corrections

- Closed: a 10-minute debounce is backed by durable message-id cursors, a bounded pending receipt, startup recovery and terminal-commit ownership.
- Closed: user-global preferences serialize by their real path across project service instances; project topics/index use a separate project lane.
- Closed without a generic WAL: the single bounded receipt stores validated final documents and expected/final revisions solely for deterministic Memory apply/cursor recovery.
- Closed: Settings without a project keeps global switches available and makes CRUD explicitly unavailable; it never guesses project identity.

## Verification Evidence

| Check | Result | Notes |
| --- | --- | --- |
| Focused domain/policy tests | pass | Final policy/coordinator 50/50, Memory read/write 47/47 and ConfiguredAgent 39/39 passed; the independent reviewer also ran a 332-test merged regression with zero failures. |
| `bun run typecheck` | pass | Full Turborepo graph passed: 5/5 packages. |
| `bun run test` | pass | Latest current-head full Turborepo graph passed: 8/8 tasks. |
| `bun run build` | pass | Latest current-head full typecheck, Vite production build (2739 modules) and Bun binary compile (308 embedded assets) passed; `dist/archcode` generated. Existing large-chunk warning is non-blocking. |
| `git diff --check` | pass | Passed after implementation and hard-cut cleanup. |
| Independent plan review | pass | Previous `sol(xhigh)` fix-review closed all Blocker/Major findings before implementation authorization. |
| Hard-cut `rg` audit | pass | No production old hook/task names, legacy cursor/threshold keys, or Memory mutation bypass; `MemoryFileManager` production writes are internal to `MemoryService` (plus its own index helper). |
| Browser QA | pass | Desktop + 390px project/Home states, CRUD, switches, generated index, confirmation and clean console verified; dialog layering defect fixed and retested. |
| Independent implementation review | pass | Independent fix-review loop closed with FINAL PASS; AC-01 through AC-08 were mapped to code, tests, commands and browser evidence, with no remaining Blocker/Major. |
