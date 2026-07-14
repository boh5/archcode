# Agent Core Test Parallelization Hard-Cut Goal

## Objective

将 `@archcode/agent-core` 测试硬切为三条职责明确的执行车道：隔离良好的单元测试使用 Bun 文件级多进程并行，真实进程/系统资源集成测试保持串行，架构测试独立运行；同时删除共享临时目录和真实长等待。完成后测试覆盖不得缩水，结果必须稳定，包级测试耗时从当前约 72 秒降至可重复的 35 秒以内。

## Locked Architecture

```text
package test
  -> test:unit         *.test.ts（排除 integration 与 __arch__） -> --parallel=4
  -> test:integration *.integration.test.ts                    -> --isolate 串行
  -> test:arch        src/__arch__/**/*.test.ts                 -> --isolate 串行
```

- 分类只由文件后缀和目录决定，不引入 tag、动态分类器或自建 test runner。
- 真实子进程/stdio/signal、Git/worktree、LSP transport/server lifecycle 测试属于 integration；mock、内存状态和独占临时目录测试属于 unit。混合文件必须拆分，不能整文件降级为 integration。
- 模块级 LLM/LSP test seam 依靠 `--parallel` 的 worker 进程隔离；同一文件内保持顺序执行。不使用 `--concurrent`，不为并发重构生产 Runtime 或建立 DI 容器。
- 临时根必须以随机 UUID 唯一化：单文件简单常量可直接构造并精确清理同一叶子；需要复用创建/清理生命周期时只使用一个 package-private test helper。该 helper 不从包入口导出，生产代码不得依赖。
- `llm/retry` 唯一拥有窄 `RetryScheduler { now, sleep }`；`withLlmRetry` 与 Query Loop 显式使用同一契约，生产使用真实 abortable scheduler，测试使用确定性 fake。LSP 工具映射使用立即返回的 typed timeout fake；不降低生产 timeout/backoff。

## Non-goals

- 不改变 Bun、Turborepo、CI 平台或其他 workspace 的测试架构。
- 不并行 integration 车道，不按 CPU 数动态选择并发度，不增加 benchmark/performance 框架。
- 不通过提高全局 timeout、增加 retry、减少断言或跳过测试换取通过率。

## Acceptance Criteria

以下 AC-01 至 AC-06 必须全部满足；任一条件缺失即为 `NOT_DONE`。

### AC-01：三条测试车道唯一且完备

- `packages/agent-core/package.json` 只有 `test:unit`、`test:integration`、`test:arch` 三个分类脚本；`test` 以固定顺序各执行一次，任一失败立即失败。
- `test:unit` 明确排除 `*.integration.test.ts` 与 `src/__arch__/**`，固定使用 `--parallel=4`；`test:integration` 以 `.integration.test.ts` 过滤并固定使用 `--isolate` 串行；`test:arch` 只以 `--isolate` 串行执行 `src/__arch__`。
- 删除 `--max-concurrency=1` 及所有旧测试入口、wrapper、别名和串行 fallback；所有活跃测试配置、脚本与 Agent Core 源码中不存在 `test.concurrent`、`describe.concurrent`、`--concurrent`、全局 `--retry` 或失败后改跑串行的分支。历史文档中的命令证据不属于活跃入口。
- 删除会被 Bun 子串过滤误命中的旧 `*-integration.test.ts` 命名；真实集成测试只能使用 `*.integration.test.ts`。
- Agent Core 三条车道合计成功测试数不低于基线 3104，且无 `skip`、`todo`；同一测试不得复制到多条车道凑数。

### AC-02：Integration 按机制拆分

- 所有启动真实子进程、真实 Git/worktree 或真实 LSP transport/server 的 case 均位于 `*.integration.test.ts`；对应纯 schema、参数、状态转换和错误映射仍留在相邻 unit 文件。
- 迁移采用移动而非复制；测试名称、核心断言和覆盖场景保持不变。Reviewer 必须给出拆分前后文件映射，并确认不存在漏测或重复执行。
- 新增架构测试，禁止非 integration 文件使用真实资源入口：`Bun.spawn`、Fake LSP server、真实/default process runner、真实 Git/worktree fixture；允许边界只由 `*.integration.test.ts` 后缀决定，不维护例外 allowlist。

### AC-03：并发文件系统完全隔离

- 所有写磁盘的 Agent Core 测试使用随机唯一根目录；生产源码路径、固定 `/tmp/archcode-agent-core-*`、共享 `__test_tmp__` 根目录均不得作为可删除的测试所有权边界。
- 清理只能递归删除当前测试创建的唯一叶子目录；不存在删除父级 `__test_tmp__`、其他文件测试目录或按名称猜测所有权的逻辑。
- `memory-extraction.test.ts` 与 `memory-consolidation.test.ts` 以 `--parallel=2 --rerun-each=10` 同跑时必须全部通过；结束后不得遗留本次创建的临时目录。

### AC-04：移除人为长等待

- LSP diagnostics 的工具层 timeout 映射测试由 fake 立即抛出 `LspError(kind: "lsp-timeout")`，删除基于 `Date.now()` 的约 10 秒等待；真实 timeout 调度只在 LSP 底层边界测试一次。
- `RetryScheduler` 是全部 LLM retry 时间的唯一入口：`withLlmRetry` 与 Query Loop 不得绕过它直接调用 `Date.now()`、`setTimeout()` 或 `sleepAbortable()`；不新增模块级 mutable test setter，不改变 retry 次数、退避公式或审计字段语义。
- unit 测试不得通过真实生产 backoff 或固定 sleep 等待超过 100ms；需要验证时间推进时必须使用 fake scheduler/timer。

### AC-05：Hard cut 与架构约束

- 不保留旧脚本、旧文件副本、兼容导出、双轨临时目录策略或“并发失败则串行”的 fallback；发现不安全 unit 时修复隔离或拆入 integration，不能静默降并发。
- 公共改动仅限测试车道、唯一的 package-private 临时目录 helper 和 LLM retry 的窄时间 seam；不得为简单 UUID 路径建立额外抽象，也不得借机重构 AgentRuntime、LSP pool、LLM adapter、Session、Goal 或 Tool 架构。
- 更新 AGENTS.md 中受影响的测试命令和分类说明；文字审计确认文档与实际脚本一致。

### AC-06：稳定性、性能与最终验证

- 采用 TDD 并保留红绿证据：先复现共享临时目录竞态，再分别增加会因旧实现失败的车道边界、`RetryScheduler` 和 LSP immediate timeout 测试，最后实现；Reviewer 必须给出对应失败与通过输出。
- 在同一开发机、无其他 ArchCode 测试进程并行运行的条件下，先执行 1 次不计入结果的预热，再用 `/usr/bin/time -p bun run --cwd packages/agent-core test` 连续测量 5 次 `real`：每次全部通过、单次不超过 45 秒、5 次中位数不超过 35 秒。
- 连续执行 10 次 `test:unit` 全部通过；全过程不得使用 test retry、放宽 timeout、skip/todo 或失败重跑掩盖 flake。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；测试结束后无 Agent Core 测试子进程或临时目录泄漏。
- Reviewer 按 AC-01 至 AC-06 给出脚本、文件映射、TDD 红绿记录、竞态复跑、测试数量、5 次 `real` 耗时和 hard-cut 搜索证据；不能只用一次全绿作为完成依据。
