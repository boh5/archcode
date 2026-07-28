# Session Logical Execution Hard-Cut Plan Goal

> 状态：验收合同已按产品选择 A 与 `main@dc84dad3` 锁定；实施证据独立记录在 progress 文档。

## Objective

把 Session Execution 固定为一个领域概念：一次被接受的用户/Goal 工作，从首次运行开始，经过任意次数的工具调用、Steer、HITL 和同步 child 暂停/恢复，直到真正完成、失败或取消，始终只有一个 `executionId`。

同时修复同一 Execution 内 Steer 消息被 Web 提升到早期工具调用上方的问题。Web 可以把一个 Execution 投影成多个独立折叠的 Work Segment，但 Segment 只属于显示层，不进入 Protocol、持久化或调度。

本次实施是 hard cut：

- 不兼容旧 `waiting_for_human Execution -> tool_batch Execution` 数据。
- 不做 migration、fallback、dual read/write、legacy adapter 或 feature flag。
- 不增加专门证明旧数据/旧事件被拒绝的墓碑测试。
- 操作者在升级前清理旧 Session/HITL runtime 数据；生产代码不自动删除数据。

## Audited Main Baseline

方案以当前 `main@dc84dad3` 为实现基线：

- `430cfc13` 新增的 `SessionStoreManager.getSessionReadSnapshot()` 保留为 Session 详情的唯一快照读取缝隙；它只报告 reducer 事实，不修复 lifecycle。
- Session 详情中的 `executionCount/isRunning/isStreamingModel/currentExecutionId/currentAssistantMessageId` 改为权威快照字段，Web 不再靠缺失字段或只查 `running` record 猜测。
- `dc84dad3` 新增的 Execution Navigation Rail 保留交互实现，但导航数据源从 Execution record 改为 ordered Work Segment。正常情况下一个 canonical 用户消息对应一个 marker；Steer 开新 Segment/marker，HITL resume 不新增 marker。
- Navigation Rail、Scroll-to-latest 和 Workstream stabilization 必须与 ordered Segment 一起回归，不能退回旧的 user/work 双桶。

## First-Principles Model

1. **Execution 是逻辑工作单元**：只有真正终止才结束；HITL 和同步 child 等待不是终态。
2. **Tool call 必须只结算一次**：`ask_user`/permission 的回答、同步 child 的最终输出都回到原 `toolCallId`，不能先结算 waiting 再补结果。
3. **逻辑存活不等于资源占用**：Execution 可 durable suspended，同时释放模型流、Agent、AbortController 和并发 slot。
4. **恢复是同一工作的新 run**：run span 只描述一次活跃资源占用，可换模型，但不是新 Execution。
5. **显示分段不改变领域事实**：Steer 改变后续工作内容，因此开启 Work Segment；它不创建 Execution。

Codex 的 `request_user_input` 和 OpenCode 的 question tool 都把回答留在原逻辑 turn/tool call。ArchCode 保留该语义，同时利用 durable Tool Batch 释放内存调用栈。

## Locked Definitions And Ownership

| 概念 | 唯一职责 |
| --- | --- |
| Session | 持久对话、Agent 身份、上下文与工作历史 |
| Execution | 一次被接受的逻辑工作；可跨多次 suspend/resume |
| Run span | Execution 内一次活跃运行区间；只有稳定 ordinal，没有公开 ID/API/service/table |
| Suspension | Execution 内嵌的等待原因；不是独立实体 |
| Tool Batch | 模型产生的工具批次、blocked/dependency call、response 与 recovery checkpoint |
| HITL record | 项目级人类请求、回答和 delivery；不拥有 Execution 生命周期 |
| Child link | parent tool call 与 durable child Session 的关系 |
| Work Segment | Web 按 canonical 用户输入边界生成的只读显示投影 |

职责边界固定：

- `SessionExecutionManager` 独占 Execution start/suspend/update/resume/end、logical family gate、resume admission、slot、abort 和 Stop。
- `SessionToolBatchScheduler` 独占 batch/call checkpoint、HITL response application、child dependency 与 exactly-once tool result。
- `ProjectHitlQueue` 只拥有人类请求、回答、delivery 与通知。
- `QueryLoop` 只返回本次 loop 为 suspended 或 terminal，不写 durable lifecycle。
- `SessionStoreManager` 严格读写当前 schema 和 reducer state，不再做 lifecycle repair。
- Protocol reducer 只投影合法 lifecycle event；Web 只消费投影，不拼接后端 Execution。

不新增 ResumeCoordinator、Activation service、HITL journal、workflow engine、Execution lineage 或第二套状态机。

新的 user-message batch、Goal continuation，以及 child 的新任务会创建新 Execution。Steer、HITL 回答、同步 child 恢复不会创建新 Execution；`tool_batch` 从 `SessionExecutionOrigin` 删除。

## Durable Lifecycle Contract

### State machine

```text
running
  | blocked tool/dependency
  v
suspended(hitl | child_dependency)
  | exact response/dependency becomes terminal
  v
suspended(resume_pending)
  | resume admission
  v
running

running | suspended -- Stop/failure --> terminal
```

`SessionExecutionSuspension` 是 record 内嵌的严格 union：

```text
hitl {
  toolBatchId,
  blockerIds: non-empty unique sorted ids
}

child_dependency {
  toolBatchId,
  toolCallId,
  childSessionId,
  childExecutionId
}

resume_pending {
  toolBatchId,
  readyAt
}
```

最后一个 HITL 回答已应用、或同步 child 已终止但尚未取得 resume admission 时，必须持久化为 `resume_pending`；不能伪装成仍有 blocker，也不能只靠一次内存 wake。

### Protocol events

- `execution-start { executionId, origin, maxSteps, activeTimeoutMs?, binding }`：创建 record 和 ordinal 0 run，恰好一次。
- `execution-suspended { executionId, suspension, runEndedAt, runUsageDelta }`：仅 `running -> suspended`；以 payload 的业务时间关闭当前 run。
- `execution-suspension-updated { executionId, suspension }`：仅 suspended 内更新 blocker 或进入 `resume_pending`，不创建/关闭 run。
- `execution-resumed { executionId, runOrdinal, binding }`：仅 `resume_pending -> running`；`runOrdinal` 必须精确等于 `runs.length`，再开启下一 run。
- `execution-end { executionId, terminalStatus, endedAt, runEndedAt?, runUsageDelta?, error? }`：从 running 或 suspended 进入真实终态，恰好一次。

所有事件都显式携带 `executionId`。真实终态只有：

```text
completed | max_steps | failed | aborted | cancelled | timed_out | interrupted
```

`waiting_for_human` 不再属于 `ExecutionEndEvent`；它只可作为 HITL/child/UI presentation。

### Execution record invariants

`SessionExecutionRecord` hard cut 为：

- `status: running | suspended | terminalStatus`。
- `startedAt` 只记录首次启动；`endedAt` 只在 terminal 存在。
- suspended 必须有 `suspension`；running/terminal 禁止该字段。
- `maxSteps` 是整个逻辑 Execution 的总步数上限，resume 不重置。
- child Execution 可有首次 admission 固定的 `activeTimeoutMs`；其预算按累计 run active time消费。
- `runs` 顺序保存 `{ ordinal, startedAt, endedAt?, durationMs?, binding, usageDelta? }`；ordinal 从 0 连续且等于数组位置。
- `durationMs` 等于所有 run duration 之和，不含 HITL/child 等待。
- 删除顶层单一 `binding`、`blockedByHitlIds` 和 `tool_batch` origin。

Lifecycle payload 的 `runEndedAt/endedAt` 是业务有效时间，SSE envelope/append timestamp 只是观察时间。正常路径在真正停止 live run 时捕获；startup recovery 从最后一个能证明 active work 截止的 durable checkpoint 取值，并 clamp 在该 run 的 `[startedAt, recoveryObservedAt]` 内，绝不使用重启时刻扩大 active duration。

每个 Tool Batch call 必填一个 `checkpointAt`，与 queued/running/blocked/dependency/settled 的真实状态推进原子写入；HITL ID、delivery 和缺失消息等启动修复只能保留该值，不能用重启时间覆盖。

任意时刻：

- running 恰好一个未关闭 run；suspended/terminal 没有未关闭 run。
- 同一 Session 最多一个非终态 Execution。
- `currentExecutionId` 在 running 和 suspended 都指向该 E，terminal 才清除。
- `isRunning` 只表示 live run；suspended 时为 `false`，`isStreamingModel` 也为 `false`。
- `currentAssistantMessageId` 在 suspend 时保留，并可由 active batch 的 `assistantMessageId` 冷启动重建；terminal 才清除。
- `executionCount` 始终等于逻辑 record 数，resume 不增加。

### Transition validation and replay

共享 `validateExecutionTransition()` 返回 `valid | duplicate | invalid`：

- Manager 本地 append 对 invalid 抛错并禁止持久化。
- 相同 payload 的重复 start/suspend/update/resume/end 是 deterministic no-op。
- 冲突 duplicate、wrong ID、已有非终态时 start、running 时 resume、非 `resume_pending` 时 resume、terminal 后任何非重复 lifecycle 都是 invalid。
- Web 对 duplicate no-op；对 invalid lifecycle 不改 state，记录诊断并失效 Session query，从权威快照恢复。
- SSE envelope cursor 先去重；transition validator 仍作为乱序/损坏的最后防线。

`execution-suspended` 不调用 terminal cleanup，不完成 assistant message，也不 settle blocked tool part；只有 `execution-end` 做一次 incomplete-state cleanup。

## Runtime Semantics

### HITL suspend and resume

1. Scheduler 先把 blocked call 与稳定 `requestKey` 写入 batch，再幂等创建 Project HITL，并把 `hitlId` 回写 batch。
2. QueryLoop 返回 suspended；Manager 关闭 Steer gate，等待已 claim 的 Steer 提交到同一 E。
3. Manager 写 `execution-suspended(hitl)`、关闭 run、持久化 usage/time，然后释放 live 资源。
4. 每个回答以 `hitlId + requestKey + toolCallId` 精确写回原 call。仍有未回答 blocker 时，只更新 `blockerIds`，不抢占 run。
5. 最后一个 blocker 的回答 durable applied 后，Manager 写 `resume_pending`；Project HITL delivery 随后幂等标为 applied。
6. resume claim 从 active batch 读取原 `executionId`，重新执行 scope/permission/admission 检查，取得 slot 后写 `execution-resumed`。
7. Scheduler 通过原 call 的 resume path 结算结果；approved effectful call 只执行一次，然后 QueryLoop 从原 batch 后继续。

普通 start 不能接收旧 ID；resume 不能创建 record。瞬时 admission 失败保留 `resume_pending`，永久 scope/batch 不一致以同一 E `interrupted` 并进入 manual inspection，绝不创建补偿 E。

### Product choice A: synchronous child dependency

`delegate(background=false)` 和 `resume_session(background=false)` 保持现有公开契约：等待并向模型返回 child 的一次最终输出。

- 在创建 child Session 之前，Scheduler 先在 parent Tool Batch call 写入 `child_launch` intent；它固定 `parentExecutionId/runOrdinal/toolCallId/childSessionId/childExecutionId`。intent identity 直接使用 `parentExecutionId + toolCallId`，恢复时对既有 tool input 和这些 ID 做结构相等校验，不另造 fingerprint/hash 合同。
- Manager 只能消费该 intent 幂等创建或观察 exact child；child Session、Execution 和 link 都使用这些预分配 ID。child link 持久化 `childExecutionId`，不能只靠 childSessionId 或数组位置关联。
- child 正常运行时，parent 可继续保持当前等待栈，行为与现在一致。
- child 一旦 suspended，child 当前 run handle 返回内部 suspended outcome；既有 launch intent 转成 durable `child_dependency` blocker，parent E 随后 suspend 并释放资源。
- 该 blocker 属于 parent Tool Batch，不创建 Project HITL；HITL attention 仍由 child 的准确记录提供。
- child 每次恢复仍使用它自己的同一 E；parent 保持 `child_dependency`，不会因 child 的中间 run 被唤醒。
- child 真实 terminal 后，Scheduler 把 parent 原 call 标为可恢复，Manager 将 parent E 改为 `resume_pending`。
- parent resume 后，Registry 走 descriptor 的 dependency-resume 分支读取已持久化 child outcome；不得再次创建/恢复 child，原 `toolCallId` 只 finalization 一次。
- background child 不建立 parent dependency；parent 已经拿到 Session ID，仍通过 terminal reminder/background_output 取结果。

Tool execution 内部结果因此区分 settled、human-blocked、child-deferred；只有 settled 进入 Raw-to-Finalized。该 union 只存在 Tool Registry/Scheduler 边界，不成为公开工具协议或通用异步框架。

若在 intent 后任一写入边界崩溃，startup 先用稳定 `runEndedAt` 将失去 live 调用栈的 running parent 写成 `suspended(child_dependency)`，再按 exact IDs 对账 child。该 durable intent 在 parent 已 suspended 后仍授权 exact child 的补建/首次启动，不要求 live running parent：

- child Session 不存在：用预分配 ID 幂等创建 Session、Execution 和 link，并启动 exact child。
- child Session 已创建但未 start：补齐 link 并启动预分配的 child Execution。
- child E 持久为 running：先按 child 自己的 canonical batch恢复为 suspended 或 terminal；不可恢复的未知 model/effect 才 interrupted，startup barrier 后不得留下无 live resource 的 running。
- child suspended：parent 保持 `child_dependency`。
- child terminal：parent 先确保已是 `child_dependency`，再用 suspension update 进入 `resume_pending`。

任何路径都不得重新分配 child、再次执行 launch side effect，或从 running parent 非法直跳 `resume_pending`。

### Logical family gate and liveness

资源空闲不等于逻辑 idle。Manager 明确区分 ordinary admission 与 continuation admission：

- 任一非终态 Execution 都阻止普通 Queue、Goal continuation、command 或无因新 admission。由当前 running parent tool call 的 durable launch intent 授权的新 child 仍按既有 child policy/concurrency 入场。
- 已存在 Execution 的 continuation resume 不是 ordinary admission。`resume_pending` child 可以越过仅由其 exact `child_dependency` chain 构成的 suspended ancestors；ancestor 不能把自己等待的 descendant 锁死。
- 三层以上 dependency chain 从最深的 ready descendant 开始恢复；只有 exact child terminal 后，它的直接 parent 才进入 resume_pending。
- unrelated background sibling 的 continuation 不穿越别人的 dependency 关系，但仍可按既有 workspace/per-parent concurrency 取得自己的 slot；不能因为 family 内另一个非终态 E 被当成新工作拒绝。
- `SessionFamilyActivity` 扩展为 `idle | running | waiting_for_human | resuming | stopping`。多状态并存时 presentation 优先级固定为 `stopping > waiting_for_human > running > resuming > idle`；admission 始终读取全部 durable nonterminal facts，不能只看该 presentation 值。
- Manager 的 resume reconcile 优先于普通 queued input，且只能 claim canonical `resume_pending`。
- reconcile 触发点固定为：HITL response applied、同步 child terminal、Runtime startup、slot release、family control release、input mutation release。
- 同一 candidate 的并发 wake 由 Manager claim fence 合并；瞬时失败留待下一触发点，不允许 fire-and-forget 日志后永久搁置。
- 普通消息在 suspended 期间照常 durable queued，只能在原 E terminal 后创建新 E。

这只是 `SessionExecutionManager` 内的 admission/reconcile 分支，不新增 scheduler service。

### QueryLoop, model and timeout continuity

- `QueryLoopResult` 是 `suspended | terminal` discriminated outcome，不能复用 terminal status 表示暂停。
- `SessionStep`、canonical message、Tool Batch 和 Prompt trace 都记录 `executionId + runOrdinal`。
- resume 的下一模型 step 从该 E 已持久化 step 最大值继续；batch continuation 不把 step 归零。
- `maxSteps` 对全部 runs 合计生效，任何 resume 都不能越过首次上限。
- 每个 run 在 admission 时按当前 Session/Profile/ModelRuntime 解析 binding；同一 live run 内不可热换。
- message 的 actual model selection 必须精确等于 `runs[runOrdinal].binding`；“匹配任意 run”不合格。
- 原 batch 的 `allowedTools/agentSkills` 与当前权限取交集；换模型不能扩大待恢复 call 权限。
- `afterLoopEnd` 接收 suspended/terminal outcome。Todo continuation 只允许 terminal completed；Memory、cwd、model recovery 和 final response 路径不得把 suspend 当 terminal。
- child `activeTimeoutMs` 消耗所有 run 的累计 active duration；HITL/parent 等待不计时，resume 只调度剩余预算，不能每次重置。

### Accounting exactly once

- 每次关闭 run，先在 owning Session 的 run record 持久化规范化 `usageDelta/durationMs` 和确定性 settlement key：`run:{sessionId}:{executionId}:{runOrdinal}`。
- 逻辑 terminal 另有 `terminal:{sessionId}:{executionId}` key；Goal executionCount 只由该 key 增加一次。
- settlement 同时捕获当时可归属的 `goalInstanceId`；没有 Goal 时明确记为不归属，后续新 Goal 不追溯吸收。
- Goal 只增加一个内嵌、按 instance 隔离的 receipt 集合，不新增 ledger service/table。相同 key 重放为 no-op。
- 顺序固定为：Session settlement durable -> Goal service 幂等应用并写 receipt -> Session 标记 applied。启动时重放尚未 applied 的当前格式 settlement。
- 在未结算项对账完成前，不允许清除/替换对应 Goal instance；编辑同一 instance 不受影响。
- Session stats 仍由 canonical steps 生成；run delta 可从相同 runOrdinal 的 steps 校验/重建。

这样即使在 Goal 文件写入前后崩溃，也只会漏一次待重放标记，不会丢记或重复累计。

### Stop and current-format recovery

Stop：

- running：沿当前 abort generation 收敛 Steer/Tool Batch，对同一 E 写一个 terminal end。
- suspended HITL：取消未决 HITL、归档 batch、settle terminal tool UI 后直接 terminalize，不先 resume。
- suspended child dependency：按同步 abort cascade 取消/收敛 child subtree 和 link，再 terminalize parent；同一 tool call 不产生“最终成功”结果。
- suspended resume_pending：撤销 resume candidate 并直接 terminalize。
- suspended/resuming 时 Web Stop 始终可用。
- 单独 Stop child 只 terminalize child；parent dependency 随后进入 resume_pending，并从原 tool call 收到 cancelled child outcome。Stop parent/family 才按 abort cascade 同时取消两者。

Startup recovery 的唯一 lifecycle writer 是 Manager；Store load 只返回严格当前格式事实。Runtime 对外开放 route/admission 前完成：

1. 读取 Execution/Tool Batch/child intent/HITL 后先判定可恢复 E，并为每个 running run 计算稳定 `runEndedAt`；停机时间不能进入 active duration/timeout。
2. 对 `state=steering` 且仍指向该可恢复 E 的 durable claim，按其 `executionId + runOrdinal + modelAudit` 提交回原 E；`claimedAt` 只决定多个 claim 的顺序与幂等身份。恢复消息的 canonical commit boundary 使用排在它之前的 durable Work 全部结束后的稳定边界，通常就是该 run 的 `runEndedAt`；连续 recovered Steer 共享该边界并保持同一 input batch。只有目标 E 已 terminal 或不可安全恢复才 rollback Queue。
3. `running + canonical blocked batch`：修复缺失 HITL ID，写同一 E suspended；不能 blanket interrupted。
4. `running + child_launch/child_dependency`：先关闭 parent run 并写 `suspended(child_dependency)`，再按 exact child IDs补齐或观察 Session/start/link；child 自身先完成 running orphan recovery，随后 suspended 则 parent 保持 dependency，terminal 则 suspension update 为 resume_pending。
5. `running + model continuation/effectful outcome unknown`：同一 E interrupted/manual inspection，不自动重放。
6. `suspended(hitl) + unresolved blocker`：保持；全部 response applied 则转 resume_pending。
7. `suspended(child_dependency) + child nonterminal/terminal`：分别保持或转 resume_pending。
8. `resume_pending`：按 continuation admission matrix 进入幂等 resume reconcile。
9. 无 canonical batch/call/Execution 的 orphan HITL：系统取消并变成非 actionable；相关 E 同一条 interrupted。

通用 `recoverOrphanedSteers()` 的 blanket rollback 路径删除；Steer claim 必须持久化 `executionId/runOrdinal/modelAudit/claimedAt`。`claimedAt` 不作为 Segment cut；恢复提交生成的 canonical message 使用 post-prior-work 的 durable effective boundary，不能用 claim time 或重启时间污染内容归属与 Segment duration。

冷启动快照随后满足：

- 唯一非终态 E 重建 `currentExecutionId`。
- active batch 重建 `currentAssistantMessageId`。
- suspended 为 `isRunning=false/isStreamingModel=false`，但 family activity 不是 idle。
- Web snapshot、Global SSE family snapshot 与 Manager gate 对同一状态给出一致结果。

这些是当前格式写入边界的 crash recovery，不是 migration、compatibility 或 fallback。

> **Superseded for Web display.** The ordered Work, Assistant phase, adjacent
> UserMessage, and Reasoning-usage clauses in this section are superseded by
> `session-workstream-message-phase-hard-cut-plan-goal.md`. This goal remains
> authoritative for Execution lifecycle, suspension, recovery, and duration.

## Web Ordered Work Segments

Web 在每个 Execution 内严格遍历 canonical `messages` 数组，禁止按时间重排：

1. input batch 是消息数组中的最大连续 canonical user-message 序列；任何非用户内容（assistant text、reasoning、tool、child 等）都会关闭 batch。
2. user message 出现在已有 Work 后，关闭旧 Segment，并从新 input batch 开启下一 Segment。
3. 到下一 input boundary 或 Execution 结束前的内容都归当前 Segment；其中 reasoning/tool/child 是可折叠 work，assistant text 是该段始终可见的模型输出。
4. 可信 terminal final response 归最后一个 Segment，位于其 Work disclosure 之后；不折叠，也不脱离 Segment重复渲染。
5. 没有先导 canonical input 的 Work 使用稳定 implicit Segment；tool-run 聚合绝不跨 Segment。

Segment ID 由 Execution ID 与首个 canonical message ID 构造，不用数组下标；implicit Segment 使用 Execution ID 加固定 `implicit` suffix。UI 合同：

- 每段 input 和 assistant output 始终可见；只折叠该段 Work disclosure。
- 历史 Segment 的 Work 默认收起；最新 active/suspended Segment 的 Work 默认展开。
- 每个关闭或 suspended Segment 都显示自己的 `Worked for X`；live Segment 显示 `Working for X`。`Needs you`、`Waiting on child`、`Resuming` 是独立状态，不替代 duration。
- terminal final response 只归最后一个 Segment；Execution terminal status 和总统计仍只展示一次。
- AskUser/Permission answer 是 tool result，不是 canonical user message，不创建 Segment。

Duration 使用一次投影的共同 `snapshotNow`：

- 第一个 cut 为 E.startedAt；后续 cut 取新 Segment 首个 input batch 的 canonical commit/completed time。
- cut 按消息数组顺序单调 clamp；相同 timestamp 以数组顺序切分，允许零时长 Segment，不用 `createdAt` 猜测。
- terminal end 或 `snapshotNow` 是最后 cut。
- Segment duration 是其 wall-clock window 与全部 run intervals 的交集和；这些 window 完整覆盖且不重叠，因此总和必须精确等于同一快照的 E active duration。

Navigation/Inspector：

- Workstream DOM 仍是一条 E 一个外层 `<article>`，但每个 Segment `<section>` 拥有自己的 navigation target。
- Rail 按 Execution/message 顺序 flatten `WorkSegmentProjection[]`；marker 数等于 canonical input batches 数，只有无 input 的 implicit Segment使用一个 fallback marker。
- marker 摘要取对应 input batch；正常 user message 与 Steer 都新增 marker，AskUser answer、HITL/tool-batch resume 不新增。
- Rail 出现阈值、当前位置、roving tabindex、jump 和 tooltip 都按 Segment 计算；`tool_batch continuation` label 分支删除。
- Inspector 仍把 Execution 作为领域聚合并按 runOrdinal 展示 bindings；Segment marker 保存 parent executionId 和 input message IDs，使 message audit 跳到准确 run。

删除 `SessionExecutionInputCheckpoint`、`projectSessionExecutionInputCheckpoints()`、`continuationExecutionId`、正常 UI 的 `Continued in Execution N`，以及旧 `splitExecutionMessages()` user/work 双桶。

## Implementation Plan

1. **Protocol/store hard cut**
   - 落地五类 lifecycle event、suspension union、runs/maxSteps/timeout/settlement 和 transition validator。
   - 更新 strict Session schema、guards、Protocol/Web reducer；删除 waiting terminal、tool_batch origin、顶层 binding 和 input checkpoint。

2. **Manager lifecycle and snapshot ownership**
   - 将普通 start、suspend、suspension update、resume claim、terminal 分成清晰私有分支。
   - 把 `getSessionReadSnapshot()` 接到 Manager startup reconciliation barrier；重构 family activity、queue gate、Stop、slot/Agent release和 cold-load live fields。

3. **Tool Batch/HITL/child dependency**
   - 收敛 human blocker 与 child dependency 的 durable call union和 resume path。
   - 实现多 blocker、choice A 同步 child、权限重检、exactly-once finalization、dependency wake 与 crash reconciliation。

4. **QueryLoop/model/accounting**
   - 持久化 runOrdinal，连续 step/maxSteps，按 run 解析 binding 和 child 剩余 timeout。
   - 将 Goal run/terminal settlement 改为先 Session、后幂等 receipt，并加入启动对账。
   - 审计 hooks、cwd、tool continuation、model recovery、child links和 reminders。

5. **Web ordered segments**
   - 用 ordered Segment projection 替换双桶；实现独立折叠、状态和完整 duration partition。
   - 让 Navigation Rail 直接消费 ordered Segment，适配新增 Session live snapshot、ChatInput Stop、Dashboard/Todo 状态、Scroll-to-latest和 Inspector。

6. **Cleanup and verification**
   - 删除旧字段、helpers、exports、分支和只服务旧语义的测试；不留 fallback/compat/tombstone test。
   - 更新 `AGENTS.md`、`docs/concepts.md` 与冲突的活动 goal 文档。
   - 完成定向/全量测试、crash injection、浏览器 QA、literal audit 和独立最终 review。

## Non-Goals

- 不改变 ask_user/permission 的问题 schema、redaction 或 ProjectHitlQueue delivery 模型。
- 不把 run、suspension、receipt 或 Work Segment提升成用户工作项、公开 API 实体或独立服务。
- 不改变 background delegation 的异步结果合同。
- 不允许 `resume_session` 绕过非终态 child HITL；它仍只为 terminal/stopped child 创建明确的新工作。
- 不自动删除 Memory、Todos、Automations、Config 或其他非 Session/HITL 数据。

## Risks And Required Controls

| 风险 | 必须控制 |
| --- | --- |
| 回答 applied 后无 blocker 又无法 resume | durable `resume_pending` + 多触发点 reconcile |
| slot 空闲被误判 family idle | durable nonterminal gate；resume 优先普通 admission |
| blocker 已发布但 suspend event 未写 | Manager startup 先按 batch/HITL/Steer 对账，再处理 running orphan |
| 同步 child waiting 先结算假结果 | parent dependency blocker；同一 call 只在 child terminal 后 finalize |
| parent suspended 后 child resume 自锁 | ordinary/continuation admission 分离；exact dependency descendant 可恢复 |
| child 已创建但 parent 无 durable correlation | create 前持久化 child_launch intent 和 exact child IDs |
| 崩溃后 parent 无调用栈却保持 running | startup 先写 child_dependency 关闭 parent run，再按 child 五态对账 |
| resume 重置 step/model/timeout | runOrdinal、持久 maxSteps、per-run binding、剩余 active timeout |
| 重启时间污染 active duration | lifecycle 使用 durable `runEndedAt`，不使用 recovery wall clock |
| recovered Steer 抢走旧 Work 的 duration | claimedAt 只排序；cut 使用 post-prior-work durable boundary |
| usage/count crash 后重复或丢失 | deterministic key + Goal receipt + startup replay |
| suspend 清掉原工具/assistant 状态 | suspend reducer不做 terminal cleanup；冷启动从 active batch 重建 |
| suspended Stop 消失或普通消息越界 | `currentExecutionId` 保留、family 非 idle、Stop 可用、消息只入 Queue |
| Segment duration/顺序错误 | array-order cuts + run interval完整分区，禁止 createdAt 排序 |
| Navigation Rail 仍绑定 Execution record | Rail 只消费 ordered Segment；Steer 有 marker，HITL resume 没有 |
| 重构残留两套语义 | strict schema + literal/import audit；无 fallback/compat/legacy tests |

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部有代码、测试和审计证据；任一缺失即为 `NOT_DONE`。

### AC-01：状态机唯一且严格

- 一个含两次 HITL 的工作只有一个 record、一个 start、两次 suspend、对应 suspension update/resume和一个 end；所有 ID 相同。
- `waiting_for_human` 不在 terminal union，`tool_batch` 不在 origin；record 严格满足 run/suspension/currentExecutionId invariants。
- transition matrix 覆盖所有合法边、exact duplicate、conflicting duplicate、wrong ID、duplicate start/suspend/end、running resume、非-ready resume、terminal 后事件和 SSE replay。
- Manager invalid append 不落盘；Web invalid event 不改 state并触发快照 resync。

### AC-02：资源释放、family gate、快照和 liveness

- suspend durable flush 后，live map、Agent/stream、workspace/child slot、AbortController/listener 均释放；currentExecutionId/assistant ID 保留，isRunning/isStreamingModel 为 false。
- suspended/resume_pending family 在 Session detail、Global SSE、Dashboard/Todo/导航中都不显示 idle。
- answer、child terminal、startup、slot/family/input release 都会幂等重试 resume；容量不足后释放 slot 可自动继续，无需第二次用户操作。
- resume claim 优先普通 queued input；竞争 wake 最多写一个 resume/run。
- parent suspended 等 child 时，child continuation 可穿越 exact ancestor dependency；三层链按最深 ready descendant 先恢复，background sibling 仍遵守既有 slot/concurrency。
- 刷新和冷启动从唯一非终态 E + active batch恢复全部 live snapshot 字段，不使用缺失字段 fallback。

### AC-03：Ask User、Permission 与 Tool Batch 是原调用

- ask_user `prepareBlock -> answer/cancel -> resume -> finalized` 全程使用同一 executionId/batch/toolCallId/requestKey，恰好一个 settled result。
- permission approve/deny/cancel 同理；approved effectful call 只执行一次。
- 同批两个 blocker 的分别、反序、重复和冲突回答均有测试；未全部回答时不抢 run，最后回答后进入 resume_pending。
- 原 `allowedTools/agentSkills` 与当前权限交集有正反测试；换模型不能扩大权限。
- suspend event 前的 Steer 已提交到原 E；之后新消息 queued，并且原 E terminal 前不创建新 E。

### AC-04：选择 A 的同步 child 合同闭合

- sync delegate 的实际链路为：parent running -> child suspended -> parent child_dependency -> child resume/terminal -> parent resume_pending/running -> 原 tool call final。
- child Session 创建前已有 durable launch intent，parent call、child Session、child Execution 和 child link 共享 exact IDs；重复恢复不能创建第二个 child。
- crash recovery 覆盖 child absent、created-no-start、running、suspended、terminal 五态：parent 先合法进入 child_dependency；barrier 后没有 resource-free running、running 直跳 resume_pending 或第二个 child。
- parent 模型只看到一次 child 最终输出；没有 waiting 假结果、重复 child、重复 finalization 或 background reminder。
- sync resume_session 具有相同 dependency 语义；background=true 不挂起 parent，仍由 reminder/background_output 交付。
- child link waiting 阶段无 terminal endedAt/reminder；child terminal 后恰好一次 terminal link。
- Stop parent、Stop child、child failed/cancelled/timed_out/interrupted 和 parent/child 各写入边界崩溃都有确定结果。

### AC-05：step、model、hook、timeout 与 accounting 正确

- resume 后的 step 游标必须严格继续，禁止同一 Execution 的同一 step 跨 run 重用；同一 run 内的模型 retry 可复用当前 step，且不引入 attempt 领域字段。全部 runs 合计不超过首次 maxSteps。
- 两个 run 可使用不同模型；message/step/batch 的 runOrdinal 与准确 binding 对应，把 A 消息标成合法 B binding 必须失败。
- Todo/Memory/cwd/model recovery/final response 测试证明 suspend 不触发逻辑 terminal 行为。
- child 运行 2s、等人 30s、再运行 3s 时 active timeout/Execution duration 为 5s；resume 不重置 timeout。
- 进程停机 30s 后恢复 blocked/dependency E，不增加 Execution、Segment 或 DelegationCard active duration，也不消耗 child timeout。
- 每个 run/terminal settlement key 唯一；重复 callback、Goal 写前崩溃、写后未标 applied 崩溃和 startup replay 后，tokens/time/count 都恰好一次。
- Goal executionCount 只在逻辑 terminal 增一；suspend 后 Stop 也只计一个 E。

### AC-06：Stop 与 crash recovery 不产生第二条语义

- running、hitl suspended、child suspended、resume_pending 四种 Stop 都只 terminalize 原 E一次，并收敛 batch/HITL/link/tool UI。
- crash injection 覆盖：Steer claim/mailbox/commit、blocked call、HITL create、hitlId 回写、suspend event、response applied、resume_pending、child launch intent/Session/start/link/suspend/terminal、parent finalization、Goal receipt各 durable 边界。
- `running + blocked batch` 恢复为同 E suspended；suspended runnable 同 E resume；未知 effect/model continuation 同 E interrupted/manual inspection。
- 指向可恢复 E 的 durable Steer claim 提交到原 `executionId/runOrdinal`；仅 terminal/不可恢复目标 rollback，且 recovery wall clock 不改变其 Segment cut。
- Steer claim 后仍有 durable tool output 再 crash 时，该 Work 仍属于旧 Segment；recovered Steer 在 post-prior-work boundary 开新 Segment，连续 recovered Steer 仍是一个 input batch，全部 duration 精确分区。
- orphan HITL 不可继续回答；任何 recovery 都不创建 tool_batch/补偿 Execution，也不自动重放未知 effectful call。
- Store load 没有 lifecycle mutation；架构测试证明只有 Manager 写 start/suspend/update/resume/end。

> **Superseded for Web display.** The Work/Assistant-output, adjacent-input,
> and Reasoning display clauses in AC-07 are superseded by
> `session-workstream-message-phase-hard-cut-plan-goal.md`; its lifecycle and
> duration clauses remain historical acceptance evidence for this goal.

### AC-07：Work Segment、状态与导航显示准确

- 原回归场景严格显示：初始输入 -> 早期工具/推理 -> Steer -> 后续工具/推理 -> final；SSE、刷新和冷启动一致。
- 最大连续 canonical user-message 序列合并为一个 input batch/Segment/marker；出现任意非用户内容后，下一 canonical user/steer 必须开新 Segment；leading-work E 只有一个 implicit Segment。
- 每段独立 timeline/折叠/status/duration；所有 Segment duration 精确等于同快照 E active duration，人类/child 等待贡献 0。
- 每段展示自身 Worked/Working duration；Needs you/Waiting on child/Resuming 独立呈现。suspended 时 Stop 可用，composer 输入只入 Queue。
- 每段 input 与 assistant output 始终可见，只有 Work disclosure 折叠；terminal final 只出现在最后一个 Segment，总统计不重复。
- 一个 E 包含初始输入和两次有 Work 边界的 Steer 时，必须产生三个 marker；点击后分别定位三个 input batches。
- AskUser/Permission answer、HITL suspend/resume 不开 Segment/marker；implicit Segment 才使用 fallback marker。
- Rail threshold、current marker、jump、keyboard、tooltip、scroll stabilization 按 Segment 工作；Inspector 仍只保留一个 parent E 聚合。
- child link/DelegationCard duration 同样取 child Execution run active duration，不包含 HITL 或 parent 等待。
- Web/Protocol/Store 不再存在 Execution input checkpoint、continuationExecutionId 或正常 continuation UI。

### AC-08：hard cut 与最终交付

- 生产代码不存在旧 execution-end waiting、HITL answer -> ordinary start、tool_batch origin、continuation stitching、legacy adapter、migration、dual read/write、feature flag 或 unknown-field fallback。
- 不新增 legacy/compat/migration test，也不新增只断言旧 payload 被拒绝的墓碑测试；原旧语义测试删除或改写为当前正向合同。
- 活动架构文档全部更新；历史 progress 仅保留历史属性。
- `bun run typecheck`、Agent Core unit/integration/arch、Web 定向测试、`bun run test`、`bun run build`、`git diff --check` 全部 exit 0。
- 浏览器至少验收 desktop 和 390px：Steer 顺序、多 Segment、Needs you、Waiting on child、Resuming、回答后同块继续、suspended Stop、刷新、无横向溢出、零新增 console error。
- fresh independent `sol(xhigh|max)` Reviewer 按 AC-01 至 AC-08 审查最终实现；存在 blocking/high 即 `NOT_DONE`，修复后必须重新 review。
