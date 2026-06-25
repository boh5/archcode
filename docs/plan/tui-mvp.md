# TUI MVP 计划

## 目标

把 zustand store + agent loop 接上 Ink 终端 UI。用户能多次输入消息、看到流式 LLM 回复、看到 tool 调用。跑通端到端流程。

## 数据流

```
.archcode.json → loadConfig → createRegistry
                                ↓
用户输入 → main.ts → runQueryLoop() → store.append() → useStore → Ink 渲染
```

**注意**：每次提交独立跑一次 `runQueryLoop()`，无多轮上下文记忆。Transcript 按时间追加，但每次 query 从零开始。

## 文件变更

| # | 操作 | 文件 |
|---|------|------|
| 1 | 改 | `tsconfig.json` — include 加 `src/**/*.tsx` |
| 2 | 新建 | `src/tui/index.ts` — barrel |
| 3 | 新建 | `src/tui/App.tsx` — 根组件 |
| 4 | 新建 | `src/tui/TranscriptView.tsx` — 渲染事件流 |
| 5 | 新建 | `src/tui/UserInput.tsx` — 基本输入 |
| 6 | 新建 | 测试文件 ×3 |
| 7 | 改 | `package.json` — bin/scripts 指向 `src/main.ts` |
| 8 | 新建 | `src/main.ts` — 启动入口，替代旧 `src/index.ts` |
| 9 | 删 | `src/index.ts` — 旧占位符 |

> entry point 最后改，避免中间打断 `bun run dev`

## 组件职责

### `src/main.ts` — 启动入口
1. 加载配置（硬编码 `.archcode.json`），无配置时明确报错
2. 创建 registry，取第一个 model（无 model 时报错）
3. 创建 store
4. `render(<App store={store} model={model.model} tools={} toolExecutors={} />)`

### `App.tsx` — 根组件
- Props: `store`, `model`, `tools`, `toolExecutors`, `systemPrompt?`
  - 不传整个 registry，只传 runQueryLoop 需要的具体依赖
- `useStore(store, s => s.events)` 读取事件
- `useState(false)` 管理运行状态
- 用户提交时：`try { setIsRunning(true); await runQueryLoop(...) } finally { setIsRunning(false) }`
- 渲染：`<TranscriptView>` + 空闲时显示 `<UserInput>` + 运行时显示指示器

### `TranscriptView.tsx` — 事件渲染
- 按 `user-message` 事件边界分块（避免多次提交的回复混在一起）
- 纯格式化函数抽离为独立函数，方便单测
- `user-message` → `> content`
- `text-delta` → 按 step 分组拼接
- `tool-call` → `⚙ toolName`
- `tool-result` → `✓ output` / `✗ error`
- `loop-error` → 红色错误

### `UserInput.tsx` — 输入组件
- `useInput` 捕获按键
- Enter 提交，Backspace 删除
- 粘贴内容保留换行（MVP 不做光标移动、历史、显式换行快捷键）
- 运行中隐藏

## 测试策略（无新依赖）

**不依赖 `ink-testing-library` / `lastFrame()`**，改为：

1. **TranscriptView** — 测试纯格式化函数（输入 events 数组 → 输出格式化结构），不测 Ink 渲染
2. **UserInput** — 测试输入 reducer 逻辑（按键 → 状态变化），不测 UI frame
3. **App** — 注入 fake `runQueryLoop`，测 orchestration 逻辑（isRunning 状态转换、提交后恢复）
4. Ink 渲染只做轻量 smoke test（不崩溃即可）

## 执行顺序

1. `tsconfig.json` — 加 `.tsx`
2. `TranscriptView.tsx` 格式化函数 + test
3. `UserInput.tsx` reducer + test
4. `App.tsx` orchestration + test
5. `src/tui/index.ts` — barrel
6. `src/main.ts` — 入口
7. 改 `package.json` entry，删 `src/index.ts`
8. `typecheck && test` 验收

## 范围

**做**：多次独立提问、流式显示、基本输入（Enter 提交）、硬编码配置、取第一个 model、空 tools

**不做**：多轮上下文记忆、会话恢复、CLI 参数、markdown 渲染、工具审批、光标移动、输入历史、AbortSignal 取消

## 注意事项

- `useStore` selector 必须简单（`s => s.events`），不要返回新对象/数组
- `runQueryLoop` 出错时 `finally` 确保输入框恢复
- LLM stream 在 Ink 退出后不会自动取消（MVP 不处理，后续加 AbortSignal）
- echo tool 作为唯一 tool 先写死

## 依赖

不需要新包。全部用现有的 ink / zustand / react / AI SDK。
