# Sub-Agent Orchestration

## 问题

ArchCode 当前是单代理架构（TestAgent + 单个 SessionStore + 单个 query loop）。要支持子代理委托，需要解决：

1. 子代理怎么跑？（进程模型、状态隔离、生命周期管理）
2. 父代理怎么拿到子代理的结果？（同步 vs 异步、通知机制）
3. 怎么防止失控？（嵌套深度、并发数、超时、取消）
4. 怎么与现有 store / loop / tool 体系对接？

## 竞品参考

| 竞品 | 进程模型 | 状态隔离 | 通知方式 | 深度控制 |
|------|---------|---------|---------|---------|
| Claude Code | 进程内 fork，继承父 context | 独立 conversation，共享 cache | task-notification XML 注入父消息队列 | 无硬限制 |
| OpenCode | 进程内，TaskTool 创建子 session | 独立 session，仅继承 deny rules | system-reminder 事件，wait_for_reminder 消费 | 无硬限制 |
| OMO | 进程内，3 种 spawn 路径 | 独立 session store | system-reminder + promptAsync 注入 | SubagentDepthTracker max 3 |
| PI-Mono | 子进程 child_process.spawn | 进程级隔离，零共享 | JSON event-stream stdout | 无硬限制 |
| Slim | OpenCode SDK 内置 task | 独立 session | council_session Promise.allSettled | SubagentDepthTracker max 3 |

## 决策

### 进程模型：进程内 Session

**选择**：每个子代理在进程内创建独立的 SessionStore，运行独立的 query loop 实例。

**考虑过的替代方案**：
- **子进程**（PI-Mono 模式）：通信用 JSON stdout，隔离更彻底，但 IPC 开销大，共享 provider registry 困难，取消语义复杂（SIGTERM→SIGKILL）
- **Fork 继承父 context**（Claude Code 模式）：prompt cache 共享省 token，但状态泄漏风险高

**理由**：进程内 + 独立 store 是最自然的与 Zustand 集成的方式。子代理直接复用 provider registry（同一个 API key），不需要 IPC 序列化。共享 AbortSignal 天然支持级联取消。

### 状态隔离

**选择**：每个子代理独立 SessionStore。兄弟之间完全隔离——看不到彼此的 messages、todos、reminders。父只能通过 `background_output` 工具读取子代理的最后一条 assistant 消息（异步模式），或通过 `delegate` 返回值获取结果（同步模式），不能访问子的中间状态。

**理由**：隔离防止上下文污染。子代理跑在自己的 store 里，不会撑爆父的 token 预算。父只关心结果，不关心过程。

### 执行模型：delegate(background) + wait_for_reminder + background_output

**选择**：`delegate` 工具支持 `background` 参数，默认 `false`（同步）。

| 模式 | `background` | 行为 | 适用场景 |
|------|-------------|------|---------|
| 同步（默认） | `false` | 阻塞等待子代理完成，直接返回结果 | "帮我做这件事，我要结果" |
| 异步 | `true` | 立即返回 session_id，结果通过 reminder + background_output 获取 | 并行探索、委托后继续做其他事 |

**为什么同步是默认**：

1. 大多数委托是"父代理需要结果才能继续推理"——同步是 90% 场景的正确选择
2. 同步只需 1 个 tool call，异步需要 3 个（delegate → wait_for_reminder → background_output），每个都是一轮 LLM 推理
3. LLM 心智模型更简单：`delegate()` 返回结果，就像函数调用。异步需要记住 session_id、组合多个工具
4. OMO 经过实战验证后把 `run_in_background` 改为**必填参数**，就是因为 LLM 经常搞错模式——他们推荐默认同步

**三个工具的职责**：

**`delegate(prompt, background=false)`**：
- `background=false`（同步）：创建子代理并阻塞等待完成，直接返回子代理最后一条 assistant 消息
- `background=true`（异步）：创建子代理，立即返回 session_id，子代理异步运行

**`wait_for_reminder`**：阻塞等待子代理的**状态通知**（completed/failed/timed_out/cancelled），不返回子代理的输出内容。只在异步模式下使用。

**`background_output`**：通过 session_id 读取子代理 store 中最后一条 assistant 消息，获取子代理的工作成果。只在异步模式下使用。

**分离通知和结果的理由**（异步模式）：

竞品一致采用「通知 = 轻量状态，结果 = 独立获取」的模式：
- OMO：`background_output` / `formatTaskResult` 获取所有新消息的文本+推理+工具结果拼接，运行中状态只返回截断摘要
- OpenCode：sync task 返回最后一条 assistant 消息的文本内容
- Claude Code：task notification 只带状态，结果通过 SendMessageTool 获取

把结果内嵌在 reminder 里会让 `wait_for_reminder` 的返回值变得庞大且不可控（子代理可能输出几千 token）。分离后：
- `wait_for_reminder` 保持轻量，只关心"子代理完了没，成功还是失败"
- `background_output` 按需获取结果，LLM 可以选择不获取（比如子代理失败了就不需要看结果）

**交互模式**：

```
## 同步模式（默认）—— 单一委托，需要结果才能继续
result = delegate(agent="explore", prompt="研究认证模块")
# result 直接是子代理的工作成果（最后一条 assistant 消息）
# 一个 tool call 完成整个流程

## 异步模式 —— 并行委托，或委托后继续做其他事
child_a = delegate(agent="explore", prompt="研究认证模块", background=true)
child_b = delegate(agent="explore", prompt="研究数据库模式", background=true)
# ... 做一些其他工作 ...
status = wait_for_reminder(session_ids=[child_a, child_b], condition="all")
# status 只包含状态信息，不包含子代理输出
result_a = background_output(session_id=child_a)  # 获取子代理 a 的最后一条 assistant 消息
result_b = background_output(session_id=child_b)  # 获取子代理 b 的最后一条 assistant 消息

## 异步模式 —— 快速失败
child_a = delegate(agent="explore", prompt="尝试修复", background=true)
status = wait_for_reminder(session_ids=[child_a], condition="any", timeout_ms=30000)
if status.status === "timeout":
  # 处理超时，不需要 background_output
```

### 通知：Reminder 事件入父 Store，不自动触发 LLM 轮次

**选择**：子代理完成时产生 `ReminderEvent`，写入父 store 的 `reminders[]`。Reminder 只携带状态（completed/failed/timed_out/cancelled），不携带子代理输出内容。不自动触发新的 LLM 调用——只有当 LLM 主动调用 `wait_for_reminder` 时才消费。

**注意**：同步模式（`background=false`）不需要 Reminder 流程——`delegate` 直接返回结果。Reminder 只在异步模式（`background=true`）中用于让父代理知道子代理终态。

**考虑过的替代方案**：
- **自动注入消息流**（Claude Code / OMO 模式）：子代理完成时自动在父对话中注入一条消息，强制触发下一轮 LLM 调用。简单但不灵活——LLM 可能不需要立即处理这个结果
- **polling**（Cursor MCP 模式）：LLM 周期性调用 `getTask(id)` 查询状态。简单但浪费 token

**理由**：显式消费比隐式推送更可控。LLM 知道自己在等什么，什么时候需要结果。不自动触发 LLM 轮次避免 token 浪费——如果 LLM 在做其他事，子代理的结果安静地排在队列里，等 LLM 准备好了再取。

（注：TODO 续跑等自动推送场景通过 Reminder 系统的 `auto_inject` 投递方式解决，见 reminder-system 文档。）

### 嵌套深度：最多 2 层

**选择**：父 → 子 → 孙，最多 2 层（depth=0 为根，depth=1 为子，depth=2 为孙）。depth=3 直接拒绝。

**深度限制的工具权限**：
- depth=0,1：可以使用 `delegate`、`wait_for_reminder`、`background_output`
- depth=2：不提供 `delegate`、`wait_for_reminder`、`background_output` 工具

**深度与阻塞行为**：
- 同步模式（`background=false`）在任意允许的深度都阻塞父代理的 tool call
- 异步模式（`background=true`）在任意允许的深度都不阻塞父代理

**理由**：3 层以上的嵌套在实践中几乎不需要，且递归爆炸风险极高。OMO 和 Slim 都实践了 max depth 3（含根），我们更保守取 2 层。通过工具权限而非运行时检查来防止更深的嵌套——子代理不会看到它不该有的工具。

### 并发：最多 10 个同时运行，溢出 fail fast

**选择**：单个父代理最多同时运行 10 个子代理。超出限制的 `delegate` 调用直接返回工具错误（fail fast），不排队等待。

**理由**：排队等待会占用 LLM 的 context window（LLM 在等一个不知道什么时候会空出来的槽），不如明确告诉 LLM "现在满了，请稍后重试"或"请等其他任务完成后再委托"。OMO 用 5 个并发槽（按 modelId 分），Claude Code 不限制。10 个是 token 预算和 API 并发的合理上限。

### 取消：AbortSignal 级联

**选择**：父代理的 AbortSignal 作为子代理的 parentSignal。父 cancel → 子 cancel → 孙 cancel。

**理由**：AbortSignal 是 Web API 标准，Zustand store 的 `append()` 已经接受异步上下文。级联取消不需要额外协议——子代理的 query loop 在 AbortSignal abort 时自然退出。

### 超时：硬编码常量

**选择**：V1 直接硬编码 `maxDepth=2`、`maxConcurrent=10`、`timeoutMs=300000`（5 分钟）。不做 `.archcode.json` 配置。

**理由**：配置项是 YAGNI。等真正需要调参时再加配置。硬编码值在 V1 够用。

### 子代理结果获取

**选择**：

| 模式 | 结果获取方式 | 返回内容 |
|------|------------|---------|
| 同步（`background=false`） | `delegate` 直接返回 | 子代理最后一条 assistant 消息 |
| 异步（`background=true`） | `background_output(session_id)` | 子代理最后一条 assistant 消息 |

两个模式最终获取结果的方式一致——都是子代理最后一条 assistant 消息的文本内容。区别在于同步模式内嵌在 `delegate` 返回值中，异步模式需要额外调用 `background_output`。

**考虑过的替代方案**：
- **完整对话历史**：返回子代理所有消息。信息量大但 token 开销太大，父代理的 context window 承受不住
- **摘要**：用 LLM 摘要子代理输出。额外 token 开销，摘要质量不可控
- **最后 N 条消息**：折中方案，但 N 的选择本身是个问题。最后一条 assistant 消息已经包含了子代理的最终结论

**理由**：与 OpenCode 和 OMO 的 sync 模式一致——取最后一条 assistant 消息。子代理的最终结论就在这里，前面的中间步骤对父代理不必要。

### 虚假 session_id：fail fast

**选择**：`wait_for_reminder` 和 `background_output` 必须接收 `session_ids` / `session_id` 参数。如果 LLM 传入不属于 `childSessionIds` 的 session_id，工具直接返回错误（而不是等待超时）。

**理由**：LLM 有时会"幻觉"出不存在的 ID。等待一个不存在的 ID 永远不会 resolve，浪费一个 tool step 和超时等待。fail fast 让 LLM 立刻知道出错了。

### 终态写入：SubAgentManager 负责

**选择**：子代理终态的 ReminderEvent 由 SubAgentManager 写入父 store，而不是由子代理的 query loop 写入。

**理由**：子代理的 query loop 可能崩溃或超时中断，此时它自己无法写入 reminder。SubAgentManager 作为管理者负责监控子代理状态并保证终态 event 一定会写入。

**First-writer-wins**：如果子代理正常完成时自己写了一次终态，SubAgentManager 的兜底写入不会重复——相同 sessionId 的 reminder 已存在时跳过。

### 子代理权限：继承父级

**选择**：子代理继承父代理的权限配置。权限确认（如文件写入）通过父代理的共享 root 通道传递，确认消息附带子代理的 task label（格式：`[sub-agent: task_abc]`）。

### Store 生命周期

**选择**：子代理的 SessionStore 在父代理 session 期间保持可访问。父代理 session 结束时，所有子代理 store 一起销毁。未消费的 reminders 在 session 结束时清理。

## 数据流

### 同步委托（background=false，默认）

```
父代理 LLM 调用 delegate(prompt, background=false)
  ↓
delegate 工具：
  1. 检查并发限制（< 10） — 超出 → 返回工具错误
  2. 检查嵌套深度（< 2） — 超出 → 不提供工具（depth=2 agent 没有 delegate）
  3. SubAgentManager.createAgent() — 创建子 store + 子 query loop
  4. 子代理 store 记录 parentSessionId；父代理 store 记录 childSessionIds + subAgentDescriptions
     - subAgentDescriptions 存储 session_id → description 映射，用于 TUI 显示子代理任务标题
  5. 子代理开始运行 → delegate 工具执行阻塞等待
  6. 子代理完成后，delegate 直接返回子代理最后一条 assistant 消息
  ↓
父 LLM 拿到结果，继续推理
（1 个 tool call 完成整个流程，无需 wait_for_reminder 或 background_output）
```

### 异步委托（background=true）

```
父代理 LLM 调用 delegate(prompt, background=true)
  ↓
delegate 工具：
  1. 检查并发限制（< 10） — 超出 → 返回工具错误
  2. 检查嵌套深度（< 2） — 超出 → 不提供工具（depth=2 agent 没有 delegate）
  3. SubAgentManager.createAgent() — 创建子 store + 子 query loop
  4. 子代理 store 记录 parentSessionId；父代理 store 记录 childSessionIds + subAgentDescriptions
  5. 子代理开始运行（异步，不阻塞父）
  6. 立即返回 session_id 给父 LLM
  ↓
父 LLM 继续（可能调用更多 delegate 或做其他工作）
  ↓
子代理完成后：
  1. SubAgentManager 检测到子代理终态
  2. SubAgentManager 往父 store.append() 写入 ReminderEvent：
     { type: "subagent_completed" | "subagent_failed" | ..., sessionId: 子代理 sessionId, delivery: "on_demand" }
  3. 如果父 LLM 正在 wait_for_reminder：条件匹配 → Promise resolve → 返回状态
  4. 如果父 LLM 不在等待：reminder 留在队列中，等待后续消费
  ↓
父代理 LLM 调用 background_output(session_id)：
  1. 从子代理 store 读取最后一条 assistant 消息
  2. 返回文本内容
```

### 级联取消

```
用户按 Ctrl+C
  → 父 AbortSignal.abort()
  → 子代理 query loop 检测到 abort，自然退出
  → SubAgentManager 检测到子代理退出
  → SubAgentManager 往父 store.append() 写入 { type: "subagent_cancelled", sessionId: 子代理 sessionId }
  → 父 store 收到 cancelled reminder
```

## 生命周期

子代理 4 个终态：

```
pending → running → completed  （正常完成，SubAgentManager 写入 completed reminder）
                   → failed     （执行错误，SubAgentManager 写入 failed reminder）
                   → timed_out   （超过全局 timeoutMs，SubAgentManager 写入 timed_out reminder）
                   → cancelled   （父级联取消，SubAgentManager 写入 cancelled reminder）
```

每次状态转移都写入子 store 对应的 StreamEvent（SubAgentStarted / SubAgentCompleted / SubAgentFailed / SubAgentTimedOut / SubAgentCancelled）。

SubAgentManager 负责监控子代理状态，在终态时同时往**父 store** 写 ReminderEvent。如果子代理正常完成自己写了一次，SubAgentManager 的兜底写入遵循 first-writer-wins——已存在的相同 sessionId reminder 不重复写入。

## 与现有代码的接口

### 新增

| 组件 | 职责 |
|------|------|
| `SubAgentManager` | 创建/运行/取消子代理，管理深度和并发限制，写入终态 reminder |
| `delegate` 工具 | 创建子代理。参数见下方 |
| `wait_for_reminder` 工具 | 阻塞等待条件满足，消费 reminder（只返回状态），参数为 session_ids（只用于异步模式） |
| `background_output` 工具 | 通过 session_id 读取子代理最后一条 assistant 消息（获取工作成果，只用于异步模式） |
| `AgentRegistry` | 注册可用的代理类型，提供 `resolve(name: string): AgentFactory` 方法。delegate 工具通过此注册表获取代理 |

### `delegate` 工具参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent` | `AgentType` | 是 | 子代理类型，来自 AgentRegistry 注册的名称 |
| `prompt` | `string` | 是 | 传给子代理的任务描述 |
| `description` | `string` | 否 | 简短任务摘要（3-5 词），用于 TUI 显示和 session 标题 |
| `background` | `boolean` | 否 | 默认 `false`（同步阻塞返回结果）。`true` = 异步，立即返回 session_id |

### AgentType 注册机制

**问题**：`delegate` 的 `agent` 参数需要知道有哪些可用的代理类型。硬编码 enum 不够灵活——不同部署可能需要不同代理。

**选择**：AgentRegistry 注册模式。代理在启动时注册到 AgentRegistry，delegate 工具的 schema 动态引用注册的代理名称。

```
启动时：
  AgentRegistry.register("explore", { factory: createExploreAgent, description: "代码搜索和探索" })
  AgentRegistry.register("general", { factory: createGeneralAgent, description: "通用任务" })
  ...

delegate 工具 schema 生成时：
  agent: z.enum(AgentRegistry.names())  // ["explore", "general", ...]
```

**考虑过的替代方案**：
- **硬编码 enum**：不灵活，加新代理要改工具定义。但 V1 可以先用硬编码，后面迁移到注册模式
- **配置文件驱动**：`.archcode.json` 定义代理名称和对应模型。但代理不只是模型——它包含 prompt 模板、工具集、行为配置，不适合放在配置文件里
- **LLM 自由文本**：让 LLM 任意输入代理名，运行时再校验。太宽松，LLM 容易幻觉出不存在的代理名

**V1 策略**：先用硬编码 enum（`explore` | `general`），同时建好 AgentRegistry 接口。V2 开放注册。

### 修改

| 组件 | 修改内容 |
|------|---------|
| `Agent` 接口 | `run()` 扩展 depth / parentStore / abort 参数 |
| `ToolExecutionContext` | 新增 depth 字段，让工具感知嵌套层级 |
| `SessionStoreState` | 新增字段，标注持久化需求（见下方）|

### SessionStoreState 新增字段与持久化

| 字段 | 类型 | V1 存储 | 未来持久化 | 说明 |
|------|------|---------|-----------|------|
| `reminders` | `Reminder[]` | 内存 | ✅ 需要 | 崩溃恢复后需还原未消费的 reminders，否则子代理结果丢失 |
| `childSessionIds` | `Set<string>` | 内存 | ✅ 需要 | `wait_for_reminder` / `background_output` 校验依赖此集合，丢失则 fail fast 误判 |
| `parentSessionId` | `string?` | 内存 | ✅ 需要 | SubAgentManager 写入 reminder 到父 store 时需要此 ID，丢失则级联中断 |
| `subAgentDescriptions` | `Map<string, string>` | 内存 | ⚠️ 可选 | TUI 展示用，丢失只影响显示，不影响功能 |

**持久化集成**：新字段需加入现有的 `SessionFileSchema`（`src/store/helpers.ts`）和 `saveSessionTranscript` / `loadSessionTranscript` 流程：

- `SessionFileSchema` 新增：`reminders`、`childSessionIds`（序列化为 array）、`parentSessionId`、`subAgentDescriptions`（序列化为 array of entries）
- `saveSessionTranscript` 新增 state pick：`state.reminders`、`state.childSessionIds`、`state.parentSessionId`、`state.subAgentDescriptions`
- `loadSessionTranscript` 新增还原逻辑：反序列化后 `new Set(childSessionIds)`、`new Map(subAgentDescriptions)`，缺失字段降级为默认值（空数组/Set/Map/undefined）
- `Set` 和 `Map` 不能直接 JSON 序列化，需转为 `Array` 和 `Array<[K, V]>` 后存入 JSON

**V1 策略**：所有字段先内存实现，持久化 schema 一起建好但序列化/反序列化逻辑后续补齐。功能必需（reminders / childSessionIds / parentSessionId）优先于体验增强（subAgentDescriptions）。
| `StreamEvent` 联合类型 | 新增子代理相关事件（见 reminder-system 文档）|
| `SubAgentManager` 常量 | `MAX_DEPTH=2`、`MAX_CONCURRENT=10`、`TIMEOUT_MS=300000` 硬编码 |

### 不修改

| 组件 | 理由 |
|------|------|
| `runQueryLoop` | 子代理运行独立的 query loop 实例，不需要修改 loop 本身 |
| `toModelMessages` | auto_inject reminder 的投影在 reminder-system 中处理 |

## V1 范围

**做**：
- SubAgentManager 创建/运行/取消子代理
- `delegate` 工具（参数：agent、prompt、background）
- AgentRegistry：先硬编码 enum（`explore` | `general`），接口留好给 V2 开放注册
- `wait_for_reminder` / `background_output` 工具（只用于异步模式，参数统一用 session_id）
- 同步模式：delegate 阻塞等待子代理完成，直接返回最后一条 assistant 消息
- 异步模式：delegate 立即返回 session_id，终态通过 Reminder 通知，结果通过 background_output 获取
- 并发限制（10）fail fast
- 嵌套深度限制（2 层，通过工具权限控制）
- AbortSignal 级联取消
- 超时硬编码 5 分钟（V1 不做配置）
- 终态 reminder 由 SubAgentManager 写入（first-writer-wins），只在异步模式下产生
- 父 store 记录 childSessionIds，子 store 记录 parentSessionId

**不做**：
- 子代理间通信（兄弟隔离）
- 子代理进度中间通知（只通知终态）
- 子代理结果流式回传（V1 等终态后一次性获取）