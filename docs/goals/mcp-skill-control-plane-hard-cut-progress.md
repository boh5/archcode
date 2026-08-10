# MCP And Skill Control Plane Hard-Cut Progress

Goal contract: `docs/goals/mcp-skill-control-plane-hard-cut-plan-goal.md`

> 本文只记录执行状态、偏差、验证证据和 review 结果。目标、范围与验收标准只以 Goal 文档为准。

## Status

- State: `complete` (AC-01 through AC-08 passed independent review)
- Branch: `codex/mcp-skill-improvements`
- Baseline: `9f1f47f619740c8d5b3c91d224a99688ef711d70`
- Started: 2026-08-09
- Last updated: 2026-08-10

## First-principles corrections

- MCP 没有额外“目录”或持久工具快照。`McpRuntimeService` 只在内存维护当前连接、当前发现工具与状态；每次模型调用读取最新工具。
- 为防止同名工具在配置变更时误绑定，单次模型调用只保留瞬时 descriptor 引用；它不进入 Session、Execution 或恢复数据。
- Skill package snapshot 仍属于一次性 Skill 的确定性执行输入，和 MCP 的实时连接语义不同，保留该设计。
- 用户 MCP 对六种 Agent 全局实时可见；只有产品固定的 builtin MCP 角色矩阵仍按 Agent 生效。
- Skill 解析沿用 Session execution cwd。一次性 Skill 持久化 claim 时的 `resolutionRoot`、source 和 digest，以保证暂停和冷恢复不改绑。

## Workstreams

| Workstream | Status | Evidence |
| --- | --- | --- |
| Baseline and ownership map | complete | Goal, ownership map and hard-cut boundaries were locked before implementation |
| MCP config/runtime hard cut | complete | Strict HTTP/STDIO config, live `McpRuntimeService`, official transports, hot apply/Test/Reconnect, cancellation, epoch fencing, redaction and drain semantics landed; Manager and MCP permission paths were deleted |
| Agent/query/tool execution integration | complete | Every model boundary reads the current global MCP projection; exact run-local descriptors use the shared Registry pipeline; suspension and startup recovery settle without rebinding or replay |
| Skill discovery/diagnostics/activation | complete | Five-tier source catalog, invalid/shadowed diagnostics, bounded projection/pages, atomic `/skill use`, immutable Execution snapshot and source/digest/root recovery landed |
| Server API and Web UI | complete | Global MCP APIs/SSE, Session-scoped Skill inventory, Settings control plane and the single-path Composer picker landed |
| Documentation and release note | complete | Active architecture/config/integration docs, sample config, Settings spec, AGENTS and CHANGELOG describe only the new contracts |
| Full verification | complete | Focused, unit, integration, architecture, Server/Web, root typecheck/test/build, diff-check and real-browser lanes are green |
| Independent final review | complete | `gpt-5.6-sol` max passed AC-01 through AC-08 after four fix-review iterations |

## Verification log

| Time | Command or evidence | Result |
| --- | --- | --- |
| 2026-08-09 | Independent plan review with `gpt-5.6-sol` max | Approved after requiring run-local descriptor binding, synchronous retire, Registry-neutral execution and suspension settlement |
| 2026-08-09 | MCP focused + real transport fixtures | 40 focused tests passed; real Streamable HTTP and STDIO passed; STDIO child exited |
| 2026-08-09 | Skill/config/execution focused suites | Skill cwd/catalog/activation 207 passed; explicit overlay suite 129 passed; Config suite 117 passed; scheduler/registry/manager focused suites passed |
| 2026-08-09 | Agent Core lanes | Unit 2,845/0; integration 143/0; architecture 83/0 |
| 2026-08-09 | Server/Web focused suites | MCP/Skill routes and Config hot apply passed; Web control tests 94 passed; Session picker tests included |
| 2026-08-09 | `bun run typecheck` | Passed, 5/5 workspaces |
| 2026-08-09 | `bun run test` | Passed, 8/8 Turbo tasks |
| 2026-08-09 | `bun run build` | Passed after granting the Worktree write needed by Vite; 2,737 modules and 308 embedded assets; executable exists and temporary entrypoint was removed |
| 2026-08-09 | Real browser QA | 1440px/390px, light/dark, MCP Settings, Skill diagnostics/picker, keyboard/screen-reader states and no horizontal overflow passed; clean reload console errors = 0 |
| 2026-08-09 | Hard-cut scans and `git diff --check` | Passed; forbidden legacy MCP names occur only in architecture-test deny patterns |
| 2026-08-09 | Independent final review iteration 4 | **PASS**; AC-01 through AC-08 passed with no remaining blocking or material finding |
| 2026-08-10 | CodeRabbit and Cubic PR review | All 41 review threads were triaged. Valid findings were fixed and covered, including MCP draft limits/cancellation/redaction, Skill persistence bounds, Config validation, UI status races, and tool-result rollback rebasing. Three contract-conflicting suggestions were rejected: legacy Session migration, per-MCP destructive approval, and treating literal STDIO args as credentials |
| 2026-08-10 | Post-review `bun run typecheck` | Passed, 5/5 workspaces |
| 2026-08-10 | Post-review `bun run test` | Passed, 8/8 Turbo tasks; Agent Core unit/integration/architecture, Server, Web, Protocol, and Utils all reported zero failures |
| 2026-08-10 | Post-review `bun run build` | Passed; 2,740 Web modules, 308 embedded assets, executable present, and temporary production entrypoint removed |
| 2026-08-10 | PR AI re-review on `55a4c744` | CodeRabbit and Cubic passed; CI and CodeQL passed; unresolved review threads = 0; PR was mergeable and `CLEAN` |
| 2026-08-10 | Late PR review remediation | Verified and fixed empty MCP redaction literals, recovery preservation of manual-inspection calls, post-close/reconnect coverage, stale Settings status snapshots, bounded Prompt trace guards, forced-terminal snapshot cleanup, fake builtin projection, and empty-result Skill picker Escape. Focused 186/0, root test 8/8 tasks, root build, and diff-check passed |

## Acceptance evidence

| Criterion | Result | Key evidence |
| --- | --- | --- |
| AC-01 | pass | Strict config/schema/secret tests; new sample/Settings/docs only; no migration, dual parser or MCP restart branch |
| AC-02 | pass | All user MCP is projected to all six Agents; exact builtin matrix and `disabledBuiltins` remain product policy; authority tests stay green |
| AC-03 | pass | Production `createRuntime` + real `McpRuntimeService` test now proves two existing cross-project Executions observe replace then disable at their next model boundaries without new Execution IDs |
| AC-04 | pass | Discovery uses one total deadline and rejects cursor cycles; HTTP/STDIO each cover the locked lifecycle; HTTP performs best-effort `terminateSession` before local close and all remote sessions/STDIO children are proven closed |
| AC-05 | pass | Stable aliases/inventory, draft-only Test, saved-only Reconnect, pending guards, secret editing and real Settings QA pass |
| AC-06 | pass | Five-tier precedence, reserved builtin policy, invalid winner isolation/no fallback, complete diagnostics and real inventory/picker QA pass |
| AC-07 | pass | Atomic receipt/message/activation, immutable package snapshot, required resolution root, digest-bound recovery/pages and 7,999/8,000/8,001-byte projection tests pass |
| AC-08 | pass | All command gates, hard-cut scans, build artifacts and independent AC review pass |

## Review log

- Plan review: approved. Required fixes incorporated before implementation: run-local descriptor binding, synchronous retire before async connect, MCP-neutral `ToolRegistry.executeResolved`, and suspension settlement of unstarted MCP calls.
- Final implementation review iteration 1 (`gpt-5.6-sol` max): **FAIL**. Blocking finding: discovery used a fresh full timeout for every page and accepted cursor cycles. Required evidence gaps: the AC-03 cross-project live-update scenario and the AC-04 real transport lifecycle matrix.
- Fix-review iteration 2: **FAIL**. Discovery and AC-03 passed. Remaining gap is test evidence only: HTTP disable plus active shutdown, and STDIO draft-Test temporary child cleanup.
- Fix-review iteration 3: **FAIL**. The added fixture exposed a production lifecycle gap: SDK HTTP `close()` aborts the stream but does not send session-termination DELETE.
- Fix-review iteration 4: **PASS**. HTTP now executes idempotent best-effort `terminateSession -> local close`; failures are redacted and do not prevent local cleanup. Real fixtures prove remote HTTP sessions and STDIO children are closed. Reviewer passed AC-01 through AC-08.
- PR review remediation: CodeRabbit and Cubic findings were verified against the locked Goal contract. Valid issues were fixed without restoring legacy compatibility or an MCP approval layer; full typecheck, test, and build gates passed. Both reviewers passed the corrected head with zero unresolved threads. PR merge remains a delivery step rather than a Goal acceptance criterion.
- Late asynchronous review comments were triaged the same way: contract-conflicting requests for legacy Session defaults, a second MCP approval gate, and per-Execution snapshots for delegated/lifecycle Skills were rejected; concrete lifecycle, bounds, race, accessibility, and test-fidelity findings were fixed and returned to the reviewers.
