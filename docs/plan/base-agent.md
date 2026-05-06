# Test Agent 重构计划

## 目标

引入 Agent 抽象层，封装 provider/model/store/loop 等内部依赖。TUI 只和 Agent 交互，不再直接接触底层 plumbing。当前命名为 TestAgent，用于打通流程，后续会替换。

## 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| Agent 命名 | `TestAgent` | 临时名称，打通流程后替换 |
| Agent 接口 | 半透明 — 暴露 `store` | TUI 已有 store 渲染逻辑，零改造成本 |
| Store 写权限 | 暴露完整 StoreApi | 短期接受，靠约定约束 TUI 只读 |
| 依赖注入 | Agent 内部自管 | 构造时接收 `SpecraConfig`，内部创建 registry + model + store |
| Model 选择 | 默认第一个 | 无 model 时明确报错（从 main.ts 搬入） |
| System prompt | 硬编码 | 简单直接 |
| 工具系统 | 暂不设计 | 留空 |
| 并发保护 | Agent 内部 running flag | 并发 `run()` 直接拒绝 |
| 文件组织 | 扁平 .ts 文件 | 每个 agent 一个文件 |

## Oracle Review 要点

- ✅ 暴露 store 是务实选择，保留 Ink + Zustand 实时渲染路径
- ✅ Agent 应编排 `runQueryLoop()`，不复制 loop 的事件逻辑
- ⚠️ `runQueryLoop()` 已经 append user-message，TestAgent.run() 不要重复追加
- ⚠️ Agent 应接管错误处理（loop-error），不应泄漏到 App
- ⚠️ 需要并发保护，Agent 拒绝并发的 run() 调用
- ⚠️ 无 model 校验从 main.ts 搬入 Agent 构造函数
- 💡 当前 Agent 是单轮对话语义，未来需 conversation state
- 💡 未来 run() 可能需要 AbortSignal 参数

## 改造前 vs 后

```typescript
// 改造前 — main.ts 5 行 plumbing，TUI 接收 4 个 prop
const config = loadConfig(configPath);
const registry = createRegistry(config.provider);
const modelInfo = registry.getModel(registry.getModelIds()[0]);
const store = createSessionStore(randomUUID());
render(<App store={store} model={modelInfo.model} tools={{}} toolExecutors={{}} />);

// 改造后 — main.ts 2 行，TUI 只接收 1 个 prop
const agent = new TestAgent(loadConfig(configPath));
render(<App agent={agent} />);
```

## 接口设计

```typescript
interface Agent {
  readonly store: StoreApi<SessionTranscriptState>;  // TUI 读这个渲染（约定只读）
  run(userMessage: string): Promise<AgentResult>;    // TUI 调这个触发
}

interface AgentResult {
  readonly text: string;
  readonly steps: number;
}
```

## TestAgent 内部结构

```typescript
class TestAgent implements Agent {
  readonly store: StoreApi<SessionTranscriptState>;
  private registry: Registry;
  private modelInfo: ModelInfo;
  private running = false;

  constructor(config: SpecraConfig) {
    this.registry = createRegistry(config.provider);
    const modelIds = this.registry.getModelIds();
    if (modelIds.length === 0) throw new Error('No models configured');
    this.modelInfo = this.registry.getModel(modelIds[0]);
    this.store = createSessionStore(randomUUID());
  }

  async run(userMessage: string): Promise<AgentResult> {
    if (this.running) throw new Error('Agent is already running');
    this.running = true;
    try {
      // 注意：不手动 append user-message，runQueryLoop 内部已处理
      const result = await runQueryLoop({
        model: this.modelInfo.model,
        tools: {},
        toolExecutors: {},
        systemPrompt: 'You are a helpful coding assistant.',
        store: this.store,
      }, userMessage);
      return { text: result.text, steps: result.steps };
    } catch (error) {
      // Agent 接管错误处理，写入 store
      this.store.getState().append({
        type: 'loop-error',
        content: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
    }
  }
}
```

## 文件变更

| # | 操作 | 文件 |
|---|------|------|
| 1 | 新建 | `src/agents/test-agent.ts` — Agent 接口 + TestAgent 类 + AgentResult |
| 2 | 新建 | `src/agents/test-agent.test.ts` — 构造、run、并发保护、store 事件 |
| 3 | 改 | `src/agents/index.ts` — 加 test-agent barrel export |
| 4 | 改 | `src/main.ts` — 5 行 plumbing → new TestAgent + render |
| 5 | 改 | `src/tui/App.tsx` — props 从 `{ store, model, tools, toolExecutors }` → `{ agent }` |

**不动**：`agents/query/*`、`store/*`、`config/*`、`provider/*`、`TranscriptView`、`UserInput`

## TDD 顺序

1. 🔴 `test-agent.test.ts` — 构造、run、并发保护、无 model 报错
2. 🟢 `test-agent.ts` — 实现
3. 🔴 App props 改造测试
4. 🟢 App 改造实现
5. 🟢 main.ts 改造
6. ✅ `bun run typecheck && bun test`

## 范围

**做**：Agent 接口 + TestAgent 实现、并发保护、错误处理、main.ts/App.tsx 解耦、TDD 全覆盖

**不做**：多 agent 协作、工具系统、model 动态选择、agent 配置文件、AbortSignal 取消、只读 store facade
