# Reminder System

## 问题

子代理完成、TODO 续跑等事件需要通知 LLM。核心问题：

1. 通知怎么到达 LLM？（推送到消息流 vs 拉取队列）
2. LLM 怎么消费通知？（自动 vs 主动调用工具）
3. 不同的通知类型应该用不同的投递方式吗？（TODO 续跑应该主动推送，子代理完成应该按需拉取）

## 竞品参考

| 竞品 | 载体 | 投递方式 | 消费方式 | 队列结构 | 去重 |
|------|------|---------|---------|---------|------|
| Claude Code | XML 文本作为 user-role 消息 | 统一命令队列，优先级 now/next/later，注入父消息队列 | LLM 自动看到（在下一轮对话中） | `QueuedCommand[]` 单一队列 | 原子 `notified` flag |
| OpenCode/OMO | `<system-reminder>` XML 标签 | `promptAsync({ noReply })` 注入 session | LLM 自动看到 + `background_output` 按需拉取 | `Map<sessionId, BackgroundTask[]>` + `Map<sessionId, string[]>` | `completedTaskSummaries` Map |
| Cursor | 桌面通知 + MCP 轮询 | 多通道推送 | `getAgent()` / `listAgents()` 拉取 | 状态文件 `~/.cursor/subagents/` | 无 |
| Devin | Slack + 浏览器 + 结构化输出 | 多通道推送 | HTTP 轮询 + 钩子 | 无独立队列 | 无 |
| LangGraph | `interrupt()` 暂停 + `Command(resume=)` 恢复 | 检查点驱动 | 调用方恢复 | 检查点存储 | 检查点 ID |

**关键洞察**：Claude Code 和 OMO 的做法揭示了两种不同的通知需求——
- **需要 LLM 立即行动的通知**（TODO 续跑）：应该主动推送到消息流，LLM 看到就继续工作
- **LLM 按需获取结果的通知**（子代理完成）：应该排在队列里，LLM 想要结果时才取

这两种需求不矛盾，可以共存于同一个 Reminder 系统。

## 决策

### 核心模型：双通道投递

**选择**：所有 reminder 共享同一个 `reminders[]` 队列在 store 中，但按投递方式分流：

- **`auto_inject`**（主动推送）：`toModelMessages()` 投影时自动追加一条 `<system-reminder>` 消息到对话流，LLM 无需主动操作就能看到
- **`on_demand`**（按需拉取）：留在队列中，LLM 调用 `wait_for_reminder` 工具时才消费

**理由**：两种投递方式解决不同的问题。TODO 续跑需要保证 LLM 一定能看到，不能依赖 LLM 记得调某个工具。子代理完成的结果是 LLM 主动发起的异步操作，LLM 知道自己在等，显式消费更可控。

**不需要优先级**：ArchCode 的消费端是显式工具调用，不存在 Claude Code 那种"用户输入和任务通知争抢同一队列"的问题。FIFO 足够。

### 投递方式由来源决定

| 来源 | 投递方式 | 理由 |
|------|---------|------|
| `todo_continuation` | `auto_inject` | 必须保证 LLM 看到，不能依赖主动调用 |
| `subagent_completed`（异步模式） | `on_demand` | LLM 知道在等什么，显式消费更可控 |
| `subagent_failed`（异步模式） | `on_demand` | 同上 |
| `subagent_timed_out`（异步模式） | `on_demand` | 同上 |
| `subagent_cancelled`（异步模式） | `on_demand` | 同上 |

**同步模式（`background=false`）不产生 Reminder**：`delegate` 阻塞返回结果，无需通知机制。只有异步模式（`background=true`）的子代理终态才产生 Reminder。

### 消息注入方式：user-role `<system-reminder>` 块

**选择**：`auto_inject` 类型的 reminder 在 `toModelMessages()` 投影时追加为 user-role 消息，内容包裹在 `<system-reminder>` 标签中。

**不修改 system prompt**：system prompt 是静态的，修改它会让 prompt cache 失效。user-role 消息参与对话流，LLM 能看到且能回应。

**注入后立即标记消费**：一条 `auto_inject` reminder 只投递一次，不会重复出现在后续 step 中。

### `wait_for_reminder` 语义：阻塞到条件满足

**选择**：阻塞等待，不是立即返回。LLM 调用 `wait_for_reminder` 后，工具执行暂停，直到条件满足或超时。

**与 LangGraph `interrupt()` 语义一致**：暂停 → 等待外部事件 → 恢复。比轮询模型（调一次返回空，再调再返回空）更自然，也避免浪费 step。

**实现**：Zustand `subscribe()` + Promise。store 变更时检查条件，满足则 resolve。超时用 setTimeout。

### 去重与消费幂等

**选择**：每条 reminder 有唯一 `id`，消费时设置 `consumedAt` 时间戳。`reduceStreamEvent` 中相同 `id` 的 reminder 跳过。

**理由**：简单可靠。`consumedAt` 非空 = 已消费，不再出现在投影或 `wait_for_reminder` 结果中。

### TODO 续跑安全机制

**选择**：沿用 OMO 生产验证的模式。

| 机制 | 说明 | OMO 对应 bug |
|------|------|-------------|
| 续跑冷却 30s | 防止 API 快速失败时反复注入 | #1806 原因：无冷却导致 6-7s 间隔循环 |
| 停滞检测 3 次 | 比较 pending todo hash，不变则停 | #2216 原因：todo_write 不可用但 API 成功 |
| 挂起问题检测 | 最近 assistant 消息有 ask_user 工具调用时跳过 | #1193 原因：在等用户输入时仍注入续跑 |
| 后台任务检测 | 有 running 子代理时跳过 | #3362 原因：只检查 running 不检查 pending |
| 最大续跑 10 次 | 硬性上限 | 无直接 bug，但所有竞品都有 turn/step 限制 |

**这些都是 OMO 用真 bug 换来的教训**，不可省略。

### 批处理由消费端决定

**选择**：`wait_for_reminder` 的 `condition` 参数让 LLM 决定等待策略——`"all"`、`"any"`、或 `{ count: N }`。

**不在系统层批处理**：OMO 等所有后台任务完成后发一条 "ALL BACKGROUND TASKS COMPLETE"。但 ArchCode 的 LLM 可以自己决定要不要等全部——可能先收集一部分结果就够用了。

## 数据流

```
                     Reminder 产生
                     ┌───────────────────────┐
                     │                       │
     异步子代理完成 ──►│ store.append({        │    同步子代理完成 → 不产生 Reminder
                     │   type: "reminder",   │    delegate(background=false) 直接返回结果
     TODO 续跑 ──────►│   reminder: {         │
                     │     source, delivery,  │
                     │     ...                │
                     │   }                    │
                     │ })                     │
                     └───────────┬───────────┘
                                 │
                                 ▼
                     Store.reminders[]
                     [ { id, source, delivery, payload,
                         createdAt, consumedAt } ]
                                 │
                    ┌────────────┴────────────┐
                    │                         │
          auto_inject                       on_demand
                    │                         │
                    ▼                         ▼
        toModelMessages()          wait_for_reminder 工具
        投影时追加                   阻塞等待条件满足
        <system-reminder>           → 消费 → 标记 consumedAt
        user-role 消息块            → 返回结果给 agent
        → 标记 consumedAt
```

## `wait_for_reminder` 工具

### 入参

- `session_ids: string[]` — **必填**。等待特定子代理的状态通知，使用 delegate 返回的 session_id。不在 `childSessionIds` 集合中的 ID 立即返回错误（fail fast）。
- `condition: "all" | "any" | { count: number }` — 等待条件
- `timeout_ms?: number` — 阻塞超时（默认 120s，最大 600s）

### 返回

- **条件满足**：`{ status: "completed", reminders: [...] }`（每条 reminder 只包含状态信息，不含子代理输出）
- **超时**：`{ status: "timeout", pending: [...] }`
- **session_id 不存在**：`{ status: "error", message: "Unknown session_id: xxx", unknown_ids: [...] }`（fail fast，不等待超时）

### 行为

1. **校验 session_ids**：如果在父 store 的 `childSessionIds` 中找不到某个 session_id，立即返回错误。防止 LLM 幻觉出从未被 `delegate` 返回的 ID 导致永远等不到 resolve。
2. 扫描 `reminders` 中匹配 `session_ids` 且未消费的 `on_demand` 条目
3. 检查 condition：`all`=全部到齐，`any`=任一到齐，`count`≥N
4. 条件满足 → 立即消费，返回结果
5. 条件不满足 → Promise 阻塞，直到新的 reminder 入队触发条件满足或超时
6. 消费后标记 `consumedAt`

## TODO 续跑机制

### 两个触发时机

TODO 续跑有**两个互补的触发时机**，覆盖不同场景：

| 触发时机 | 时机 | 检测方式 | 覆盖场景 |
|---------|------|---------|---------|
| **步骤级停滞检测** | 每个 LLM 轮次结束后 | TODO hash 不变 → stagnation_count++ | LLM 在无关工作上打转，忘了做 TODO |
| **Loop 结束后兜底** | query loop 正常结束时 | 有 pending/in_progress TODO | max_steps 到达或正常完成，但不遗漏 TODO |

两者产生相同类型的 `todo_continuation` reminder，共享安全检查和注入逻辑。区别仅在**何时检测**。

### 触发时机 1：步骤级停滞检测

注意：检测粒度是**每个 LLM 轮次**（一次 `streamText` 调用 = 一个 step），不是每个工具调用。一个 LLM 轮次可能产生多个工具调用，这些调用之间 LLM 没有机会更新 TODO，所以按工具调用粒度计数会导致误判。

每个 LLM 轮次结束后，计算当前 TODO 状态的 hash，与上一轮次比较：

```
每个 LLM 轮次结束后（所有工具调用执行完毕）：
  → todos 中有 pending/in_progress 条目？
  → 计算 todoHash = hash(JSON.stringify(todos.map(t => [t.id, t.status])))
  → todoHash !== lastTodoHash？
    → 是：stagnationCount = 0，更新 lastTodoHash
    → 否：stagnationCount++
  → stagnationCount >= STAGNATION_THRESHOLD (3)？
    → 是 → 安全检查通过？→ 注入 todo_continuation reminder
    → 否 → 不触发
```

**理由**：

- OMO 用 `session.idle` 事件触发（会话空闲 → 2s 倒计时 → 注入），ArchCode 没有 `session.idle` 事件，用「轮次级 hash 不变」作为「停滞」的替代指标
- 3 轮无进展是 OMO 经 bug #2216 验证过的阈值——太少会误触，太多则 LLM 已经浪费了太多 step
- hash 不变意味着 LLM 走了 3 轮但没更新任何 TODO 状态，说明它在无关工作上打转
- 按轮次计数而非工具调用计数，因为一个 LLM 轮次内的多个工具调用是同一个决策的一部分

### 触发时机 2：Loop 结束后兜底

`runQueryLoop()` 结束后（`run-end` 事件后），检查是否有未完成的 TODO。

**白名单**：只有以下终态触发 `todo_continuation`：
- `completed`（正常完成）
- `max_steps`（达到最大步数）

**不触发**的终态：
- `abort`（用户中断）
- `cancel`（外部取消）
- `timeout`（超时）
- `error`（执行错误）

理由：abort/cancel/timeout/error 意味着用户或系统已经做了决定，强制续跑是干扰而非帮助。

### 安全检查（两个触发时机共享）

注入 `todo_continuation` 前必须通过所有安全检查：

| 检查 | 说明 | OMO 对应 bug |
|------|------|-------------|
| 续跑冷却 | 距离上次 todo_continuation 注入 >= 30s | #1806 原因：无冷却导致 6-7s 间隔循环 |
| 停滞检测 | stagnationCount >= 3（每个 LLM 轮次比较 hash）/ 或 loop 结束时有 pending TODO | #2216 原因：todo_write 不可用但 API 成功 |
| 挂起问题检测 | 最近 assistant 消息有 ask_user 工具调用时跳过 | #1193 原因：在等用户输入时仍注入续跑 |
| 后台任务检测 | 有 running 子代理时跳过 | #3362 原因：只检查 running 不检查 pending |
| 最大续跑次数 | 单次 loop 内最多注入 10 次 | 无直接 bug，但所有竞品都有 turn/step 限制 |

**这些都是 OMO 用真 bug 换来的教训**，不可省略。

### 触发流程

```
步骤级停滞检测：
  每个 LLM 轮次结束后（所有工具调用执行完毕）
  → 计算并比较 todoHash
  → stagnationCount >= 3？
  → 安全检查通过？(冷却、挂起问题、后台任务、最大续跑)
  → 全部通过 → store.append({ type: "reminder", reminder: {
      source: { type: "todo_continuation", pendingTodos },
      delivery: "auto_inject"
    }})

Loop 结束后兜底：
  runQueryLoop 结束
  → 终态在白名单中？(completed / max_steps)
  → todos 中有 pending/in_progress 条目？
  → 安全检查通过？(冷却、挂起问题、后台任务、最大续跑)
  → 全部通过 → store.append({ type: "reminder", reminder: {
      source: { type: "todo_continuation", pendingTodos },
      delivery: "auto_inject"
    }})
```

### 注入内容

```
<system-reminder>
[TODO CONTINUATION]
以下任务尚未完成：
- [ ] 实现认证模块
- [ ] 编写集成测试
请继续工作。
</system-reminder>
```

## 与子代理编排的交互

**核心原则**：Reminder 只携带状态（completed/failed/timed_out/cancelled），不携带子代理输出内容。子代理的工作成果通过 `delegate` 同步返回或 `background_output` 工具按需获取。

| 场景 | 获取结果方式 | 是否需要 Reminder |
|------|------------|-----------------|
| 同步委托（`background=false`） | `delegate` 直接返回最后一条 assistant 消息 | 否——父代理在 tool call 中直接拿到结果 |
| 子代理正常完成（异步） | `background_output(session_id)` 获取最后一条 assistant 消息 | 是——`subagent_completed`，`on_demand`，`wait_for_reminder` 消费 |
| 子代理失败（异步） | `background_output(session_id)` 获取错误信息 | 是——`subagent_failed`，`on_demand`，`wait_for_reminder` 消费 |
| 子代理超时（异步） | 通常不需要获取结果 | 是——`subagent_timed_out`，`on_demand`，`wait_for_reminder` 消费 |
| 子代理被取消（异步） | 通常不需要获取结果 | 是——`subagent_cancelled`，`on_demand`，`wait_for_reminder` 消费 |
| TODO 未完成时续跑 | — | 是——`todo_continuation`，`auto_inject`，自动注入 `toModelMessages()` |

**同步模式不需要 Reminder 流程**：`delegate(background=false)` 阻塞等待子代理完成，直接在 tool call 返回值中拿到结果。父代理不需要调用 `wait_for_reminder` 或 `background_output`。

**为什么异步模式分离通知和结果**：把结果内嵌在 reminder 里会让 `wait_for_reminder` 的返回值庞大且不可控（子代理可能输出几千 token）。分离后 `wait_for_reminder` 保持轻量，LLM 可以选择不获取结果（比如子代理超时/取消就不需要看结果）。

## Reminder 数据模型

每条 Reminder 结构：

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，用于去重和消费标记 |
| `source` | 来源类型 + 来源数据（`subagent_completed` / `subagent_failed` / `subagent_timed_out` / `subagent_cancelled` / `todo_continuation`） |
| `delivery` | 投递方式（`auto_inject` / `on_demand`） |
| `sessionId` | 关联的子代理 session_id（子代理 reminder 专有，替代原来的 taskId） |
| `terminalState` | 终态（completed / failed / timed_out / cancelled） |
| `content` | 人类可读的摘要文本（如 "子代理 explore_auth 已完成"） |
| `payload` | 结构化数据（如 pendingTodos 列表） |
| `createdAt` | 创建时间戳 |
| `consumedAt` | 消费时间戳（null = 未消费） |
| `targetSessionId` | 目标 session（用于子代理 reminder 写入父 store） |

**去重规则**：相同 `id` 的 reminder 在 `reduceStreamEvent` 中跳过。`consumedAt` 非空 = 已消费。

## 父子关联

`delegate` 创建子代理时，双方 store 互相记录：

**父 store**（新增 `childSessionIds: Set<string>`）：记录所有子代理的 session_id。`wait_for_reminder` 和 `background_output` 校验 session_id 时查此集合。

**子 store**（新增 `parentSessionId: string`）：记录父代理的 session_id。子代理终态时 SubAgentManager 通过此 ID 定位父 store 写入 ReminderEvent。

不需要额外的 task_id 映射——session_id 已经唯一标识子代理，delegate 直接返回 session_id。

## 终态 Reminder 写入规则

子代理终态的 ReminderEvent 由 **SubAgentManager** 写入父 store，而不是子代理的 query loop。

理由：子代理的 query loop 可能崩溃或超时中断，此时它自己无法写入 reminder。SubAgentManager 作为管理者负责监控子代理状态并保证终态 event 一定会写入。

**First-writer-wins**：如果子代理正常完成时自己写了一次终态，SubAgentManager 的兜底写入不会重复——相同 sessionId 的 reminder 已存在时跳过。

## Store 生命周期

子代理的 SessionStore 在父代理 session 期间保持可访问。未消费的 reminders 在 session 结束时清理。

`background_output` 需要访问子代理的 session store，所以子代理 store 的生命周期绑定到父代理 session，不随子代理完成而销毁。

## 消费走 store 通道

所有 reminder 状态变更都通过 `append()` → `reduceStreamEvent()` 通路：

- 产生：`append({ type: "reminder", reminder: {...} })`
- 消费：`append({ type: "reminder-consumed", reminderIds: [...] })`

这条规则保证：
1. 所有状态变更是可追踪的（subscribe 监听）
2. `wait_for_reminder` 的阻塞实现可以 `subscribe` store 变更
3. 不在投影函数中直接修改状态

## 与现有代码的接口

### 新增

| 组件 | 职责 |
|------|------|
| `ReminderEvent` | 新 StreamEvent 类型，产生 reminder |
| `ReminderConsumedEvent` | 新 StreamEvent 类型，消费 reminder |
| `Reminder` | 数据结构（见 Reminder 数据模型章节） |
| `delegate` 工具 | 创建子代理。`background=false`（默认）：阻塞返回结果，不产生 Reminder。`background=true`：返回 session_id，终态产生 Reminder |
| `wait_for_reminder` 工具 | 阻塞等待 reminder 条件满足，session_ids 必填，fail fast（只用于异步模式） |
| `background_output` 工具 | 通过 session_id 读取子代理最后一条 assistant 消息 |

### 修改

| 组件 | 修改 |
|------|------|
| `StreamEvent` 联合类型 | 新增 `ReminderEvent \| ReminderConsumedEvent` |
| `SessionStoreState` | 新增 `reminders: Reminder[]`、`childSessionIds: Set<string>`、`parentSessionId?: string`、`subAgentDescriptions: Map<string, string>`（持久化需求见 sub-agent-orchestration 文档） |
| `reduceStreamEvent` | 新增 `"reminder"` 和 `"reminder-consumed"` 处理 |
| `toModelMessagesFromStoredMessages` | 接收 `reminders` 参数，追加 `auto_inject` 消息（纯投影，不修改状态） |
| `runQueryLoop` | Loop 结束后检查 TODO 续跑条件；每步工具调用后计算 todoHash 做停滞检测 |

### 不修改

| 组件 | 理由 |
|------|------|
| `runQueryLoop` 循环逻辑 | 停滞检测在每步工具调用后的 hook 点做，不是在循环内部 |

## V1 范围

**做**：
- Reminder 数据模型、父子关联（childSessionIds / parentSessionId）、store 扩展、事件类型
- `delegate` 工具（`background=false` 同步阻塞返回结果 / `background=true` 异步返回 session_id）
- `toModelMessages()` 自动注入 `auto_inject` reminders（纯投影，通过 append 消费）
- `wait_for_reminder` 工具（阻塞 + condition + timeout，session_ids 必填，fail fast，只用于异步模式）
- `background_output` 工具（读取子代理最后一条 assistant 消息，只用于异步模式）
- TODO 续跑机制（两个触发时机：步骤级停滞检测 + loop 结束后兜底，白名单：completed / max_steps，5 项安全检查）
- 子代理 `subagent_*` reminder 由 SubAgentManager 写入（first-writer-wins），只在异步模式下产生

**不做**：
- 未消费 reminder 的自动提示（"你有未读提醒"）—— V1 让 system prompt 的工具说明指导 LLM
- timer / approval_request 等新 reminder source —— V2 扩展点
- Reminder 持久化集成到 `SessionFileSchema` / `saveSessionTranscript` / `loadSessionTranscript`（`src/store/helpers.ts`），与现有 session 持久化统一。优先级：`reminders` / `childSessionIds` / `parentSessionId`（功能必需）> `subAgentDescriptions`（体验增强）。Set/Map 需序列化为 Array/Entries
- OS 级通知推送