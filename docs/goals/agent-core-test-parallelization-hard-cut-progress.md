# Agent Core Test Parallelization Hard-Cut Progress

## Status

后续代码审查提出的 Unit 清理竞态、真实 1 秒 retry 等待、ProcessRunner 门禁过宽和文档失真均已修复。原始 Reviewer 曾给出 `APPROVE`；其后新发现的 standalone Integration 偶发 timeout/runner 不退出按用户决定暂缓，因此严格按原 Goal AC-06 当前为 `NOT_DONE（accepted risk）`，不再保留无条件通过表述。Goal 权威验收见 `agent-core-test-parallelization-hard-cut-goal.md`；本文只记录实施过程与证据。

## Result

- Agent Core 硬切为 unit、integration、architecture 三条车道；unit 固定 `--parallel=4`，其余固定 `--isolate`，无 retry、fallback 或旧入口。
- 当前数量：unit 2893、integration 138、architecture 86，合计 3117 tests；基线 3104，未发现 skip/todo/concurrent 或测试复制。
- 包级计时先以 28.51s 成功全量作为不计入结果的预热，随后 5 次正式耗时为 23.16s、27.52s、25.33s、24.83s、24.97s；最大 27.52s，中位数 24.97s。实施前约 72.17s。
- 连续 10 次 unit：3.62s、3.90s、3.89s、3.97s、3.71s、4.06s、3.73s、3.73s、3.68s、4.11s；每次 2893 pass / 0 fail。

## Architecture Delivered

- `package.json` 只有 `test:unit`、`test:integration`、`test:arch` 三个分类入口，`test` 按 unit → integration → arch 顺序 fail-fast 执行。
- 24 个 `*.integration.test.ts` 承担真实 subprocess、Git/worktree 与 LSP lifecycle；混合文件按 case 移动，纯状态/schema/error mapping 留在相邻 unit 文件。
- `src/__arch__/test-lanes.test.ts` 禁止旧 `*-integration.test.ts`、unit 中的真实 OS 资源入口及以生产源码目录作为 Session 持久化根；`architecture.test.ts` 禁止生产源码依赖 `src/testing`。
- 唯一 package-private `TestTempRoot` helper 管理可复用的随机 UUID 叶子生命周期；简单 fixture 直接使用随机唯一叶子。生产源码不导入测试 helper。
- `llm/retry.ts` 唯一拥有 `RetryScheduler { now, sleep }`；Query Loop、text/object LLM、compact、标题生成和后台任务显式传播同一契约，生产 scheduler 保持 abortable，测试 fake 确定性推进时间。
- LSP diagnostics timeout 映射由 fake 立即抛出 typed `LspError("lsp-timeout")`，删除约 10 秒真实等待；生产 timeout 不变。

## First-principles Corrections

- Bun 位置 pattern 是子串过滤；`integration.test.ts` 会误命中旧 `*-integration.test.ts`。最终用 `.integration.test.ts` 过滤并删除全部旧连字符命名。
- “串行”不等于“隔离”；integration 与 architecture 使用 `--isolate`，避免跨文件模块/global 状态泄漏。
- 并发安全的根本不是统一路径格式，而是唯一所有权。所有可删除边界都是随机叶子，清理不再触碰共享父目录。
- 首轮并发修复后仍发现部分 query/title 测试把 Session 持久化写进 `src/**/.archcode`，使架构扫描越来越慢。已改用随机测试根，并增加架构门禁禁止复发。
- worktree managed-claim case 即使拥有唯一根，作为同文件第五个真实 Git lifecycle 仍会累积进程/资源压力并超时。将该原 case 原样移动到独立 integration 文件后，两个文件复跑 5 次为 110 pass / 0 fail；没有重试或降并发。
- 所有测试强制依赖 helper 会把一行 UUID 路径变成无收益耦合。因此只统一所有权规则，helper 仅服务复用生命周期，避免过度设计。

## TDD And Stability Evidence

- 车道门禁红灯：旧 integration 命名 3 个，非 integration 真实资源违规 24 项；移动/拆分后均清零，无文件 allowlist。
- RetryScheduler 红灯：128 pass / 4 fail；统一 seam 后定向 148 pass / 0 fail。完整 retry 传播定向集最终 92 pass / 0 fail，耗时 174ms；原目标集约 17.83s。
- memory 并发红灯为 14 fail（包含共享目录被另一 worker 清理导致的 `ENOENT`）；改为唯一 owned leaf 后，四个 memory extraction/consolidation 文件以 `--parallel=2 --rerun-each=10` 为 590 pass / 0 fail，且无 helper 叶子残留。
- LSP timeout 红灯执行真实生产定时器，单 case 约 10s；改为立即抛出 typed timeout 的 fake 后，同一 `returns lsp-timeout error with stale diagnostics on timeout` case 在最终干净运行中为 1.96ms，并保留原错误映射断言。
- worktree 拆分后两个 integration 文件以 `--rerun-each=5` 为 110 pass / 0 fail。
- 原验收阶段从干净状态执行 package suite：3114 pass / 0 fail，27.98s；收敛重复 fake 后再次为 3114 pass / 0 fail，wall 22.53s。后续修复新增 3 个架构断言，当前总数为 3117。

## Final Validation

- `bun run typecheck`：5/5 workspaces passed。
- `bun run test`：8/8 Turborepo tasks passed；最终项目级复跑为 34.432s，Agent Core Architecture 为 86 pass / 0 fail。
- `bun run build`：typecheck、Vite build、308-asset manifest 与 Bun binary compile passed。
- `git diff --check`：passed。
- Hard-cut 搜索：活跃测试配置、脚本与 Agent Core 源码中无 `*-integration.test.ts`、skip/todo/concurrent、`--retry`、`--max-concurrency=1` 或串行 fallback；AGENTS.md/本 Goal 保留禁止性说明，既有历史进度文档保留过去的命令证据。
- 后续审查曾复现完整 Unit 结束后异步 HITL 写入重新创建 owned leaf；修复 coordinator teardown 与终态等待后，2893 个 Unit 全部通过。继续用项目级命令复核时又定位到 Session HITL Integration、Automation Integration 和两个 memory hook 测试在清理后仍有未等待的 Session 持久化；全部改为先等待 durable terminal/持久化，再释放 runtime/store，最后清理。最新 `bun run test` 结束并等待 2 秒后，源码无临时文件，`/tmp/archcode-agent-core-tests` 无 owned root。

## Reviewer Acceptance

- 整文件迁移：session-cwd-reference-migration 17；session-worktree-hitl 1；goals/workspace 11；lsp/compat-spike 4；lsp/fake-server 24；worktrees/service 21，并将 managed-claim 原 case 1 移入独立 integration 文件。
- 混合文件拆分（unit/integration）：session-agent-manager 10/2、execution-scope-validator 9/3、session-hitl-resume 27/1、runtime-automations 9/1、lsp/client 8/4、lsp/transport 6/4、ast-grep/replace 27/1、file-edit 20/3、file-write 15/1、git-status 5/4、goal-tools 15/1、lsp-diagnostics 5/10、lsp-find-references 3/5、lsp-goto-definition 3/5、lsp-symbols 4/4、view-tool-output 10/1、worktree tool 2/9。
- 旧误导命名只改职责名并保留 unit：goal-integration → goal-core 2；hitl-integration → hitl-resume 12。
- Reviewer 对 25 组迁移文件逐一比较迁移前后 test title 多重集合，数量与名称完全相等，无漏测、复制或重复执行；架构门禁定向 25 pass。
- 原 Reviewer 在当时证据下给出 `APPROVE`；后续新运行推翻了“无 flake/无残留”的绝对结论，当前状态以本文 Status 为准。

## Post-review Fixes

- ResumeCoordinator 增加局部 `ResumeRetryScheduler` 契约，生产 scheduler 保持真实 timer，测试以确定性 fake 推进；目标 case 从约 1.02s 降至 23.59ms，11 个 coordinator 测试全部通过。
- Session HITL resume 测试显式跟踪并 dispose coordinator，最后一个后台 continuation 等到 durable terminal 后才结束；完整并发 Unit 为 2893 pass / 0 fail、3.44s，延迟扫描零残留。
- ProcessRunner 门禁不再因文件中出现 setter 就整体放行；每次默认 runner 调用必须在同一 test 内先安装非 `undefined` fake，且首个 test 之前必须声明 `afterEach` 恢复。门禁现为 5 pass，完整 architecture 为 86 pass。
- 项目级并发一度使 compression prose 架构检查因递归扫描 `.turbo` 等非受管运行目录而超过默认 5 秒。没有放宽 timeout；扫描边界收敛为根文档及 `apps/packages/scripts/design/docs`，同一检查由受载时 10.7s 降至后续项目级复跑的 65.61ms。
- 已知 accepted risk：standalone Integration 曾在 managed-claim case 5s timeout 后留下 dangling Git process，runner 未自行退出。用户决定本轮不处理；因此不把该风险包装为通过。
