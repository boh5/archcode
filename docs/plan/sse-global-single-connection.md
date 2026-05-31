# SSE 全局单连接架构

## 问题

当前 SSE 是 per-session-per-connection 模型。每次切换 session 都会断开旧 EventSource、建立新 EventSource，存在以下缺陷：

1. **切换丢事件** — 离开 session 时 SSE 断开，返回时只能靠 REST 恢复，但 REST 快照到 SSE 重连之间的增量事件丢失
2. **无谓重连** — 即使目标 session 没有活跃 agent，切换时也会建立 SSE 连接
3. **服务端泄漏** — `sessionStreams` Map 在连接断开后不清理；客户端 `sessionRegistry` Map 永不驱逐
4. **不支持多项目并发** — 每个 session 独占一个 SSE 连接，多项目同时活跃时连接数线性增长
5. **Auth 不可用** — 浏览器 `EventSource` 无法发送 `Authorization` header，导致 `SPECRA_SERVER_PASSWORD` 开启时 SSE 连接被 auth 中间件 401 拒绝

## 目标架构

**单一全局 SSE 连接 + Fetch/ReadableStream 传输，事件多路复用，session 切换 = 纯前端状态变更。**

```
┌─────────────────────────────────────────────────────────┐
│  浏览器                                                  │
│                                                         │
│  fetch("/api/events") + ReadableStream                  │
│  GlobalSSEProvider (React Context, root mount)          │
│      │                                                   │
│      ├── eventsource-parser 解析 SSE 帧                 │
│      │                                                   │
│      ├── 解析 {slug, sessionId} → 查找 store            │
│      │   ├── 有 store → append(event)                   │
│      │   └── 无 store → 丢弃（安全，REST 会恢复）       │
│      │                                                   │
│      └── session_state → UI 状态标记                     │
│                                                         │
│  LRU Store Registry (max 20)                            │
│  ├── projA/s1 → Store (前台，正在看)                    │
│  ├── projA/s2 → Store (后台，agent 在跑，SSE 继续写入) │
│  └── projB/s4 → Store (前台)                            │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Hono Server                                            │
│                                                         │
│  GET /api/events  ← 零参数，firehose 模式              │
│      │                                                   │
│      └── 订阅 GlobalEventBus                            │
│          │                                               │
│          ├── projA/s1 的 store.subscribe 桥接           │
│          ├── projA/s2 的 store.subscribe 桥接           │
│          └── projB/s4 的 store.subscribe 桥接           │
│                                                         │
│  GlobalEventBus (EventEmitter singleton)                │
│      └── 所有活跃 agent 的 store.subscribe → emit       │
└─────────────────────────────────────────────────────────┘
```

## 设计决策

### 1. GET /api/events 零参数

连接不带任何查询参数。服务端推送所有项目的所有事件，客户端按 `{slug, sessionId}` 自行路由到对应 store。

**为什么不过滤：**
- Specra 是单用户系统（`SPECRA_SERVER_PASSWORD`），所有项目属同一用户，无隔离需求
- 空闲项目产生零事件，不存在无效带宽消耗
- 客户端丢弃没有 store 的事件，成本仅一次 `JSON.parse` + `Map.get()`
- 避免了"新增项目需要重连 SSE"的问题

### 2. 传输层：Fetch + ReadableStream 替代 EventSource

浏览器原生 `EventSource` 有三个致命限制：
- **无法发送自定义 header** → Auth 中间件 401，生产环境 SSE 完全不可用
- **无法获取 HTTP 错误状态码** → 401/429/500 全部触发同一个 `onerror`，无法区分处理
- **自动重连不可控** → 浏览器自动重试，无法自定义策略（指数退避、同步检查等）

改用 `fetch()` + `response.body` ReadableStream 手动解析 SSE：

**库选型：`eventsource-parser`（~2KB）+ 手写重连/visibility 薄层**

| 方案 | 体积 | Chunk 边界处理 | Reconnect | Visibility | 选择者 |
|---|---|---|---|---|---|
| `@microsoft/fetch-event-source` | ~5KB | ✅ | ✅ 内置 | ✅ 内置 | Skyvern, CoPilot |
| `eventsource-parser` | ~2KB | ✅ TransformStream | ❌ 手写 | ❌ 手写 | **Vercel AI SDK** |
| 手写 | 0 | ❌ 需自行处理 | ❌ 手写 | ❌ 手写 | Opencode |

选择 `eventsource-parser` 的原因：
- SSE 解析最难的部分是 **跨 chunk 的 event boundary**（一个 SSE 帧可能被拆成两个 TCP packet），`eventsource-parser` 作为 TransformStream 正确处理了这个问题
- Opencode 手写的 `split("\n\n")` 方案有 chunk-boundary bug 风险
- `@microsoft/fetch-event-source` 的核心卖点是 Last-Event-ID + visibilitychange 自动处理，但 Specra 不用 Last-Event-ID，这两个功能都需要自定义逻辑
- 2KB 依赖，Vercel AI SDK 背书

**服务端零改动。** SSE wire format 完全相同（`text/event-stream`），`hono/streaming` 的 `streamSSE` 不变。客户端只是换了接收方式。

### 3. 不使用 Last-Event-ID

全局 SSE 连接承载所有 session 的事件流，`Last-Event-ID` 无法表达多 session 的恢复点。恢复策略改为：

- 断线重连后，对所有活跃 store 做轻量 REST 同步检查
- REST 返回 `eventCursor`（服务端 store 的 `nextEventId - 1`）
- 如果 `eventCursor > store.lastEventId`，用 REST 快照重新初始化该 store

### 4. SSE 是增量优化，REST 是正确性保证

```
Server Agent Store = Source of Truth

推送路径 (性能):
  store.append(event) → store.subscribe → GlobalEventBus → SSE → client store.append()
  可能断线、可能丢事件

恢复路径 (正确):
  REST GET /sessions/:id → 完整快照 → initializeFromSnapshot()
  永远正确，用于补齐丢失的增量
```

### 5. Store 生命周期：LRU + 懒创建

- Store 在用户首次导航到某 session 时创建
- 导航离开后 Store 保留在 LRU 注册表中，SSE 继续往里写事件
- 注册表上限 20 个，超出时淘汰最久未访问的
- 被淘汰的 Store：下次访问时 REST bootstrap 恢复

### 6. 不关闭 SSE on visibilitychange

标签页切到后台时保持 SSE 连接，事件继续写入 store。浏览器会自动暂停 React re-render，不影响性能。切回前台时 UI 直接显示最新 store 状态，零延迟。

### 7. 权限/ask_user 流程不变

权限确认和 ask_user 使用 **Deferred Promise + SSE + REST** 模式。Agent 在 tool guard 返回 `"ask"` 时通过 `PermissionService` 创建 pending Promise，SSE 推送事件到前端，用户通过 REST POST 回复，`resolve()` 解除 agent 阻塞。

全局 SSE 改造只改事件传输层，不改事件内容和 REST 回复路径。`PermissionService`、`AskUserService`、`POST /api/permissions/:id`、`POST /api/questions/:id` 完全不变。

## 服务端

### GlobalEventBus

进程级 EventEmitter 单例。所有活跃 agent 的 store 事件桥接到这里。

事件类型：
- `session-event` — `{ slug, sessionId, id, payload }` 携带完整事件信封
- `session-state` — `{ slug, sessionId, state }` 表示 agent 状态变更（active/idle/ended）

### ProjectEventBridge

当 agent 启动时，将 `store.subscribe` 桥接到 `GlobalEventBus`。Agent 结束时清理 unsubscribe + 推送 idle 状态。

这是 reactive subscription，不是轮询。Agent store 每次 `append()` 触发 Zustand subscriber → 立即推到 GlobalEventBus → 立即写入 SSE response。

### 全局 SSE 端点

`GET /api/events`，零参数。订阅 GlobalEventBus，按事件类型写入 SSE stream。心跳 15s。连接断开时清理 listener。

服务端完全无状态——不追踪客户端状态，不维护 per-client cursor。

### SSE 事件格式

所有事件使用统一的 `event: "event"` type，data 内携带路由信息：

```
event: event
data: {"slug":"projA","sessionId":"s1","id":42,"payload":{"type":"text-delta",...}}

event: session_state
data: {"slug":"projA","sessionId":"s1","state":"active"}

event: heartbeat
data: {}

event: reset
data: {"slug":"projA","sessionId":"s1"}
```

不用 tagged event names（如 `session/projA/s1`）是因为 `{slug}/{sessionId}` 组合无限，无法预注册 `addEventListener`。

### 旧端点兼容

旧的 `GET /api/projects/:slug/sessions/:sessionId/events` 端点保留不删。新架构稳定后再标记 deprecated。两个端点可以并行运行，互不影响。

## 客户端

### SSE 客户端（`sse-client.ts`）

使用 `fetch()` + `eventsource-parser` 替代浏览器 `EventSource`：

- 发送 `Authorization` header → 修复生产环境 Auth 401 问题
- 手动管理重连：指数退避（1s → 30s cap），重连后 REST 同步检查
- HTTP 错误码区分：401 → 停止重连，429 → 读取 Retry-After，5xx → 正常退避
- visibilitychange 处理：保持连接，切回前台时可选 REST 同步
- 预计 ~80 行（parser import + fetch loop + reconnect + visibility）

### GlobalSSEProvider

React Context Provider，挂载在路由之外（或 RootLayout 外层），整个应用生命周期内维护单一 SSE 连接。

职责：
- 创建并持有 SSE 客户端实例
- 接收所有 SSE 事件，按 `{slug, sessionId}` 路由到对应 store
- 无对应 store 的事件安全丢弃
- 管理连接状态（connecting / open / reconnecting）
- 重连成功后触发活跃 store 的 REST 同步检查

### Store 注册表改造

- `sessionRegistry` 加 LRU 驱逐（max 20），Map 保持插入顺序
- 访问时移到尾部（delete + re-set），满时淘汰头部最旧条目
- 新增 `findStore(slug, sessionId)` 供 GlobalSSEProvider 查询（不触发 LRU 更新）

### Session 路由改造

移除 `useSessionEvents` hook，改为使用 GlobalSSEProvider + REST bootstrap：

- `SessionRoute` 只负责：创建 store + REST GET 快照 + `initializeFromSnapshot`
- 所有 SSE 逻辑由根级别 GlobalSSEProvider 统一处理
- 不再按 session 创建/销毁 EventSource

### Pending Buffer

Store 创建和 REST 响应之间存在时间差。SSE 可能在 `initializeFromSnapshot` 之前就推了事件。

解决方式：`initializeFromSnapshot` 时设置 `eventOffset`（从 REST 返回的 `eventCursor + 1`），然后从 `events[]` 中丢弃 `id < eventOffset` 的条目。由于 SSE 事件已经 append 到 `events[]`，只需要去重，不需要额外 pending queue。

## 场景数据流

### 页面刷新

```
T0  用户按 F5
T1  React 挂载 → GlobalSSEProvider → fetch("/api/events")
    SSE 连接建立，开始接收所有事件
T2  React Router 匹配 URL → SessionRoute 挂载
    getOrCreateStore(slug, sessionId) → 新 store (eventOffset=0)
    SSE 推送的事件：store 已创建 → 正常 append
T3  REST GET /sessions/:id 返回完整快照 + eventCursor=42
    initializeFromSnapshot() 设置 eventOffset=43
    过滤 events[] 中 id < 43 的条目（可能已收到 43、44、45）
T4+ SSE 继续推送增量事件，正常 append

数据丢失窗口：T1 到 T2 之间（~0ms）。
此时 store 未创建，SSE 事件被丢弃。
REST 快照在 T3 补齐这些数据。
```

### Session 切换

```
用户从 /projects/projA/sessions/s1 → 点击 s2

T0  React Router 更新 URL
T1  SessionRoute(s1) 卸载 + SessionRoute(s2) 挂载
    getOrCreateStore("projA", "s2")

    情况 A: s2 之前访问过
      → sessionRegistry 中有 s2 的 store
      → SSE 一直在往里写事件（GlobalSSEProvider 持续运行）
      → 立即可用，零延迟

    情况 B: s2 从未访问过
      → 创建新 store → REST bootstrap → SSE 增量合并（同页面刷新）

全程 SSE 连接没有任何中断，没有任何网络操作。
```

### 多项目并发

```
GlobalSSEProvider: 单一 fetch("/api/events")

服务端 GlobalEventBus 收到:
  projA/s1 的 event#101
  projB/s4 的 event#55
  projA/s2 的 event#88

全部写入同一个 SSE stream，客户端按 {slug, sessionId} 路由。

典型负载：1-2 个 agent 同时运行，每秒几个事件，每个 ~1KB。
SSE 单连接完全足够。
```

### 标签页后台/前台

```
切到后台:
  → SSE 连接保持（fetch+RS 不受浏览器 EventSource 后台限制）
  → 事件继续写入 store
  → 浏览器暂停 React re-render（自动优化）

切回前台:
  → React 重新渲染 → UI 显示最新 store 状态
  → 零延迟

如果 SSE 在后台断了（浏览器可能限制）:
  → onerror → 指数退避重连
  → 切回前台时做 REST 同步检查补齐
```

### 断网/重连

```
T0  网络断开 → fetch stream error
    → 指数退避重连: 1s → 2s → 4s → ... → 30s cap

T1  网络恢复，重连成功
    → 对所有活跃 store 做 REST 同步检查:
      REST GET /sessions/:id → eventCursor
      if eventCursor > store.lastEventId:
        initializeFromSnapshot(REST 快照) // 完整覆盖

T2+ SSE 继续推送增量
```

### 添加新项目

```
T0  用户点击 "Add Project"
T1  REST POST /api/projects → 注册项目，返回 slug
T2  用户导航到该项目下的 session
T3  getOrCreateStore(newSlug, sessionId) → 创建新 store
T4  REST GET /sessions/:id → 快照
T5  SSE 后续事件带 slug=newSlug → findStore 找到 store → append

全程 SSE 连接无中断。
不需要更新任何查询参数，不需要重连。
```

## 改动清单

| 层 | 文件 | 类型 | 说明 |
|---|---|---|---|
| 服务端 | `sse/global-event-bus.ts` | 新建 | EventEmitter 单例 + 类型定义 |
| 服务端 | `sse/project-event-bridge.ts` | 新建 | store.subscribe → GlobalEventBus 桥接 |
| 服务端 | `sse/global-sse-handler.ts` | 新建 | `GET /api/events` 端点 |
| 服务端 | `runtime.ts` / `SessionExecutionManager` | 修改 | session execution 启动时注册 bridge，结束时清理 |
| 服务端 | `app.ts` | 修改 | 挂载新路由 |
| 服务端 | `routes/events.ts` | 保留 | 旧端点不删，兼容过渡 |
| 客户端 | `lib/sse-client.ts` | 新建 | fetch+eventsource-parser SSE 客户端 (~80行) |
| 客户端 | `context/global-sse.tsx` | 新建 | GlobalSSEProvider |
| 客户端 | `store/session-store.ts` | 修改 | 加 LRU 驱逐、findStore、pending buffer |
| 客户端 | `routes/session.tsx` | 修改 | 移除 useSessionEvents，改用 REST bootstrap |
| 客户端 | `hooks/use-session-events.ts` | 废弃 | 被 GlobalSSEProvider + sse-client 取代 |
| 客户端 | `router.tsx` | 修改 | 根级别挂载 GlobalSSEProvider |
| 依赖 | `eventsource-parser` | 新增 | SSE 解析库 (~2KB)，Vercel AI SDK 背书 |

## 参考

- [Opencode](https://github.com/sst/opencode) — 全局 SSE + GlobalBus + REST bootstrap。使用手写 fetch+RS SSE 客户端
- [Vercel AI SDK](https://github.com/vercel/ai) — 使用 `eventsource-parser` 做 SSE 解析，推荐 Fetch + ReadableStream 替代 EventSource
- [eventsource-parser](https://github.com/rexxars/eventsource-parser) — TransformStream SSE 解析器，正确处理跨 chunk boundary
- 浏览器 SSE 限制：HTTP/1.1 = 6 连接/域名，HTTP/2 = ~100 streams
- SSE backpressure：`res.write()` 返回 false 时等待 `drain` 事件，或用 bounded queue + drop-oldest
