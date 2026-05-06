# Session Transcript Store 设计方案

## 目标

将 agent loop 的输出从 `process.stdout.write` / `console.log` 改为 Zustand store，实现：

1. 按 session id 隔离的事件流
2. agent loop 中通过 store 方法更新状态
3. 未来 Ink 组件通过 store 变化自动重渲染
4. transcript 持久化到磁盘

## 技术选型

**Zustand v5** — 数据驱动，Ink/React 原生订阅，已在项目中验证与 Ink v7 + React 19 兼容。

## 数据模型

### TranscriptEvent

每个事件携带基础元数据：`id`（React key / 唯一标识）、`timestamp`（审计/回放）、`step`（按 AI SDK turn 分组）。

```ts
type TranscriptEvent =
  | { type: "user-message"; id: string; timestamp: number; step: number; content: string }
  | { type: "text-delta"; id: string; timestamp: number; step: number; text: string }
  | { type: "tool-call"; id: string; timestamp: number; step: number; toolName: string; toolCallId: string; input: unknown }
  | { type: "tool-result"; id: string; timestamp: number; step: number; toolName: string; toolCallId: string; output: string }
  | { type: "tool-error"; id: string; timestamp: number; step: number; toolName: string; toolCallId?: string; error: string }
  | { type: "loop-error"; id: string; timestamp: number; step: number; error: string }
```

- `user-message` — 用户输入（loop 开始时记录）
- `text-delta` — AI 流式文本片段
- `tool-call` — 工具调用（AI SDK `fullStream` 原生事件）
- `tool-result` — 工具执行结果（loop 拼装）
- `tool-error` — 工具执行错误（可配对到 toolCallId）
- `loop-error` — 模型流错误、非工具异常、maxSteps 终止等通用错误

### SessionTranscriptState

```ts
interface SessionTranscriptState {
  sessionId: string
  events: TranscriptEvent[]
  createdAt: number

  // Actions
  append: (event: TranscriptEvent) => void
}
```

Store 只管运行期状态，IO 操作用独立函数。

### Helper 函数（不在 store 内）

```ts
// Concatenate all text-delta events into full assistant text
function getAssistantText(events: TranscriptEvent[]): string

// Persist transcript to disk (atomic write: .tmp → rename)
function saveSessionTranscript(
  state: Pick<SessionTranscriptState, "sessionId" | "createdAt" | "events">,
  dir: string,
): Promise<void>

// Load transcript from disk
function loadSessionTranscript(
  sessionId: string,
  dir: string,
): Promise<SessionTranscriptState>
```

## API

```ts
function createSessionStore(sessionId: string): StoreApi<SessionTranscriptState>
function getSessionStore(sessionId: string): StoreApi<SessionTranscriptState> | undefined
```

- 按 sessionId 隔离，每个 id 一个独立 Zustand vanilla store 实例
- sessionId 由调用方通过 `crypto.randomUUID()` 生成

## Loop 改造

### QueryLoopOptions 变更

```ts
interface QueryLoopOptions {
  model: LanguageModelV3
  tools: Record<string, Tool>
  toolExecutors: ToolExecutorMap
  systemPrompt?: string
  maxSteps?: number
  store: StoreApi<SessionTranscriptState>  // 新增，必须传
}
```

### loop.ts 改造点

所有 `process.stdout.write` / `console.log` 替换为 `store.getState().append(...)`：

```ts
// Append user message at loop start
store.getState().append({
  type: "user-message", id: randomUUID(), timestamp: Date.now(), step: 0,
  content: userMessage,
})

// Text delta
store.getState().append({
  type: "text-delta", id: randomUUID(), timestamp: Date.now(), step: steps,
  text: chunk.text,
})

// Tool call
store.getState().append({
  type: "tool-call", id: randomUUID(), timestamp: Date.now(), step: steps,
  toolName: chunk.toolName, toolCallId: chunk.toolCallId, input: chunk.args,
})

// Tool result
store.getState().append({
  type: "tool-result", id: randomUUID(), timestamp: Date.now(), step: steps,
  toolName: tc.toolName, toolCallId: tc.toolCallId, output,
})

// Tool error (missing executor)
store.getState().append({
  type: "tool-error", id: randomUUID(), timestamp: Date.now(), step: steps,
  toolName: tc.toolName, toolCallId: tc.toolCallId,
  error: `No executor for tool: ${tc.toolName}`,
})

// Loop error (stream exception, etc.)
store.getState().append({
  type: "loop-error", id: randomUUID(), timestamp: Date.now(), step: steps,
  error: String(err),
})
```

## 持久化

### 格式

`~/.specra/sessions/{sessionId}.json`

```json
{
  "sessionId": "550e8400-e29b-41d4-a716-446655440000",
  "createdAt": 1746528000000,
  "events": [
    { "type": "user-message", "id": "...", "timestamp": 1746528000100, "step": 0, "content": "help me write a function" },
    { "type": "text-delta", "id": "...", "timestamp": 1746528000200, "step": 0, "text": "Sure," },
    { "type": "text-delta", "id": "...", "timestamp": 1746528000300, "step": 0, "text": " I can help." },
    { "type": "tool-call", "id": "...", "timestamp": 1746528000400, "step": 0, "toolName": "readFile", "toolCallId": "tc1", "input": { "path": "src/index.ts" } },
    { "type": "tool-result", "id": "...", "timestamp": 1746528000500, "step": 0, "toolName": "readFile", "toolCallId": "tc1", "output": "// file contents..." }
  ]
}
```

### Atomic Write

写入时先写 `{sessionId}.json.tmp`，成功后 `rename` 到 `{sessionId}.json`，防止中断导致文件损坏。

### 时机

loop 结束后一次性写入，不做实时持久化。

### 校验

Load 时用 Zod strict schema 校验 JSON 结构。

## 文件结构

```
src/
  store/                  # 独立 store 模块
    types.ts              # TranscriptEvent, SessionTranscriptState
    store.ts              # createSessionStore, getSessionStore
    helpers.ts            # getAssistantText, saveSessionTranscript, loadSessionTranscript
    store.test.ts         # store + helper tests
    index.ts              # barrel exports
  agents/query/           # agent loop，只 import store 类型
    types.ts              # QueryLoopOptions（引用 store 类型）
    loop.ts               # Refactored to use store
    loop.test.ts          # Updated tests
```

## 未来 Ink 渲染（不做，但设计预留）

```tsx
// 未来这样用
function TranscriptView({ sessionId }: { sessionId: string }) {
  const store = getSessionStore(sessionId)
  const events = useStore(store, (s) => s.events)
  return <Box flexDirection="column">{events.map((e) => <Text key={e.id}>{renderEvent(e)}</Text>)}</Box>
}
```

渲染场景覆盖：

| 场景 | 支撑情况 |
|---|---|
| 流式文本渲染 | ✅ text-delta 逐条 append 触发重渲染 |
| 工具调用渲染 | ✅ toolCallId 配对 call 和 result |
| 用户输入渲染 | ✅ user-message 事件 |
| 重新打开历史 session | ✅ load 恢复 events |
| 错误渲染 | ✅ tool-error + loop-error |
| 按 step 分组 | ✅ 每事件带 step 字段 |

## 不做的事

- ❌ 实时持久化（每 event 写文件）
- ❌ Ink UI 组件
- ❌ 多 session 并发管理
- ❌ 事件回放/索引
- ❌ step-start / step-end 独立事件（step 字段已满足分组需求）
- ❌ text-delta batching（等真正做 Ink 渲染时根据性能再优化）
