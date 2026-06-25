# Session Store 重构：事件驱动的 Part 持久化方案

## 背景

当前 agent 无短期记忆——每次 `run()` 调用 `runQueryLoop` 时创建全新 `messages[]`，调用结束后丢弃。同时 `TranscriptEvent[]` 只服务于 UI 渲染，无法恢复 LLM 对话上下文。

本方案将 store 重新定位为 **session 存储层**（不只是 UI transcript），以事件驱动 + per-part 持久化的方式管理对话历史。

## 核心原则

1. **单一写入入口** — `append(event)` 是唯一写入方式，不可能不同步
2. **Loop 不关心 store 内部** — loop 只报告发生了什么事件，不管 store 怎么消化
3. **Per-part 持久化** — 每个 part（text、tool、reasoning）在 `*-end` 时独立持久化，不等 step 结束
4. **Delta 是临时层** — `*-delta` 事件仅更新 streaming 缓冲（实时 UI 用），不写入持久层
5. **StoredMessage/StoredPart 为 primary** — store 保存完整 session history；`toModelMessages()` 负责把可发送给模型的上下文投影出来。`ModelMessage` 是投影输出，不是持久层格式

参考实现：[opencode](https://github.com/sst/opencode) 的 `session/processor.ts` + `session/message-v2.ts`。

## 四层分离

| 层 | 数据 | 用途 | 生命周期 | LLM 可见 |
|---|---|---|---|---|
| 持久层 | `StoredMessage + StoredPart[]` | 完整 session history | 跨 `run()` 持久 | ❌ 原始格式 |
| 投影层 | `toModelMessages() → ModelMessage[]` | LLM 调用输入 | 每次调用前生成 | ✅ |
| 临时层 | `streamingText/Reasoning/Tools` | TUI 实时渲染 | 步骤内，`*-end` 清除 | ❌ |
| 事件层 | `StreamEvent`（瞬时输入） | Loop → Store 通信 | 输入后即消化 | ❌ |

没有长期双写源——事件是原料，持久层是成品，投影层是定制视图，临时层是半成品。

## 事件类型

Loop 发出的事件（不含 `id`/`timestamp`，由 store 补充）：

- **Run 生命周期**：`run-start` / `run-end`
- **用户输入**：`user-message`
- **文本流（三阶段）**：`text-start` → `text-delta`(N) → `text-end`
- **推理流（三阶段）**：`reasoning-start` → `reasoning-delta`(N) → `reasoning-end`
- **工具调用流（三阶段）**：`tool-input-start` → `tool-call` → `tool-result`
- **步骤生命周期**：`step-start` / `step-end`（含 finishReason + usage）
- **错误**：`loop-error`

`tool-result` 带 `isError: boolean` 字段，统一处理成功和失败结果，不需要单独的 `tool-error` 事件。

### 三阶段模式

每种内容类型遵循相同的三阶段生命周期：

| 阶段 | Store 行为 | 持久层 | 临时层 |
|---|---|---|---|
| `*-start` | 创建空 part，写入 messages | ✅ 立即 | — |
| `*-delta` | 累积到 streaming 缓冲 | ❌ 不写 | ✅ 更新 |
| `*-end` | 组装完整 part，更新 messages | ✅ 持久化 | 清除缓冲 |

### Run vs Step

- **Run** = 一次 `agent.run()` 调用，包含用户消息 + 可能多个 step
- **Step** = 一次 LLM 调用 + 可能的工具执行

TUI 用 `isRunning` 判断是否允许输入，用 `isStreamingModel` 判断是否显示 thinking 动画。

## 持久层状态模型

### StoredPart 类型

- **TextPart**：`{ type, id, text, createdAt, completedAt? }`
- **ReasoningPart**：`{ type, id, text, createdAt, completedAt? }` — 与 TextPart 同构，语义不同
- **ToolPart（四态 discriminated union）**：
  - `pending`：工具调用已声明，参数未到
  - `running`：参数已到，工具执行中
  - `completed`：执行成功，有 output
  - `error`：执行失败，有 error message
  - 四态都保留 `createdAt`，running/completed/error 额外有 `startedAt/endedAt`

Step 元数据（`StepInfo[]`）不属于 StoredPart，只是 session 级别的非对话元数据。

### StoredMessage

- `{ id, role: "user" | "assistant", parts: StoredPart[], createdAt, completedAt?, runId? }`
- assistant message 可能包含多个 part（text + reasoning + tool calls）
- 确保创建时机：所有 assistant part start 事件（text-start / reasoning-start / tool-input-start）都先调用 `ensureCurrentAssistantMessage()`，防止 reasoning/tool 先于 text 到达时挂不到 message

### 运行状态

- `isRunning`：整个 run 进行中（含工具执行），TUI 据此禁止输入
- `isStreamingModel`：LLM 正在输出 token，TUI 据此显示 thinking 动画
- `currentRunId` / `currentAssistantMessageId`：当前 run/消息追踪
- **Busy guard**：`run-start` 时检查 `isRunning`，如果已在运行则 throw `BusyError`

## 投影层：`toModelMessages()`

Store 持久层格式与 AI SDK `ModelMessage[]` 不同，需要投影转换。

### 投影规则

| StoredPart 状态 | 投影行为 |
|---|---|
| TextPart (completed) | ✅ 正常投影 |
| TextPart (未完成) | ❌ 过滤 |
| ReasoningPart | ❌ 默认过滤（AI SDK 不支持，未来可按 provider 能力开启） |
| ToolPart (completed) | ✅ → assistant tool-call + tool result |
| ToolPart (error) | ✅ → assistant tool-call + tool result (`error-text`) |
| ToolPart (pending/running) | ❌ 过滤（未完成 tool 会导致 provider 报错） |

### 投影策略

对每个 assistant StoredMessage，**按 parts 原始顺序**构造：
1. 一个 `role: "assistant"` message，包含所有 tool-call（completed + error 的）
2. 一个 `role: "tool"` 消息，包含对应 tool-result（completed 用 `text` type，error 用 `error-text` type）

**AI SDK v6 注意**：`ToolCallPart` 字段名是 `input`（不是 `args`）；`ToolResultPart` 没有 `isError` 字段，错误输出用 `{ type: "error-text", value }`。

## Loop 改造

### 核心变化

- **不再维护本地 `messages[]`**，从 store 投影：`store.getState().toModelMessages()`
- **只发事件，不管 store 内部**
- **QueryLoopResult 移除 `messages` 字段**，store 是唯一数据源

### Loop 流程

1. `run-start`（含 busy guard）
2. `user-message`
3. 循环 step：
   - 从 store 投影历史 → `step-start`
   - 调用 LLM `streamText()`
   - 处理 stream chunks → 发出 text/reasoning/tool 三阶段事件
   - `step-end`（含 finishReason + `await usage`）
   - 如果 finishReason 是 `tool-calls`，执行工具 → `tool-result`
4. `run-end`（成功/失败）

### AI SDK v6 Stream 注意

- AI SDK fullStream 的 chunk type 是 `reasoning-delta`（不是 `reasoning`）
- `result.usage` 是 PromiseLike，需要 `await`
- `result.finishReason` / `result.text` / `result.toolCalls` 都是异步的

### 边界防御

- **多段 text**：如果收到 `text-start` 时已有 streaming text，先 finalize 前一个
- **reasoning 先于 text**：`ensureCurrentAssistantMessage()` 确保不丢事件
- **tool 兜底**：`tool-result` 找不到 streamingTools 时，按 `toolCallId` 在当前 assistant message parts 里兜底查找
- **run-end 兜底**：清除所有残留临时状态
- **maxSteps**：达到上限时发 `loop-error`，`run-end` status 可为 `completed`（这是限制不是失败）

## TUI 渲染

- 持久层 `messages[]` → 已完成内容
- 临时层 `streamingText/streamingReasoning/streamingTools` → 正在生成的内容
- Reasoning 渲染为折叠区域
- `isRunning && isStreamingModel` → Thinking 动画
- `isRunning && !isStreamingModel` → ExecutingTools 状态
- `!isRunning` → 允许用户输入

## 移除项

| 移除 | 原因 |
|---|---|
| `TranscriptEvent` 及所有子类型 | 被 `StreamEvent` + `StoredPart` 替代 |
| `appendEvent()` helper | 直接用 `store.append(event)` |
| `QueryLoopResult.messages` | store 是 source of truth |
| `events: TranscriptEvent[]` | 被 `messages: StoredMessage[]` 替代 |
| 本地 `messages[]` in loop.ts | 从 store 投影 |
| `StoredMessage.message: ModelMessage` | 改为 `StoredMessage.parts: StoredPart[]` |

## 短期记忆如何生效

1. 用户调用 `agent.run("hello")` → store.messages 增长
2. 用户再调用 `agent.run("follow up")` → `toModelMessages()` 投影出完整历史
3. 传给 `streamText({ messages })` — 模型看到完整对话上下文

零额外代码，记忆自动生效。

## 与 opencode 的差异

| 方面 | opencode | ArchCode |
|---|---|---|
| 存储后端 | SQLite (Drizzle ORM) | Zustand 内存 |
| 消息格式 | MessageV2.WithParts | StoredMessage + StoredPart[] |
| LLM 投影 | `toModelMessages()` | `toModelMessages()` |
| Delta 分发 | Bus 事件 (WebSocket) | Zustand selector (内存) |
| 崩溃恢复 | 从 SQLite 重建 | ❌ 内存丢失（未来可加持久化） |
| Compaction | filterCompacted + 摘要替换 | ❌ 暂不实现 |
| 并发管理 | SessionRunState (Runner Map) | isRunning busy guard |

## 未来扩展点

- **持久化**：`StoredMessage[]` 序列化为 JSON，已预留 `runId`/`completedAt` 等字段
- **Compaction**：StoredPart 加 `compacted` 标记，`toModelMessages()` 跳过
- **Context window trimming**：`toModelMessages()` 按 token budget 截断，只修改投影不修改原始历史
- **Reasoning 投影**：按 provider 能力决定是否投影 reasoning

## 不做的事

- ❌ SQLite / 文件系统持久化（本方案只做内存 store）
- ❌ Compaction / context trimming
- ❌ 文件快照 / patch
- ❌ 多 session 并发管理
- ❌ WebSocket / Bus 分发（Zustand selector 足够）
