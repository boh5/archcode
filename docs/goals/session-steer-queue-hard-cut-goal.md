# Session Steer 与 Queue 一刀切实施计划

> 状态：已按产品反馈和架构复审重新收敛。本文是实现契约，不是候选方案集合。
>
> 核心语义：普通发送默认进入当前 root Session 的 Queue；当前 Execution 成功完成后，Queue 中当时所有消息作为一个批次进入下一次 Execution；用户可以把其中一条 queued 消息改为 Steer，使其进入当前 Execution。Stop 只停止当前工作，不清空 Queue，也不产生暂停状态。

## 1. 已锁定结论

1. 继续使用现有 `Session`、`Execution`、`Message`，不新增用户或领域层 `Turn`。
2. 不新增 `SessionFamilyTurnCoordinator` 或其他总协调器；live Execution 仍由 `SessionExecutionManager` 唯一管理。
3. Composer 始终是普通发送。Session 忙碌时消息自然显示为 `Queued`，不提供“加入队列”按钮、发送模式切换或设置项。
4. queued 消息气泡提供 `Steer`、`Edit`、`Delete`；不提供消息级 `Send`、Resume 或独立 Queue 面板。
5. 如果 A 正在运行，B、C 已 queued：
   - A 成功完成后，B、C **一起**进入同一个下一次 Execution；
   - B、C 保持两条独立消息，不拼接正文，也不是 B 一个 Execution、C 一个 Execution。
6. 如果 A 正在运行，B、C 已 queued，用户 Stop 后再发送 D：
   - Stop 只结束 A 及其仍在运行的 descendants；
   - B、C 原样留在 Queue；
   - D 先追加到 Queue，然后 B、C、D 一起进入同一个新 Execution。
7. 不新增 `autoDispatchPaused`、`dispatch=auto|held` 或任何 Session 暂停状态。Stop 是终止，不是暂停；有 active root Execution 时在该 record 上保存 `stopRequestedAt`。若 family 活跃但没有 active root Execution（例如只剩 descendant 或正在执行 Slash command），Session Input 仅保存一次性的 `queueDispatchBarrierAt` 截止事实，下一批 Queue 启动时即清除。
8. 删除现有 workspace 级并发上限及其派生设计：没有 workspace slot、reservation、arbiter、公平调度队列或 capacity waiter。
9. Queue 保存完整消息对象。ID 只用于身份、CAS、Edit/Delete/Steer 和幂等，不用于让 QueryLoop 回查正文。
10. Queue 批次启动时，消息先由 Store 原子移入 canonical transcript；QueryLoop 继续只读取 canonical `messages[]`。
11. Web 保留来源窗口的本地 `Sending…` 气泡；服务器持久化确认后由同一 `clientRequestId` 原地接管，不产生第二个气泡。
12. 旧 Session 数据无需兼容或迁移，本功能按新 schema 硬切。
13. 新增且只新增一个 Queue 领域模块 `SessionInputService`；它负责 durable message 状态迁移，不负责启动、停止或调度 Execution。
14. `Agent.run(userMessage)`、`runQueryLoop(..., userMessage)` 必须硬切为“输入已在 Store 中”的运行契约，不能为了兼容保留双入口。
15. Session event 发布必须脱离 Execution 生命周期；idle Queue 的 Accept/Edit/Delete 也必须能实时到达 Web。
16. Automation 只确认消息是否 durable accepted；不再预分配、查询或持有该消息对应的 `executionId`。
17. V1 Queue/Steer 只属于 root Session；child focused view 保持只读，delegate/resume 使用 typed direct input，不建立多个 family Queue。

## 2. 第一性原理

### 2.1 三个实体已经足够

| 实体 | 责任 | 不负责 |
| --- | --- | --- |
| Session | 持久对话、Queue、消息身份和历史 | 不表示一次运行 |
| Execution | 一次可停止、可完成的运行 | 不长期保存未处理输入 |
| Message | 用户意图及其投递状态 | 不拥有调度器 |

Queue 是 Session 中“尚未进入模型 transcript 的用户消息”，不是独立 Inbox、任务系统或 Execution 列表。

Steer 是 queued message 的一次投递选择：从“下一次 Execution”改到“当前 Execution”。它不是第二种消息实体，也不是 interrupt。

### 2.2 正确的并发边界

保留：

- 同一个 Session 同时只能有一个 active Execution；
- 单个 Agent 的 child concurrency 和 delegation depth；
- Session family Stop/Delete/cwd/HITL/Tool Batch 的现有一致性保护。

删除：

- 同一 workspace 最多 4 个 active Session 的隐藏限制；
- `maxConcurrentSessions`、`ConcurrentSessionLimitError` 和 HTTP 429 映射；
- Goal 为该限制维护的 `capacityWaiters`；
- 为 Queue 引入 workspace slot、公平性或 reservation 的所有设计。

原因：workspace 不是 CPU、内存或 Provider 配额的真实所有者。这个限制既不能防止跨 workspace 过载，也不能防止同项目文件冲突，却会把本来独立的 Session、Goal 和 Automation 耦合起来。

若未来有真实过载证据，应另做 Runtime/Provider 级、可配置、可观测的资源控制；本次不补替代机制。

### 2.3 线性化不等于新增锁系统

本功能不新增 root lock、workspace lock 或 lock-order 协议。

控制状态的线性化依靠现有单进程模型中的两个同步边界：

1. `SessionExecutionManager.#active` 对同一 Session 的同步 Execution claim；
2. `SessionInputService` 通过 Store 的同步 mutation callback 完成校验和状态变更。

磁盘写入继续由 `SessionStoreManager` 现有的 per-Session persist chain 顺序化。所有可能冲突的前置条件必须在同一个同步 mutation 内检查，不能先读、await、再写。这里不新增 mutex、lease、slot 或第二套任务队列。

## 3. 竞品结论

| 产品 | 已验证行为 | ArchCode 采用 |
| --- | --- | --- |
| OpenAI Codex | 普通补发先 Queue，queued item 可转为 Steer；Stop 独立 | Queue-first、消息级 Steer、轻量 UI |
| GitHub Copilot SDK | `enqueue` 与 `immediate` 分开；missed steer 不应丢失 | Steer miss 回 Queue |
| Cursor / Claude Code | Steer 通常在当前动作结束、下一模型调用前生效；Stop/interrupt 独立 | 明确安全点，不把 Stop 当 Steer |
| Cline | pending prompt 支持编辑和删除 | queued message 是可变实体 |
| Gemini CLI | idle 后一次消费当时所有 queued messages | Queue 快照作为下一次运行的输入批次 |
| OpenCode | queued item 有操作，但使用独立 dock | 只借鉴操作，不引入面板 |

主要证据：

- [Codex Prompting：Steering and queuing](https://learn.chatgpt.com/docs/prompting#steering-and-queuing)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/common.rs)
- [GitHub Copilot SDK：Steering and queueing](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/steering-and-queueing)
- [Gemini CLI useMessageQueue](https://github.com/google-gemini/gemini-cli/blob/1ae8ba64968037b926bc7b1409c2ab0b6a4f55c4/packages/cli/src/ui/hooks/useMessageQueue.ts)
- [Cline PendingPromptService](https://github.com/cline/cline/blob/main/src/core/task/queue/PendingPromptService.ts)

竞品只帮助锁定产品语义，不要求复制其客户端内存 Queue、逐消息 turn 或专用 Queue dock。

## 4. ArchCode 当前缺口

1. `/messages` 当前直接尝试启动 Execution；Session 忙碌时返回冲突，无法先接受消息。
2. Web 在运行时禁用 Composer，用户不能补发。
3. Session Store 只有 canonical `messages[]`，没有“已接受但尚未投递”的持久状态。
4. QueryLoop 没有 active Execution fence 和 Steer safe point。
5. Session runtime projection 只有 activity，刷新后不足以判断某条消息能否 Steer 到用户看到的 Execution。
6. Store event 会早于文件 flush 被 SSE 看到，不适合表示“服务器已经可靠接受 Queue 消息”。
7. workspace 并发上限会让独立 Session 相互阻塞，并迫使 Goal 和 Queue 引入额外调度逻辑。

## 5. 产品契约

### 5.1 普通发送与 Queue

普通发送始终针对 root Session：先持久化一条 queued message，再决定是否启动 Execution。非 root Session 的公共 Message API 明确拒绝；当前 Web 本来就只把 Composer 绑定到 `rootSessionId`。

| 当前状态 | 行为 |
| --- | --- |
| Session idle，且没有未完成 HITL/Tool Batch | 接受消息后立即启动一个 Execution，并带入当时全部 Queue |
| 当前 Execution running | 接受消息并保持 `Queued` |
| root 已结束但 descendant 仍运行 | 接受消息并保持 `Queued`；family 收敛后按最后一次终态规则处理 |
| waiting for HITL/Tool Batch | 接受消息并保持 `Queued`；先完成原 Tool Batch continuation |
| stopping | Stop fact 已在 await 前同步建立；后续消息可直接持久化，并明确属于“Stop 之后的新消息”，但只在 family 收敛后启动下一次 Execution |

Queue 的批次边界是“新 Execution 开始时 Store 的同步快照”：

- 快照内所有 `queued` 消息按数组 FIFO 一起进入新 Execution；
- 快照之后到达的消息留给再下一次 Execution，除非用户 Steer；
- 每条消息保留自己的 ID、正文、时间和 UI 气泡；
- 不把多条正文拼成一个字符串；
- 不为每条消息分别创建 Execution。

### 5.2 两个必须固定的示例

```text
A running
  B queued
  C queued
A completed
=> 一个新 Execution，输入为 B、C
```

```text
A running
  B queued
  C queued
Stop A
  B、C 仍 queued
用户发送 D
=> 一个新 Execution，输入为 B、C、D
```

### 5.3 Steer

Steer 是 queued 气泡上的按钮。请求必须携带：

- `messageId`；
- `expectedRevision`；
- UI 当前看到的 `expectedExecutionId`。

服务端只在以下条件都成立时接受：

- 消息仍为 `queued`；
- revision 未变化；
- 当前 root Execution ID 与 expected 值一致；
- Steer gate 仍开放；
- 消息未被 Edit/Delete/另一次 Steer 消费。

接受后消息暂时变为 `steering`，正文冻结。持久化成功后，完整消息对象进入该 Execution 的内存 mailbox。

在下一次模型调用前的 safe point：

1. QueryLoop 在 `beforeModelBuild` 之前调用本次 Execution 提供的 `consumeSteers()` callback；
2. ExecutionManager 取出 mailbox 中的完整消息对象；
3. `SessionInputService` 原子地把这些消息从 pending 移入 canonical `messages[]` 并持久化；
4. QueryLoop 再按现有方式调用 `toModelMessages()`。

QueryLoop 不接收 pending message ID，也不根据 ID 读取 Queue 正文。

如果 gate 已关闭或 Execution 已结束，尚未 committed 的 `steering` 消息立即持久化回 `queued`。如果磁盘 persist 本身失败，则整条 Session persist chain 复用现有 fail-closed 行为：不再调用模型、不发布越过失败点的事件；重启时由最后 durable snapshot 把 orphaned `steering` 恢复为 `queued`。任何路径都不得丢失、复制或改投到另一个 Execution。

### 5.4 Edit 与 Delete

- 只有 `queued` 消息可编辑或删除；
- Edit 使用 `expectedRevision`，成功后 revision `+1`；
- Delete 使用 `expectedRevision`，成功后从 Queue 消失；
- `steering` 或已经 canonical 的消息不可编辑、删除；
- 并发 Edit/Delete/Steer/Execution start 由 Store 内同一次 CAS 决定唯一赢家；
- POST 由 `clientRequestId` 幂等；Edit/Delete/Steer 由 revision CAS 保证安全重试，重复请求可以返回“已变化/已应用”的最新状态，但不能重复投递或让已删除消息重新出现。

### 5.5 Stop

Stop 的语义只有一条：终止当前 Session family 的 active work，包括 root Execution 或 slash command，以及仍运行的 descendants。

Stop 不做以下事情：

- 不清空 Queue；
- 不把 Queue 搬到另一个 Inbox；
- 不把 Session 设置为 paused；
- 不增加 `held` 状态；
- 不自动启动下一次 Execution；
- 不提供“Stop and clear Queue”。

Stop lease 获取后，在任何 await 之前同步关闭 Steer gate并立即对 active root/command/descendants 发 abort。若存在 active root Execution，同步把 `execution-stop-requested` 追加到该 record；否则同步建立 `queueDispatchBarrierAt`。磁盘 flush 与 family/Tool Batch 收敛随后一起等待。这样 Stop 不会为了磁盘写入延迟取消动作，同时成功响应仍代表对应 Stop fact 已 durable。

尚未 committed 的 `steering` 消息恢复为 `queued`；普通 queued 消息完全不变。即使 root 已经 `completed`、只剩后台 child，重启后也不会把这次明确 Stop 误判成自然 completed drain。

有 active root Execution 时，写入通过一个 `execution-stop-requested` control event 完成，payload 只有 `executionId` 与 timestamp。只有用户显式 Stop 路径写它；内部 failure cleanup 即使复用 family cancellation，也不能伪造用户 Stop。无 active root Execution 时不伪造该 event，只由 Session Input 写入一次性 barrier。

`stopRequestedAt` 不是 Session mode：没有 paused/held 布尔值，没有 Resume 分支，也不会阻止后来新消息；它只是 Execution 的审计事实。下一次新 dispatch 的 `acceptedAt > max(endedAt, stopRequestedAt)` 时照常带入全部 Queue。

如果 Stop 时没有 active root Execution 可承载该事实，`SessionInputService` 持久化同一时刻的 `queueDispatchBarrierAt`。它只回答“哪些 queued 消息发生在这次 Stop 之后”，不是 Session 状态或调度开关；barrier 后第一条新消息会带起整个 Queue，并在该批次的原子 `execution-start + messages_committed` 中清除 barrier。

Stop 之后的下一次普通消息、Automation message 或其他合法显式 dispatch 会启动新 Execution，并带入当时全部 Queue。

### 5.6 Execution 终态

| 终态 | Queue 行为 |
| --- | --- |
| `completed` | 如果该 Execution 没有后续 `stopRequestedAt`，且 Queue 非空、没有 HITL/descendant blocker，自动启动一个新 Execution，带入全部 Queue |
| `waiting_for_human` | Queue 保留；先恢复并完成原 Tool Batch continuation |
| `aborted` / `cancelled` | Queue 保留，不自动启动 |
| `failed` / `timed_out` / `max_steps` / `interrupted` | Queue 保留，不自动启动，避免自动失败循环 |

“不自动启动”不是暂停状态。之后任何合法的新 dispatch 都会带入全部 Queue。

若 root 已 `completed`，但当时仍有 descendant/HITL blocker，则先保留 Queue；最后一个 blocker 收敛时再次调用同一个 `tryStartQueuedExecution`。这是 terminal callback，不新增 waiter、scheduler 或 drain queue。

### 5.7 重启恢复无需新增暂停字段

恢复资格从 Execution 与 Message 的 durable 事实推导：

- 最后一次 Execution 为 `completed`、没有 `stopRequestedAt` 且 Queue 非空：可自动启动；
- 从未启动过 Execution，但已有 durable Queue：可启动；
- 令 dispatch barrier 为 `max(lastExecution.endedAt, lastExecution.stopRequestedAt)`；最后一次是 Stop/失败类终态，且所有 queued message 都早于 barrier：保持 queued；
- 存在 `acceptedAt > dispatchBarrier` 的 queued message：说明 barrier 后出现了新 dispatch，可启动并带入全部 Queue；
- orphaned `steering` 一律恢复为 `queued`；
- 若存在 `queueDispatchBarrierAt`，只有 `acceptedAt` 晚于该事实的新消息才能带起全部旧 Queue；新批次开始后该事实清除；
- orphaned running Execution 继续由现有 load-time repair 标成 `interrupted`。

这覆盖“Stop 后消息不自行重启”和“Stop 后新消息即使在 start 前崩溃也不会永远卡住”，不需要 `autoDispatchPaused`。

### 5.8 HITL、Goal、Automation 与 child

- HITL answer 仍是 typed response，不进入 Queue。
- 未完成 Tool Batch continuation 优先，因为它属于原 transcript 的恢复。
- 同一 Session 若已有 queued user messages，先启动 Queue Execution，再允许 Goal autonomous continuation。
- Goal autonomous continuation 不算 Stop 后的新 dispatch，不能绕过 `stopRequestedAt`；只有后来的用户/Automation message 等显式输入才能带起旧 Queue，完成后 Goal 再按原规则继续。
- Goal claim 在同步 active claim 前最后一次检查 root Queue 与 dispatch barrier；若 Queue 已存在或最近是显式 Stop，则直接让出，不新增 capacity waiter 或轮询。
- Automation 向已有 Session 发送文本时走同一 Queue admission；新 Session 的首条消息也先进入 Queue 再启动。
- Automation `send_message.sessionId` 必须解析为 root Session；不允许通过 Automation 给 child 建隐式 Queue。
- Automation 使用 `invocation.id` 作为 `clientRequestId`；若接受成功后 Automation 状态写入失败，重试同一投递即可得到同一结果。
- `AutomationInvocation` 保留必要的预分配 `sessionId`，删除 `executionId`；“消息已接受”不等于“已创建一个专属 Execution”。
- Automation gateway 不再 `inspectExecution`。普通消息入口自身幂等后，预查询只会制造 Message 与 Execution 的错误耦合。
- 不做 workspace 级公平调度；不同 Session 的启动彼此独立。
- Steer 只指向当前 root Execution，不注入 delegated child。
- child/delegate 继续使用现有 create/resume 语义，不新增 child Queue。

### 5.9 Slash command

Slash command 是控制输入，不伪装成 queued model message：

- 在普通 Queue admission 前识别现有 command；
- 仅当 Session idle、Queue 为空且无 HITL 时执行；
- busy 时返回明确的 command conflict，不把 `/compact` 作为文本排队或 Steer；
- Slash command 与 model Execution 共用 family admission 和 Stop；Stop 在 handler 返回后、写 notice 或 continuation 前再次检查 abort；
- 同一 `clientRequestId` 的并发 command 请求加入 `SessionExecutionManager` 中同一个 live command 结果；不同 command 或其他 family work 互斥，不新增第二个 coordinator；
- durable command receipt 提供 fail-closed at-most-once：重启把遗留 `executing` 修复为 `indeterminate`，不得重放可能已经产生副作用的 command；
- `continueAsMessage` 在一个 Store mutation 内把 command receipt 替换为 message receipt，再进入普通 Queue；
- Automation message 永远按普通文本处理，不能借 slash command 绕过 provenance。

## 6. 最小状态模型

### 6.1 `PendingSessionMessage`

```ts
interface PendingSessionMessage {
  id: string;
  clientRequestId: string;
  content: string;
  source: "user" | "automation";
  state: "queued" | "steering";
  revision: number;
  acceptedAt: number;
  updatedAt: number;
  targetExecutionId?: string;
}
```

约束：

- `pendingMessages[]` 的数组位置就是 FIFO 顺序；
- `targetExecutionId` 只允许出现在 `steering`；
- pending 与 canonical message ID 全局互斥；
- pending 保存完整正文；
- 转入 canonical 时沿用同一个 message ID；
- canonical user message 保留同一个 `clientRequestId` 作为 correlation metadata，使客户端即使漏掉 queued event，也能把 `Sending…` 原地接管；正文仍只保存一份；
- `acceptedAt`、execution `endedAt` 与 `stopRequestedAt` 使用同一个 `nextSessionTimestamp(state, now)` helper，从现有 `updatedAt`/相关 timestamp 最大值推导并 `+1`，不新增 clock 字段；因此 mutation 顺序在同一毫秒内仍严格可比较：Stop 前消息 `< dispatch barrier`，Stop 后消息 `> dispatch barrier`；
- 不存在 `claimed`、`dispatch`、`held`、`initialPendingMessageIds`。

Session 内部同时保留最小幂等索引：

```ts
interface SessionMessageInputReceipt {
  kind: "message";
  clientRequestId: string;
  messageId: string;
  requestFingerprint: string;
  status: "pending" | "canonical" | "deleted";
}

interface SessionCommandInputReceipt {
  kind: "command";
  clientRequestId: string;
  requestFingerprint: string;
  status: "executing" | "completed" | "failed" | "indeterminate";
  error?: string;
}

type SessionInputReceipt =
  | SessionMessageInputReceipt
  | SessionCommandInputReceipt;
```

Receipt 只保存请求身份、结果位置或 command 终态，以及 fingerprint；不保存第二份正文，不进入 public Session DTO。message receipt 让响应丢失后的 POST 重试返回同一消息，也让延迟到达的旧 POST 不会复活已经 Delete 的消息。command receipt 只承诺 fail-closed at-most-once：若进程可能已执行副作用但未能持久化终态，重启后标记 `indeterminate` 并拒绝重放，而不伪称 exactly-once。

现有 `SessionExecutionRecord` 只增加一个可选事实字段：

```ts
interface SessionExecutionRecord {
  // existing fields...
  stopRequestedAt?: number;
}
```

`stopRequestedAt` 只在用户显式 Stop 且存在 active root Execution 时写入，属于该被停止 Execution 的记录；不能被读取成 Session pause，也不能派生 Resume UI。若只有 command/descendant 活跃，则使用前述一次性 `queueDispatchBarrierAt`，不伪造或回写一个 Execution record。

### 6.2 消息迁移图

```text
发送成功
   |
   v
Queued -----------------------> Deleted
   |  Edit：仍是 Queued
   |
   +-- 新 Execution 开始 ------> Canonical message
   |
   +-- Steer ------------------> Steering
                                  |
                                  +-- safe point --> Canonical message
                                  |
                                  +-- miss/Stop/crash --> Queued
```

Stop 不在这张图里，因为 Stop 改变的是 Execution，不是普通 queued message 的生命周期。

### 6.3 Execution 与 Queue

```text
Running + Queue --completed--> New Execution（一次带入全部 Queue）
Running + Queue --Stop-------> Idle + 原 Queue
Idle + 原 Queue + 新消息 -----> New Execution（一次带入原 Queue + 新消息）
```

## 7. 架构职责与必要硬切

### 7.1 单向依赖

```text
HTTP / Automation
        |
        v
Runtime.acceptSessionMessage（薄用例，不新增 Coordinator）
        |                              |
        v                              v
SessionInputService             SessionExecutionManager
        |                              |
        v                              v
SessionStoreManager               Agent -> QueryLoop

SessionStoreManager event source -> Runtime 一次性桥接 -> Server global SSE -> Web
```

只允许上图方向。尤其禁止：

- `SessionInputService` import Execution、Query、Server、Web 或 Automation；
- QueryLoop import `SessionInputService` 或读取 pending Queue；
- Automation 通过 Execution record 判断一条消息是否已接受；
- Server/Web 维护第二份 Queue 或自行驱动 Execution。
- 一个 Session family 内出现多个 independently drainable Queue。

`Runtime.acceptSessionMessage` 只是现有 Runtime 上的应用入口：先接受 durable message，再调用 ExecutionManager 尝试启动当前 Session。它不是新对象、不保存状态，也不序列化任务。

### 7.2 新增唯一领域模块：`SessionInputService`

Queue/Edit/Delete/Steer 是同一组“Session 输入从 accepted 到 canonical”的规则，应放在一个高内聚模块，而不是继续塞进已经同时负责 registry、文件和 tree/cwd 的 `SessionStoreManager`，也不能塞进 live lifecycle owner `SessionExecutionManager`。

`SessionInputService` 负责：

- accept/edit/delete queued message；
- 把 cutoff 内全部 queued messages 一次 commit 到指定 Execution；
- 为 child create/resume、Goal claim 等 typed execution path 把 direct input 在 Agent 启动前 commit 成 canonical message，但不为它们建立 Queue；
- claim/commit/rollback Steer；
- clientRequestId 幂等和 orphaned steering recovery；
- 返回完整 message snapshot，不提供“按 ID 读取正文”的接口。

它通过 `SessionStoreManager` 的一个窄 durable mutation primitive 完成 CAS、事件追加和 flush。构造函数只依赖同一 `service.ts` 内声明的 structural `Pick`（load + durable mutation），不依赖整个 StoreManager 公共面；这只是 TypeScript 编译期边界，不新增 repository abstraction。

ExecutionManager 同样只拿到 batch/direct-input/Steer 所需的窄 operations，不拿 accept/edit/delete。`SessionInputService` 不拥有：

- active Execution map；
- Steer gate/mailbox；
- Stop/finalization；
- timer、retry、scheduler、lock、slot 或后台 worker。

不再把 `acceptPendingMessage`、`claimSteer` 等七个 Queue 领域方法直接加到 `SessionStoreManager`。也不再为这个模块拆 repository、controller、coordinator 或 state-machine class。

### 7.3 `SessionStoreManager`

继续只负责 Store 基础设施：Session registry/load、snapshot persistence、per-Session persist chain、event ID 和公开 projection 的 durable boundary。

新增能力仅为一个内部 `commitDurableSessionMutation(...)` primitive：

1. mutation 在一个同步 callback 内检查前置条件并生成完整状态，避免 read-await-write；
2. snapshot 进入现有 per-Session persist chain；
3. 调用方只在 persist 成功后得到成功结果；
4. persist 失败时不发布对应 control event，也不允许继续发布跨过该 event ID 的同 Session 事件。

失败处理复用现有 `#persistFailures` fail-closed chain：后续 flush/mutation 继续失败，尚未启动的 active claim 释放，Agent 不运行；重启从最后 durable snapshot 恢复。该 primitive 不理解 Queue、Steer 或 Execution eligibility；production 中只允许明确的 Store/domain adapter 调用，避免它退化为任意写入口。

### 7.4 `SessionExecutionManager`

继续作为唯一 live Execution owner，只负责：

- 同一 Session 的同步 active claim；
- start/stop/finalize 与 existing family/child lifecycle；
- 启动时向 `SessionInputService` 请求一次 queue-to-canonical commit；
- 当前 root Execution 的 Steer gate/mailbox；
- `completed` 后对**同一个 Session**调用一次 `tryStartQueuedExecution`；
- Stop/失败终态不自动续接；
- 删除 workspace 并发计数和所有 capacity 分支。

active claim 在第一次 await 前进入 Manager，先作为内部 provisional owner 阻止重复 start；只有 queue/direct-input + `execution-start` 已 durable 后，才公开 `activity=running` 和 `steerTargetExecutionId` 并调用 Agent。persist 失败则释放 claim，不向 Web 暴露一个从未 durable 的 Execution。

普通消息的 accept/edit/delete 不进入这个 Manager。它也不再拥有 `SessionEventBridge`、订阅 attach/detach 或 Server forwarding 生命周期。

文件较大不是拆分理由，因此本次不顺带把 Stop、Delete、cwd、child lifecycle 各拆成新 Manager；只有已经形成独立不变量集合的 Session Input 被抽出。

### 7.5 Agent / QueryLoop 硬切

当前 `Agent.run(userMessage)` 和 `runQueryLoop(options, userMessage)` 同时承担“写入输入”和“运行模型”，与 Queue batch 根本冲突，必须彻底重构：

- `Agent.run(options)` 启动时假定本 Execution 的输入已经 canonical；
- `runQueryLoop(options)` 删除 raw `userMessage` 参数、user-message append 和 slash-command sniffing；
- root Queue batch、Steer 和 child direct input 都在进入 Agent 前写入 Store；
- todo continuation 继续复用同一次 Agent run，不伪造空字符串输入；
- slash command 由 `ConfiguredAgent`/CommandRegistry 的独立 pre-admission control path 处理；若 command 返回 `continueAsMessage`，该文本重新走普通 Queue admission；
- QueryLoop 在每次 `beforeModelBuild` 和 `toModelMessages()` 之前调用 Execution 提供的 `consumeSteers()`；callback 返回后只读取 canonical transcript。

不保留兼容 overload，也不允许 QueryLoop 通过 message ID 回调 Store 获取正文。

### 7.6 Active Execution 上的 Steer mailbox

Mailbox 是 active Execution 内的最小内存字段，不是持久 Queue 或 Coordinator。V1 直接放在 `ActiveSessionExecution` 上：

- 只保存已经 durable claim 的完整 message snapshot；
- 绑定唯一 `executionId`，按成功 Steer 的顺序消费；
- 不启动 Execution、不读写磁盘；
- gate 关闭后拒绝追加，Execution 结束即销毁。

若 claim 持久化后 gate 已关闭，ExecutionManager 立即调用 `SessionInputService.rollbackSteers`；durable `pendingMessages[]` 始终是 crash recovery 的事实源。

### 7.7 Event / Server 硬切

当前事件订阅随 Execution attach/detach，导致 idle Queue 变更没有可靠转发边界。必须改为明确的三段所有权：

- `SessionStoreManager` 决定 raw Session event 何时可发布，并提供与 Execution 无关的 event source；
- Agent Runtime 持有现有 `SessionEventBridge`/订阅 facade，只负责把 raw envelope 投影为全局协议事件；
- Server 启动时一次性把 Runtime subscription 接到 global event bus；
- 删除每次启动 Execution 时创建 forwarding 的包装层；
- Session idle、running、stopping 时都走同一事件路径。

Durable control event 使用现有 persist chain 上的最小 publish barrier：某个 control event 未持久化时，只暂存它以及排在它后面的**同 Session**事件；成功后按 event ID 依次释放。其他 Session 不受影响。普通 text/reasoning delta 在前面没有未完成 barrier 时仍即时发布。

这只是同一有序事件流的发布条件，不新增 event outbox service、worker、重试调度器或第二套 event ID。公开 REST Session snapshot 在返回前等待该 Session 的既有 `flushSession`，避免读取到尚未 durable 的 control mutation。

### 7.8 Server 与 Web

Server route 只做 schema、权限、错误映射和调用 Runtime，不维护 Queue 副本。

Web 只维护两类状态：

- 服务端 Session projection：canonical messages、pending messages、runtime fence；
- 当前来源窗口的临时 `Sending…` projection。

Web 不自己决定消息是否已 queued、steered 或 committed。

## 8. API 与实时状态

### 8.1 Message API

```text
POST   /api/projects/:slug/sessions/:sessionId/messages
PATCH  /api/projects/:slug/sessions/:sessionId/messages/:messageId
DELETE /api/projects/:slug/sessions/:sessionId/messages/:messageId
POST   /api/projects/:slug/sessions/:sessionId/messages/:messageId/steer
```

POST body 至少包含：

```json
{ "text": "...", "clientRequestId": "uuid" }
```

PATCH body：

```json
{ "text": "...", "expectedRevision": 2 }
```

DELETE body：

```json
{ "expectedRevision": 2 }
```

Steer body：

```json
{ "expectedRevision": 2, "expectedExecutionId": "execution-id" }
```

规则：

- POST 在 Session busy 时仍返回 accepted，不再因 `AgentRunningError` 返回 409；
- 同一 `clientRequestId` + 同一 fingerprint 重试返回同一结果；同 ID 不同正文/source 返回 idempotency conflict；
- Edit/Delete/Steer 的 CAS 失败返回最新 message status/projection；消息可能已 queued、steering、canonical 或 deleted，不能假装它仍 pending；
- HTTP response 只确认请求结果，Web canonical store 由 durable SSE/REST projection 接管。

### 8.2 Runtime message contract

硬切公开 Runtime API：

```ts
acceptSessionMessage(input): Promise<{
  clientRequestId: string;
  messageId: string;
}>
```

- 删除会承诺“本次调用必然创建 Execution”的 `startSessionMessageExecution`；
- 返回值只表示消息 durable accepted，不返回 `ActiveSessionExecution`，也不承诺一个专属 executionId；
- 入口验证目标是 root Session；child direct/resume 不走该 API；
- Runtime 内部在 accept 后调用 `tryStartQueuedExecution`，是否立即启动由当前 Session 状态和同步 active claim 决定；
- Automation gateway 直接以 `invocation.id` 调用同一方法；重试依靠消息入口幂等，不做 execution preflight；
- 普通 Web route 与 Automation 使用同一入口；Goal claim、Tool Batch、child 等 typed execution path 保持独立，但都必须在 Agent 前 canonicalize direct input，且不再包装 Execution forwarding。

### 8.3 Runtime projection

扩展现有 `SessionFamilyRuntimeProjection`，不新增平行类型：

```ts
interface SessionFamilyRuntimeProjection {
  projectSlug: string;
  rootSessionId: string;
  activity: "idle" | "running" | "stopping";
  steerTargetExecutionId?: string;
}
```

`steerTargetExecutionId` 存在就表示当前 root Execution 可接受 Steer，不再增加重复的 `steerOpen` 布尔值。刷新、重连或 gate 变化都必须发布新 projection；即使 activity 仍为 `running`，target 变化也必须发事件。Web 不从旧 `execution-start` event 猜 target。

### 8.4 Durable SSE

Queue accept/edit/delete、Steer claim/commit/rollback、Queue batch commit、`execution-stop-requested` 和 execution terminal 都是 control events：

- 只有对应 Session snapshot 持久化成功后才发布；
- event ID 保持 Store 顺序；
- SSE replay 与 REST snapshot 得到相同结果；
- 如果前面没有未完成的 control persist，text/reasoning delta 继续使用现有低延迟路径；
- 如果同 Session 前面已有未 durable 的 control event，后续 delta 必须短暂等待，不能越过 event ID；其他 Session 不受影响。

## 9. UI

### 9.1 Composer

- Session running 时 Composer 仍可输入和发送；
- Enter 行为不变，不增加 Queue/Steer mode；
- 点击发送后立即出现本地 `Sending…` 气泡；
- durable event 到达后按 `clientRequestId` 原地替换；
- 明确的 4xx rejection 才移除临时气泡并恢复 draft；
- network timeout/断线属于“结果未知”，保留同一临时气泡并用原 `clientRequestId` 重试或 REST reconcile，不能生成第二条消息。

### 9.2 普通消息气泡

pending messages 直接渲染在消息时间线尾部，不建立 Queue 面板：

- `sending`：只显示发送中；
- `queued`：显示轻量 `Queued` 状态；
- `steering`：显示 `Steering…`；
- canonical：状态消失，继续作为同一消息气泡。

queued 气泡操作：

- `Steer`：仅 `steerTargetExecutionId` 存在且 target fence 匹配时显示；
- `Edit`；
- `Delete`。

不存在消息级 `Send`、Resume、Queue dock、Queue drawer 或“加入队列”按钮。

## 10. 一刀切删除范围

实现完成后删除所有相关生产代码、测试、类型和错误映射：

- `maxConcurrentSessions`
- `#activeSessionsByWorkspace`
- `#acquireWorkspaceSlot` / `#releaseWorkspaceSlot`
- `ConcurrentSessionLimitError`
- `ConcurrentSessionLimitHttpError`
- Goal `capacityWaiters` 与 `"capacity"` continuation outcome
- Queue 设计中的 `autoDispatchPaused`
- `dispatch: "auto" | "held"`
- pending `claimed` 状态
- `initialPendingMessageId(s)`
- workspace arbiter、slot reservation、ready-root fairness queue、handoff lease
- `SessionFamilyTurnCoordinator`
- Queue panel、消息级 Send/Resume UI 与 API
- `startSessionMessageExecution` 及“消息调用必然返回 ActiveExecution”的契约
- `Agent.run(userMessage)` / `runQueryLoop(..., userMessage)` 兼容 overload
- QueryLoop 内的 user-message append 与 slash-command sniffing
- `ManagedSessionExecutionForwarder` / `setManagedSessionExecutionForwarder`
- `createServerEventRuntime` / `prepareSessionForwarding` 及 execution-scoped forwarding
- `SessionExecutionManager` 对 `SessionEventBridge` 的持有和 attach/detach API
- `AutomationInvocation.executionId`
- Automation `SessionExecutionIdentity`、`SessionExecutionDispatchState`、`inspectExecution`

保留 `ConcurrentLimitError`，因为它约束的是单个 Agent 的 child fan-out，不是 workspace 中彼此独立的 Session。

## 11. 主要受影响文件

### Protocol / Store

- `packages/protocol/src/types.ts`
- `packages/protocol/src/reduce.ts`
- `packages/protocol/src/guards.ts`
- `packages/agent-core/src/store/types.ts`
- `packages/agent-core/src/store/session-store-manager.ts`
- `packages/agent-core/src/store/helpers.ts`
- `packages/agent-core/src/session-input/service.ts`（新增唯一领域模块）
- `packages/agent-core/src/events/session-event-bridge.ts`
- `packages/agent-core/src/runtime.ts`
- `packages/agent-core/src/index.ts`

### Execution / Query

- `packages/agent-core/src/execution/session-execution-manager.ts`
- `packages/agent-core/src/agents/query/loop.ts`
- `packages/agent-core/src/agents/query/types.ts`
- `packages/agent-core/src/agents/configured-agent.ts`
- `packages/agent-core/src/agents/types.ts`
- `packages/agent-core/src/agents/errors.ts`

### Goal / Automation / HITL

- `packages/agent-core/src/goals/goal-lead-continuation.ts`
- `packages/agent-core/src/goals/lifecycle-service.ts`
- `packages/agent-core/src/automations/dispatcher.ts`
- `packages/agent-core/src/automations/runtime-session-gateway.ts`
- `packages/agent-core/src/automations/schema.ts`
- `packages/agent-core/src/automations/state-manager.ts`
- startup Tool Batch reconciliation paths

### Server / Web

- `apps/server/src/routes/messages.ts`
- `apps/server/src/routes/sessions.ts`
- `apps/server/src/routes/goals.ts`
- `apps/server/src/app.ts`
- `apps/server/src/boot.ts`
- `apps/server/src/errors.ts`
- global Session SSE wiring/public projection
- `apps/web/src/api/*`
- `apps/web/src/store/session-runtime-store.ts`
- `apps/web/src/routes/session.tsx`
- `apps/web/src/components/features/ChatInput.tsx`
- `apps/web/src/components/composite/ChatMessages.tsx`

对应 unit/integration/architecture/Web tests 必须同步修改；不保留旧 schema fixture。

## 12. 实施顺序

### Wave 0：先锁定失败测试

- B、C 同批进入一个 Execution；
- Stop 后 B、C 保留，发送 D 后 B、C、D 同批；
- Steer/Edit/Delete CAS；
- 第 5 个独立 Session 在同一 workspace 可以启动；
- 同一 Session duplicate start 和 child concurrency 仍被拒绝；
- architecture test 锁定 Input/Execution/Query/Event/Automation 的依赖方向。

### Wave 1：Store、Input 与 Event 边界

- 增加 `pendingMessages[]`、revision、client request identity；
- 给 StoreManager 增加唯一的 durable mutation primitive；
- 新增 `SessionInputService`，完成 accept/edit/delete、batch-to-canonical、typed direct input 和 restart repair；
- StoreManager 改为产生 publishable raw event，Runtime 持有 `SessionEventBridge`；ExecutionManager 不再参与；
- 建立同 Session event publish barrier，删除 execution-scoped forwarding。

### Wave 2：Agent / Query 输入硬切

- `Agent.run(options)` 和 `runQueryLoop(options)` 不再接收字符串；
- 所有 root/child 输入在 Agent 前成为 canonical message；
- slash command 移到独立 pre-admission control path；
- todo continuation 不再使用空字符串哨兵；
- 删除旧 overload 和 QueryLoop 内 append/sniffing。

### Wave 3：统一普通 message admission

- `startSessionMessageExecution` 硬切为 `acceptSessionMessage`；
- busy Session 不再拒绝普通消息，idle admission 一次带入全部 Queue；
- `completed` 后续接同一 Session Queue，Stop/失败终态不续接；
- Automation 删除 execution identity/preflight，以 `invocation.id` 幂等投递；
- 删除 workspace 并发上限和 Goal capacity 分支。

### Wave 4：Steer

- 增加 runtime fence、gate 和最小 mailbox；
- 增加 claim/consume/commit/rollback；
- QueryLoop 只调用 callback，继续读取 canonical transcript；
- 覆盖 finalization、Stop 和 crash race。

### Wave 5：Server、Web 与硬切收尾

- 增加 Edit/Delete/Steer API；
- runtime projection 支持刷新安全的 Steer；
- Composer running 时可发送；
- 实现 `Sending…`、Queued、Steering 和气泡操作；
- 接通 HITL、Goal、Automation 和 startup recovery；
- 删除旧 API、forwarder、错误、类型、测试和设计残留；
- 确认没有 Queue panel、消息级 Send 或兼容分支；
- 全量 typecheck/test/build；
- 浏览器验证发送、Steer、Edit、Delete、Stop、刷新和多窗口。

## 13. 测试矩阵

### Store / Unit

- accept FIFO、clientRequestId 幂等；
- 同 clientRequestId 不同 fingerprint 被拒绝；
- Edit/Delete revision CAS；
- Edit/Delete/Steer/start 四方竞态只有一个赢家；
- batch snapshot 一次移动全部 queued message；
- batch cutoff 后消息留给下一次；
- pending/canonical ID 不重复；
- orphaned steering 恢复 queued；
- persist failure 不发布 durable event；
- persist failure 释放尚未运行的 active claim，且 Agent 不启动；
- 同一毫秒内 Stop 前/后的 queued message 仍能靠单调 timestamp 正确区分；
- `SessionInputService` 不启动/停止 Execution，不持有 timer、lock 或 scheduler。

### Execution / Integration

- A completed 后 B、C 共享一个 executionId；
- B、C 在该 Execution 的第一次 model request 中同时可见，仍是两条 user message；
- provisional active claim 阻止 duplicate start，但 execution-start durable 前不公开 running/Steer target；
- A Stop 后 B、C 不启动；D 到达后 B、C、D 共享一个 executionId；
- B Steer 成功进入 A，C 留给下一 Execution；
- Steer 与 terminal race 不丢失、不复制、不串 Execution；
- waiting_for_human 先恢复 Tool Batch，再处理 Queue；
- root completed 但 descendant 尚未结束时不启动；最后一个 blocker 收敛后同批启动 Queue；
- root completed 后用户 Stop 剩余 child：写入一次性 `queueDispatchBarrierAt`，不回写 completed Execution；child 收敛及重启均不自动 drain；
- internal failure cleanup 取消 descendants 时不写 `execution-stop-requested`；
- Goal autonomous continuation 不能越过显式 Stop barrier；新 user/Automation message 后才可恢复；
- failed/timed_out/max_steps/interrupted 不自动循环；
- 服务重启根据 terminal + acceptedAt 正确恢复；
- 同 workspace 至少 5 个独立 Session 可同时启动；
- duplicate Session execution、child maxConcurrent/depth 仍生效。

### Server / SSE

- busy POST 返回 accepted；
- 非 root Session 的普通 Message POST 被拒绝，不创建 child Queue；
- Edit/Delete/Steer conflict 返回最新 snapshot；
- durable 前不发 Queue control event；
- idle Session 的 Accept/Edit/Delete 也会发 global SSE，不依赖 active Execution；
- 未 durable control event 后面的同 Session delta 不越序，其他 Session delta 不受阻塞；
- SSE replay、REST snapshot 与磁盘一致；
- `CONCURRENT_SESSION_LIMIT` 不再存在。

### Automation

- invocation 首次投递成功但状态写入失败时，用同一 `invocation.id` 重试不会重复消息；
- busy Session 接受 Automation message 后可保持 queued，Invocation 仍可标记 dispatched；
- `start_session` 重试复用预分配 sessionId 和同一消息，不预分配 Execution；
- `send_message` 指向 child Session 时被拒绝；
- Automation persistence/schema/gateway 不再出现 `executionId` 或 `inspectExecution`。

### Architecture / Hard cut

- `SessionInputService` 不 import execution/query/server/web/automation；
- QueryLoop 不 import session-input，也不读取 `pendingMessages`；
- `SessionExecutionManager` 不持有 `SessionEventBridge`；
- production 不存在 `startSessionMessageExecution`、`ManagedSessionExecutionForwarder`、`prepareSessionForwarding`；
- production 不存在 `Agent.run(userMessage)` 或 `runQueryLoop(..., userMessage)`；
- 只有 `SessionExecutionManager` 写 live active Execution map；
- StoreManager 不暴露 Queue 领域方法，ExecutionManager 不实现 Edit/Delete。
- SessionInputService 不依赖完整 StoreManager public surface，ExecutionManager 也拿不到 accept/edit/delete capability。

### Web

- running 时 Composer 可发送；
- `Sending…` 被 durable 气泡原地接管；
- response 丢失后使用同一 clientRequestId reconcile，不产生第二个 optimistic/canonical 气泡；
- queued event 丢失、直接收到 canonical message 时仍按 clientRequestId 原地接管；
- queued 气泡有 Steer/Edit/Delete；
- 无 Queue panel、Send/Resume、mode toggle；
- refresh 后 Steer fence 正确；
- child-only running 不显示错误 Steer；
- Stop 后旧 Queue 留在原位置，新消息触发同批处理。

## 14. 验收条件

- **AC-01**：保留 Session/Execution/Message，不存在新 Turn 领域或 Coordinator。
- **AC-02**：普通发送 Queue-first，running 时不再禁用 Composer 或返回 busy 409。
- **AC-03**：B、C 在同一 cutoff 前 queued 时，共享一个下一 Execution 和首次模型请求，仍是两条独立消息。
- **AC-04**：Stop 后 B、C 保留；发送 D 后 B、C、D 一次进入新 Execution。
- **AC-05**：不存在 Session pause、`autoDispatchPaused`、`auto|held` 或消息级 Resume；有 active root Execution 时，Stop 事实只写入被停止 Execution 的 `stopRequestedAt`。仅当 family 活跃但没有 active root Execution 时，持久化一次性 `queueDispatchBarrierAt`，并在下一批 Queue 启动时原子清除。
- **AC-06**：queued 气泡提供 Steer/Edit/Delete，没有 Queue panel 或消息级 Send。
- **AC-07**：Steer 使用 expectedExecutionId + revision fence，并在下一模型调用前生效。
- **AC-08**：Steer miss/Stop/crash 返回 Queue，不丢失、不复制、不串到新 Execution。
- **AC-09**：QueryLoop 不读取 pending Queue，不通过 ID 回查正文。
- **AC-10**：Queue batch 在 `Agent.run(options)` 前成为 canonical messages；QueryLoop 沿用 `toModelMessages()`。
- **AC-11**：control event durable 后才对 SSE/REST 可见；后续同 Session event 不越序，其他 Session 不受阻塞。
- **AC-12**：Edit/Delete/Steer/start 的并发结果由 Store CAS 唯一决定。
- **AC-13**：HITL Tool Batch continuation 优先于 Queue；用户 Queue 优先于 Goal autonomous continuation。
- **AC-14**：Automation message 使用同一 Queue，以 invocation.id 幂等接受，不再预分配或查询 executionId。
- **AC-15**：删除 workspace 并发上限、429、Goal capacity waiter 及全部 slot/fairness 设计。
- **AC-16**：同一 Session single-flight、child concurrency/depth 和 Stop/Delete/cwd 安全边界继续生效。
- **AC-17**：服务重启不自动重启纯 Stop 前 Queue；root 已 completed 后再 Stop child 也不误 drain；Stop 后新接受的消息会恢复并带入全部 Queue。
- **AC-18**：来源窗口有本地 `Sending…`，durable message 原地接管；明确拒绝恢复 draft，结果未知则复用同一 clientRequestId reconcile。
- **AC-19**：旧 Session schema 不兼容且无 migration/fallback。
- **AC-20**：只新增一个 `SessionInputService` 领域模块；不新增 Coordinator、scheduler、repository 层、outbox worker 或锁系统。
- **AC-21**：StoreManager 只提供基础 durable mutation；Queue 规则不散落进 StoreManager 或 ExecutionManager。
- **AC-22**：production 中不存在 raw-string Agent/QueryLoop 入口和 `startSessionMessageExecution` 兼容路径。
- **AC-23**：Session event 发布独立于 Execution 生命周期，idle Queue mutation 也能可靠到达 Web。
- **AC-24**：Queue/Steer 只存在于 root Session；child focused view 和 typed resume 不产生第二个 family Queue。
- **AC-25**：`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部通过。

## 15. Reviewer 清单

Reviewer 必须重点搜索和验证：

1. 是否又把 Queue 拆成一条消息一个 Execution；
2. 是否把 B、C 拼成一条正文；
3. Stop 是否误清空 Queue、设置 pause 或自动重启；
4. 是否重新出现 `held/auto/claimed`；
5. QueryLoop 是否收到 pending IDs、raw userMessage 或回查正文；
6. 是否出现第二个 Execution owner、Coordinator 或调度循环；
7. 是否保留 workspace slot、capacity waiter、公平调度或 handoff；
8. Steer 是否缺少 active execution fence；
9. finalization race 是否可能丢失 steering message；
10. Edit/Delete/Steer/start 是否在 await 之外做了非原子 read-then-write；
11. Queue control event 是否可能在持久化前泄漏给 Web；
12. Web 是否出现 Queue panel、默认 Queue 按钮或消息级 Send；
13. Stop 后 B、C，再发送 D 的完整链路是否真的一次处理 B、C、D；
14. workspace 第 5 个独立 Session 是否仍被旧 429 阻塞；
15. child concurrency 是否被误删；
16. Queue 领域规则是否又被塞回 `SessionStoreManager` 或 `SessionExecutionManager`；
17. `SessionInputService` 是否反向依赖 Execution/Query/Server/Web/Automation；
18. event forwarding 是否仍随 Execution attach/detach，导致 idle mutation 丢事件；
19. Automation 是否仍预分配 executionId、inspect Execution 或把 queued 误判为未接受；
20. 是否为了兼容保留 raw-string Agent API、旧 Runtime API 或双写路径；
21. active root Execution 的 Stop 是否只写 `stopRequestedAt`；无 active root Execution 的 family Stop 是否只写一次性 `queueDispatchBarrierAt`，而没有扩展成 Session pause/Resume 状态；
22. child Session 是否被错误赋予 Queue/Steer，从而重新制造 family 调度问题。

## 16. 本轮自审结论

| 旧设计问题 | 本轮处理 |
| --- | --- |
| `SessionFamilyTurnCoordinator` 引入新 Turn 领域 | 删除；沿用 `SessionExecutionManager` |
| Queue 默认按钮和独立面板 | 删除；普通发送 + 普通气泡 |
| B、C 被解释成连续两个 Execution | 改为一次 Queue snapshot、一个 Execution、两条消息 |
| Stop 被设计成暂停并需要 Resume/Send | 删除暂停语义；Stop 后新 dispatch 自然带入全部 Queue |
| root completed、只剩 child 时 Stop 无 durable 痕迹 | 保存一次性 `queueDispatchBarrierAt` 截止事实，下一批 Queue 原子清除；不改 completed Execution，也不引入 Session pause |
| `autoDispatchPaused`、`auto|held` | 全部删除；恢复资格从 terminal、`stopRequestedAt` 和 `acceptedAt` 事实推导 |
| QueryLoop 根据 pending ID 读取正文 | 删除；初始批次先 canonical，Steer mailbox 携带完整 snapshot |
| `claimed` 与 initial pending reservation | 删除；Queue-to-canonical 与 execution-start 同一 Store transaction |
| workspace slot、arbiter、fairness、handoff | 连同现有 workspace 并发上限一起删除 |
| root/workspace lock 与复杂 lock order | 不新增；使用同步 active claim、Store CAS 和既有 persist chain |
| optimistic UI 与 canonical Store 双写 | 本地只显示 `Sending…`，durable event 按 clientRequestId 接管 |
| 七个 Queue 方法直接塞进 `SessionStoreManager` | 改为唯一新模块 `SessionInputService`；StoreManager 只保留 durable mutation 基础设施 |
| Message accept/start 继续扩大 `SessionExecutionManager` | Runtime 薄入口负责 accept 后尝试 start；ExecutionManager 只拥有 live lifecycle |
| `Agent.run(userMessage)` 在 QueryLoop 内追加输入 | 彻底删除 raw-string 契约；所有输入先 canonical，再运行 Agent |
| Session event forwarding 绑定 Execution 生命周期 | 彻底抽离；StoreManager 决定 raw event 可发布性，Runtime 投影，Server 只桥接一次 |
| durable control event 与“delta 永不等待”互相矛盾 | 改为最小同 Session publish barrier；只在必要时短暂保持顺序 |
| Automation 用 executionId 证明消息已接受 | 删除 execution identity/preflight；用 invocation.id 重试幂等 message accept |
| `acceptedAt > endedAt` 依赖毫秒时钟 | accepted/end/stop 三类时间使用同一无状态单调 helper，避免同毫秒误判 |
| 未限定 Queue scope，可能产生多个 child Queue | 对齐现有 UI：只允许 root Queue/Steer，child 保持 typed direct input |
| 因现有 Manager 文件大而顺带全面拆分 | 不做；只按独立不变量和依赖方向抽出 Session Input，避免重构扩散 |

最终责任边界：StoreManager 管存储与事件顺序，SessionInputService 管 accepted message 的 durable 状态迁移，ExecutionManager 管 live Execution，Agent/QueryLoop 管模型与工具循环，Server/Web 只消费投影。依赖保持单向；本次需要的硬重构有四处，但新增领域概念只有一个，不引入跨 workspace 调度系统。
