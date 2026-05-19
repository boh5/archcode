# SSE 架构重构：事件直推 + 去中间层

## 问题

当前 SSE 层有一个根本性缺陷：**从状态反推事件是逆向操作，必然丢信息。**

数据流：

```
Agent 产生 StreamEvent (text-delta, tool-call, ...)
    ↓
reduceStreamEvent() → 结构化状态 (messages[], streamingText, ...)
    ↓
flattenStoreEvents() ← 试图从状态重建事件，逆向操作
    ↓
pushNewEvents() → 差分 → SSE → 前端
```

`flattenStoreEvents()` 只读 `messages[].parts[]`（已完成的内容），忽略 `streamingText` / `streamingReasoning` / `streamingTools`（流式中的内容）。结果：**流式期间 pushNewEvents 算出空 diff，前端收不到任何增量更新。**

这是 TUI 遗留设计——TUI 直接订阅 Zustand store 的 streaming 字段渲染，根本不走 SSE。Web UI 的 SSE 层是后来加的，用 `flattenStoreEvents` 从最终状态反推事件，天然丢失流式数据。

## 核心思路

**存原始事件，正向推送。**

```
Agent 产生 StreamEvent
    ↓
Store.append(event)
    ├─ events.push(event)              ← 存原始事件
    └─ reduceStreamEvent(state, event)  ← 更新结构化状态
    ↓
subscribe 检测 events 数组增长
    ↓
取新增的 events.slice(prevLength) → SSE 推送
    ↓
前端收到原始 StreamEvent → reduceStreamEvent → 更新状态 → 渲染
```

不再从状态反推事件，而是事件本身就是数据源。

## 改动概要

### 1. Store 增加 events 数组

`SessionStoreState` 新增 `events: StreamEvent[]`。`append()` 做两件事：存原始事件 + 执行 reduce 更新状态。

### 2. 删除 streaming 中间层

删掉 `streamingText` / `streamingReasoning` / `streamingTools`。text-delta / reasoning-delta 直接更新 `messages[].parts[].text`，不再走临时缓冲区。

- `text-start` → 创建 TextPart（text: ""，completedAt: undefined）
- `text-delta` → 直接往 TextPart.text 追加
- `text-end` → 设置 completedAt

流式中的 part 靠 `completedAt === undefined` 标识。`toModelMessages()` 已有此过滤逻辑，无需改动。

### 3. 删除 EventRing

events 数组本身就是 replay 缓冲区。断线重连直接 `events.slice(lastEventIndex)` 取遗漏事件。EventRing 整个删除。

### 4. 删除 flattenStoreEvents 全家桶

`flattenStoreEvents` / `pushNewEvents` / `countStoreEvents` / `pushedEventCount` 全删。SSE subscribe 改为检测 events 数组增长。

### 5. 初始状态加载

新客户端连接 SSE 时，不需要额外的 state-init 事件。前端先通过 REST API（GET /sessions/:id）加载完整的结构化数据（messages/steps/todos 等），用 `setState` 初始化 store，再连接 SSE 接收增量事件。

SSE 只负责增量推送，不做全量状态同步。全量数据由 REST API 按需提供。

### 6. lastEventId 机制

`lastEventId` 变成 events 数组的 index。断线重连时 `events.slice(lastId + 1)` 即为遗漏事件。

## 三种消费方式

| 消费者 | 方式 | 数据源 |
|--------|------|--------|
| TUI（同进程） | `useStore(selector)` 直接订阅 | store 的 messages/steps 直接读 |
| Web UI（跨网络） | SSE 推 events 增量 | events.slice(prevLen) |
| REST API | GET /sessions/:id | 结构化数据（SessionFileSchema） |

TUI 不需要订阅 events。text-delta 直接写 messages 后，`useStore(s => s.messages)` 就能拿到实时文字，不再需要 streamingText。

## 重放场景

### SSE 短暂断线重连

客户端掉线几秒，带 `Last-Event-ID` 重连：

```
events.slice(lastId + 1) → 逐条 writeEntry 推送
```

原始 StreamEvent 无信息损失。⚠️ 注意：events 粒度比之前的 flattenStoreEvents 产出更细（每个 text-delta 是一条），需要确保 events 数组容量足够（内存中，建议上限 10000 条）。

### 新标签页打开（全新恢复）

```
GET /sessions/:id → 拿到 messages/steps/todos 结构化数据
    ↓
前端 createWebSessionStore() → setState(loadedData)
    ↓
连接 SSE → 只收增量事件
```

⚠️ 关键：REST API 返回的数据是 SSE 连接时刻的快照。连接 SSE 后，从前端保存的 lastEventId 开始接收增量。如果服务端 events 数组在此期间已被截断（见"events 内存增长"），需要走全量恢复：再请求一次 REST API 重新初始化 store。

### REST API 拉取消息列表

不变。`saveSessionTranscript()` 只持久化 messages/steps/todos/reminders，不存 events 数组。events 是纯内存的。

## ⚠️ 容易犯错的地方

### 1. text-delta 直接写 messages 时的并发安全

`text-delta` 直接往 `messages[].parts[].text` 追加，涉及数组深层修改。Zustand 要求 immutable update，每次 text-delta 都要创建新的 messages 数组和新的 part 对象。如果用 mutable 操作（直接 `part.text += delta`），Zustand subscribe 不会触发，SSE 就推不出去。

**必须**：每次 text-delta 都返回新的 messages 数组（map + spread 创建新 part）。

### 2. events 数组的内存增长

events 数组只增不减，一个长 session 可能积累几万条 text-delta。必须设上限，超过时丢弃最早的（环形缓冲语义）。但丢弃后 lastEventId 机制会失效——客户端请求的 index 已被丢弃。

**建议**：设上限（如 10000），超过时标记 `eventsTruncated = true`。如果断线重连请求的 lastId 已被丢弃，需要通过 SSE 推送 `reset` 事件通知客户端重新走 REST API 全量恢复。

### 3. SSE 连接与 REST API 的时序

前端先通过 REST API 加载完整数据（`setState`），再连接 SSE 接收增量。两个步骤之间有时序差：REST API 返回的是连接时刻的快照，SSE 从 `lastEventId` 开始推增量。

如果 SSE 连接时发现客户端的 `lastEventId` 已超出服务端 events 数组范围（被截断），需要告知客户端重新走 REST API 全量加载。这可以通过 SSE 推送一个特殊的 `reset` 事件实现——前端收到后重新请求 REST API 初始化 store。

### 4. settleIncompleteState 的简化

之前 `settleIncompleteState()` 在 run 异常结束时，把 streamingText 刷入 messages。删掉 streaming 字段后，流式文字已经在 messages 里了，不需要刷。

**但**：run 异常结束时，未完成的 part（completedAt: undefined）需要被标记完成，否则 `toModelMessages()` 会永久跳过它们。settleIncompleteState 要改为：遍历当前 assistant message 的 parts，给所有 `completedAt === undefined` 的 part 设 `completedAt = Date.now()`。

### 5. 前后端共用同一个 reducer

前端 store 通过 `import { reduceStreamEvent } from "../../../store/reduce"` 直接引用后端的 reducer 模块。不是副本，是同一个文件。

**这意味着**：
- 前端收到 SSE 推送的原始 StreamEvent 后，调用同一个 `reduceStreamEvent()` 更新本地 store
- 改 `reduce.ts` 会同时影响前后端，不可能只改一边
- 前端 store（`WebSessionStoreState`）扩展了额外字段（`pendingPermissions`、`pendingQuestions`、`lastEventId`、`connectionState`），但这些由前端自己管理，reducer 不碰它们

**⚠️ 要注意的点**：
- reducer 返回 `Partial<SessionStoreState>`，不包含 `WebSessionStoreState` 的扩展字段。这是正确的——扩展字段不受 StreamEvent 影响
- 删掉 streaming 字段后，reducer 的 `text-delta` 分支直接更新 messages。前端 store 也会收到这个更新，React 组件订阅 `messages` 就能看到实时文字
- 如果未来前端需要自定义 reducer 逻辑（比如过滤某些事件），不要 fork 一份 reducer。可以包装一层：先调 reduceStreamEvent，再叠加前端特有逻辑

### 6. permission-service / ask-user-service 的事件推送

这两个服务目前通过 `ring.push()` 直接往 EventRing 推事件。删掉 EventRing 后，要改为 `store.getState().append(event)`。

⚠️ 注意：append 会同时存入 events 数组 + 执行 reduce。要确保这两个服务推送的事件类型在 reduceStreamEvent 里有处理，否则状态不更新但 events 里会多出未处理的事件。

### 7. lifecycle shutdown 事件

`pushShutdownEvents()` 目前遍历 sessionStreams Map 往每个 EventRing 推关闭事件。删掉 EventRing 后，要改为往每个活跃的 store 推 append。但 shutdown 场景下 SSE 连接也要关闭，需要确保事件先推再关连接。

### 8. persist 时不含 events

`saveSessionTranscript()` 不持久化 events 数组。加载 session 时 events 为空。这是设计意图——events 是瞬时数据，全量状态靠 REST API 获取。

加载后的 lastEventId 从 0 开始（空 events）。SSE 连接时如果 `lastEventId` 为 0 或 undefined，客户端应该先通过 REST API 获取全量状态，然后从 SSE 接收增量。


