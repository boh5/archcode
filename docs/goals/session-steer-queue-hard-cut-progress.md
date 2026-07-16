# Session Steer 与 Queue Hard-Cut Progress

## Status

`COMPLETED`

## 2026-07-16

- Goal 文档已从 `docs/plan/` 移到 `docs/goals/session-steer-queue-hard-cut-goal.md`，后续设计契约保持冻结；执行记录只写入本文件。
- 已开始按低冲突所有权并行实施：Protocol/Store/Input、Agent/Query、Web 分别交给独立子 Agent；主线程负责 Execution/Runtime/Automation/Server 集成。
- 硬切约束保持不变：不保留旧 Runtime/Agent API、workspace concurrency、execution-scoped forwarding、Automation execution identity 或旧 Session schema fallback。
- 子 Agent 分工：Core Input/Store 使用 `gpt-5.6-sol(high)`，Agent/Query 使用 `gpt-5.6-sol(medium)`，Web 使用 `gpt-5.6-luna(high)`；按任务复杂度分配，避免全部使用最高成本配置。
- Protocol/Input 早期契约已收敛：pending 保存完整消息，receipt 仅内部持久化，canonical message 以 `clientRequestId` 关联 Web optimistic 气泡，Queue 事件由 Session event source 发布。
- 已从 Execution/Goal/HTTP 主链删除 workspace 并发额度、`ConcurrentSessionLimitError`、Goal `capacity` outcome/capacity waiter；不引入 slot、lock 或公平调度替代物。
- Automation 已硬切为 message admission：`invocation.id` 直接作为 `clientRequestId`，删除 Invocation `executionId`、execution preflight 和上一次 Execution active 探测；投递成功后的状态写失败通过同一消息幂等键重试。
- `SessionInputService` 已完成：Queue、Edit/Delete、Steer claim/commit/rollback、批量 canonical commit 与请求幂等集中在一个领域模块；StoreManager 只提供同步 mutation + durable publication barrier。
- Agent/Query 已硬切为 canonical-input 契约：删除 raw string/user-message append；QueryLoop 只在 model build 前调用 Execution 提供的 `consumeSteers()` safe point。
- Execution 已改为 `queue | direct | continuation` 三种 typed input；provisional claim 在持久化前阻止重复 start，只有 input + execution-start durable 后才公开 running/Steer fence。
- Stop 只终止当前 family 并写入 root execution 的 `stopRequestedAt` 事实；Queue 不清空、不暂停、不自动续跑。Stop 会关闭 Steer gate，并等待 claim/commit 等同一组 in-flight Steer 持久化操作后再 rollback 未提交消息。
- Runtime 已切换为 `acceptSessionMessage` 薄入口，idle 收敛顺序固定为 Tool Batch → Queue → Goal continuation；Queue 在 completed 后批量 drain，Stop/失败后仅由 barrier 之后的新消息触发下一次 Execution。
- Session event forwarding 已从 Execution 生命周期完全移除：StoreManager 是 durable raw event source，Runtime 持有一次性全局投影 Bridge，Server 启动时只订阅一次；idle/running/stopping 共用同一路径。
- Server 已提供 POST accept、PATCH Edit、DELETE、POST Steer API；Web 使用普通 timeline 气泡呈现 `Sending…`/`Queued`/`Steering`，并提供 queued 行内 Steer/Edit/Delete，无 Queue 面板、模式按钮或消息级 Send。
- 已补核心执行语义测试：A 运行时 B/C 排队；A 完成后 B/C 同一 Execution；Stop 后 B/C 保留并与 D 同一 Execution；Steer safe point commit；Stop rollback 未消费 Steer。
- 第一性原理纠正：原计划写“stopping 时发送请求必须等待 Stop 完成后才持久化”并非必要。Stop fact 在 await 前同步进入同一 Session 有序状态，后续 accept 由单调 timestamp 自然落在 barrier 之后；无需额外 waiter 或暂停状态即可得到 B/C/D 语义。
- 首轮独立架构审查发现并修复 6 个缺口：Goal startup 越过 Stop、provisional Queue commit 与 Stop 竞态、in-flight Steer commit 与 Stop 竞态、await 前旧快照 cutoff、canonical/deleted 冲突缺少最新投影、未知 POST 结果缺少同 ID 重试。
- 竞态修复没有引入 pause/lock/slot：Stop 对尚未 durable start 的 active generation 写同一 `execution-start → stop-requested → cancelled` 事实；Queue/Direct/Steer 在现有 Store 同步 mutation 内检查 Execution AbortSignal，CAS 先发生则 commit 有效，Stop 先发生则输入保留/rollback。
- Queue cutoff 改为最终同步 active claim 时从完整 queued snapshot 捕获。验证等待期间到达的消息归入本批；claim 之后到达的消息留给下一批。
- Goal continuation 现在以 `goal_claim` origin 进入 Execution，并在服务快照与最终同步 claim 两处让位于 pending Queue；非显式 kick 的 startup/family-idle 均不能越过 `stopRequestedAt` 或 cancelled/aborted/interrupted 终态。
- Edit/Delete/Steer 冲突现在返回统一最新投影（queued/steering/canonical/deleted），仍由 receipt/message 单一事实源推导，不给 receipt 增加正文或第二份状态。
- Web 未知 POST 结果把原 optimistic 气泡标记为可重试；Retry 复用原 `clientRequestId` 和正文，并在成功后刷新 canonical Session snapshot，不创建新消息身份。
- 第二轮独立审查进一步发现：slash command 的副作用不能只靠 Runtime 读取 receipt 后再执行，否则同一 `clientRequestId` 的并发请求存在 TOCTOU。已把 live command admission 收回 `SessionExecutionManager`，复用既有 family 所有权；同 ID 请求加入同一运行结果，不同命令、Queue、Goal 或模型执行互斥，不新增 coordinator、slot 或 lock 概念。
- 命令 receipt 已硬切为判别联合：`executing | completed | failed | indeterminate`。进程在副作用完成、receipt 落盘前崩溃时，重启把 `executing` 修复为 `indeterminate` 并 fail closed，明确提供 at-most-once 而不伪称 exactly-once；命令转普通消息在同一持久化 mutation 内完成。
- 命令取消边界已补齐：command handler 在入口、异步 handler 返回后以及 continuation 前都检查 AbortSignal；Stop/Delete/`abortAll` 取消命令，已加入同 ID join 保留原始错误、active command 阻止 cwd transition 等测试。
- 第三轮审查发现一个 Stop 边界：如果 family 只有 slash command 或 descendant 在运行，root 没有可写 `stopRequestedAt` 的 Execution，旧 Queue 仍可能在命令结束后自动 drain。为保持“Stop 后等下一条新消息再把所有 Queue 一起执行”，只在这种无 active root Execution 的显式 Stop 下持久化一个 `queueDispatchBarrierAt` 时间事实；下一批 Queue 与 `execution-start` 同一 mutation 清除。它不是 Session pause 状态，不暴露给 Protocol/Web，也没有 resume 操作。
- 已增加冷启动恢复证据：command-only Stop 后持久化旧 B，重建 Store/ExecutionManager 后 B 仍不执行；新 D 到达后 B、D 作为两条 canonical user message 进入同一个 Execution，barrier 同步清除。descendant-only Stop 同样覆盖。

## Post-review fixes — 2026-07-16

- 修复 Queue 输入与 Session 删除/项目关闭的生命周期竞态：`SessionExecutionManager` 仅增加短生命周期 input-mutation admission；它不改变 `idle/running/stopping`，不参与 Queue 调度，也没有引入 pause、slot、第二个 coordinator 或新的产品状态。先进入的输入变更会阻止删除并被项目关闭检查发现；先进入的删除/关闭会拒绝新输入变更。
- `SessionInputService` 的幂等 fingerprint 改为固定 64 字符十六进制 SHA-256 digest；receipt 不再复制正文，消息 Delete 后也不会在 receipt 中残留正文。
- Web timeline 把 canonical `messages` 数组作为消息顺序权威；时间戳只用于在不重排 canonical 消息的前提下安置 compression block，pending/optimistic 气泡始终位于 canonical transcript 之后。
- HITL 等待期间恢复普通 Queue composition；只保留 command/HITL 自身的既有执行约束，不再用 `hasPendingHitl` 禁用整个 Composer。
- 增加回归测试：input mutation 对删除/项目关闭的双向 fence、digest-only receipt、非单调 canonical 时间戳的渲染顺序，以及 HITL pending 时 Composer 可输入。

## Verification

- 已通过：当前最终工作树 `bun run test`，8/8 tasks，退出码 0；Agent Core 架构测试 100/100。
- 已通过：`bun run build`，退出码 0；5 个 workspace typecheck、Web production build、308-asset manifest 与 Bun binary compile 全部完成。
- 已通过：Queue/command/Stop 定向 210/210；加强后的冷启动 `queueDispatchBarrierAt` ExecutionManager 测试 92/92；Web same-clientRequestId retry interaction 覆盖通过。
- 已通过浏览器行为验收：A 运行时 B/C 显示为普通 timeline `Queued` 气泡，仅有 Steer/Edit/Delete；B 可编辑、C 可删除；Steer 后 Stop 会 rollback 未消费消息；Stop 后发送 D，B 与 D 以两条独立 canonical user message 进入同一个 Execution，Queue 清空；没有 Queue 面板、模式切换或消息级 Send。
- 已通过：`git diff --check`。
- 已通过旧符号残留审计：生产代码中 `autoDispatchPaused`、workspace concurrency/limit、Managed forwarding、旧 `user-message`、旧 receipt 名称和 `waitForSessionCommand` 均为零。
- 已通过新概念边界审计：`queueDispatchBarrierAt` 只存在 Store schema/persistence、`SessionInputService` mutation 与 `SessionExecutionManager` admission；`cutoffAcceptedAt` 只存在 Execution/Input 批量 claim；没有新增外部 coordinator、slot、reservation 或 waiter。
- 已关闭测试进程并确认 4096、5173、8099 端口不再监听。
- 最终独立架构 Reviewer 结论：`CLEAR`。只读核验职责边界、Stop barrier、command 幂等与 abort fence、Steer mailbox、普通 Queue 气泡，以及旧 API/workspace concurrency/fallback 删除；定向 290 tests 全通过，未发现阻塞或重要架构问题。
- 最终文档一致性审计修正了 Goal 中残留的旧描述：无 active root Execution 的 command/descendant Stop 使用一次性 `queueDispatchBarrierAt`，不会回写 completed Execution；command receipt 明确为判别联合与 fail-closed at-most-once。这些是实现已证明的契约纠正，不是新增产品状态或扩展范围。
- Post-review 修复后再次通过 `bun run test`（8/8 tasks，含 Agent Core 架构测试 100/100）、`bun run build`、定向 114 tests、Web interaction 49/49 与 `git diff --check`。
- Post-review 真实浏览器 QA：构造 canonical 时间戳回退场景后，页面仍按 `First request → First answer → Queued follow-up → later message` 显示；构造 pending HITL 后，Composer 显示 `Queue a message…` 且为 enabled；浏览器 console 无 error。
