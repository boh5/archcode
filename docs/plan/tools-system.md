# Tools 系统设计

## 目标

为 Specra 构建统一的工具系统：定义、注册、执行、按 agent 派生工具集。替代当前 `agents/query/` 下 `tools + toolExecutors` 分离接口。

## 核心决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 工具定义 | `defineTool()` 强泛型 helper | schema 的 `z.infer` 自动绑定到 execute + hooks input 参数，避免类型脱节 <!-- 参考: Claude Code `buildTool()` 类型安全构建器 (claude-code-sourcemap/restored-src/src/tools.ts) --> |
| Schema | Zod | 项目已有，AI SDK 原生支持 |
| 执行合约 | executor 返回 `string`，失败 `throw` | registry catch 转 `isError=true`，语义清晰；不让 executor 返回错误字符串 <!-- 参考: OpenCode `Tool.define()` execute 返回 Effect<string> (opencode/packages/opencode/src/tools/tool.ts)；oh-my-openagent tool() execute 返回 Promise<string> --> |
| Runtime 校验 | registry `safeParse` input | 不依赖 AI SDK 校验；before hook 修改 input 后 re-parse |
| Hooks | global + per-tool 两层，before/after 管道 | 横切关注点解耦；per-tool 接口保留，v1 无消费者但不删 <!-- 参考: OpenCode 三阶段插件钩子 tool.definition / tool.execute.before / tool.execute.after (opencode/packages/opencode/src/tools/registry.ts)；oh-my-openagent `tool.execute.before/after` 可变钩子 (oh-my-openagent/src/hooks/) --> |
| Hook 错误链 | per-tool after throw → global after 仍执行 | 保证截断/日志覆盖最终输出，不短路 <!-- 参考: OpenCode tool.execute.after 失败不阻断后续处理 --> |
| Agent 工具集 | `tools: string[]`（必填，undefined=`[]`） | agent 作者知道需要什么；不默认全量开放（未来有 bash 等危险工具） |
| Agent 视图 | `resolveForAgent()` → `ResolvedToolSet` | 包装对象带 `toAITools()` / `has()` / `get()` |
| `toAITools()` | 只导出 description + inputSchema，不含 execute | QueryLoop 手动执行 tool calls，避免双执行 |
| 大输出 | 截断预览 + 持久化磁盘，返回预览+路径 | 和 Claude Code/OpenCode 一致；`> 阈值存 ~/.specra/tool-output/` <!-- 参考: Claude Code `toolResultStorage` + `contentReplacementState` 按会话管理输出预算 (claude-code-sourcemap/restored-src/src/utils/toolResultStorage.ts)；OpenCode 截断 2000行/50KB + 持久化到 ~/.opencode/data/tool-output/ (opencode/packages/opencode/src/tools/truncate.ts) --> |
| 能力元数据 | `readOnly` / `destructive` / `concurrencySafe`（必填，无默认值） | 安全相关字段不给默认值，防止漏标；v1 自描述 + truncate/logger 可消费，不做权限过滤 <!-- 参考: Claude Code `isConcurrencySafe()` / `isReadOnly()` / `isDestructive()` 三元组 (claude-code-sourcemap/restored-src/src/Tool.ts)；Claude Code `partitionToolCalls()` 按并发安全分批执行 (claude-code-sourcemap/restored-src/src/query/tools.ts) --> |
| 旧代码 | 不兼容，直接删除 | 无历史负担 |
| AbortSignal | v1 传入 | bash/file/grep 需要取消能力 <!-- 参考: pi-mono 每个工具 execute(signal?) 统一取消模式 (pi-mono/packages/agent/src/types.ts)；OpenCode tool execute(args, ctx) ctx 含 abort signal --> |

## 核心类型

### defineTool()

<!-- 参考: Claude Code `buildTool()` — 类型安全构建器 + TOOL_DEFAULTS 填充安全默认值 (claude-code-sourcemap/restored-src/src/tools.ts)；oh-my-openagent `tool()` from @opencode-ai/plugin — description + args(Zod) + execute → ToolDefinition -->

```typescript
defineTool({
  name: "file_read",
  description: "Read file contents",
  inputSchema: z.object({ path: z.string() }),
  capabilities: { readOnly: true, destructive: false, concurrencySafe: true },
  hooks?: { before?, after? },   // per-tool hooks，input 类型绑定 schema
  async execute(input, ctx) {
    return content;  // 失败 throw
  },
})
```

内部生成 AI SDK `tool()` 用于 LLM 调用描述。

### 执行流程

<!-- 参考: Claude Code `runToolUse()` — validateInput → PreToolUse hooks → checkPermissions → tool.call() → PostToolUse hooks (claude-code-sourcemap/restored-src/src/query/tools.ts)；OpenCode processor.ts — tool-input-start → tool-call(auto-execute) → tool-result 状态机 (opencode/packages/opencode/src/session/processor.ts) -->

```
registry.execute(toolCall, ctx):
  1. 查找 descriptor → 找不到返回 error
  2. safeParse(input) → 失败返回 error
  3. globalHooks.before → 可修改 input 或拒绝
  4. safeParse(modified input) → before hook 修改后重新校验
  5. descriptor.hooks.before → 可修改 input 或拒绝
  6. descriptor.executor(input) → throw 转为 error result
  7. descriptor.hooks.after → 抛错转 error result
  8. globalHooks.after → 抛错转 error result，但始终执行（不短路）
  9. 返回 result
```

### ToolExecutionContext

```
{ store, toolName, toolCallId, input, step, abort: AbortSignal, agentName?: string }
```

### ToolExecutionResult

```
{ output: string, isError: boolean, meta?: Record<string, unknown> }  // meta 不写入 store
```

### ToolCapabilities

```
{ readOnly: boolean, destructive: boolean, concurrencySafe: boolean }  // 必填，无默认值
```

## ToolRegistry

<!-- 参考: Claude Code `getAllBaseTools()` → `assembleToolPool()` 合并内置 + MCP 工具 (claude-code-sourcemap/restored-src/src/tools.ts)；OpenCode `registry.tools(model)` 三层工具源: built-in + custom + plugin (opencode/packages/opencode/src/tools/registry.ts)；oh-my-openagent `createToolRegistry()` → normalize → filter → trim 流水线 (oh-my-openagent/src/plugin/tool-registry.ts) -->

```
register(descriptor) / registerAll(descriptors)    // 重复名 → throw
get(name) → ToolDescriptor | undefined
getAll() → ToolDescriptor[]
resolveForAgent(toolNames: string[]) → ResolvedToolSet  // unknown → warning
execute(toolCall, ctx) → ToolExecutionResult
globalHooks: { before?: [], after?: [] }
```

### ResolvedToolSet

<!-- 参考: Claude Code `filterToolsForAgent()` — 按角色过滤工具集 ASYNC_AGENT_ALLOWED_TOOLS / COORDINATOR_MODE_ALLOWED_TOOLS (claude-code-sourcemap/restored-src/src/constants/tools.ts)；oh-my-openagent `AGENT_RESTRICTIONS` map 限制每个 agent 可用工具 (oh-my-openagent/src/shared/agent-tool-restrictions.ts) -->

```
{ descriptors: readonly ToolDescriptor[], toAITools(), has(name), get(name) }
```

## QueryLoop 集成

`QueryLoopOptions` 删除 `tools` + `toolExecutors`，新增 `toolRegistry: ToolRegistry` + `agentTools: string[]`。

Loop 内部：`resolveForAgent()` → `streamText({ tools: resolved.toAITools() })` → `registry.execute(toolCall, ctx)`。

## 内置 Hooks（v1）

| Hook | 类型 | 作用 |
|---|---|---|
| outputTruncator | global after | > 阈值截断 + 持久化 `~/.specra/tool-output/`，返回预览+路径 |
| executionLogger | global after | 记录 name/duration/output size |
| permissionGuard | global before | deny 规则（占位） <!-- 参考: Claude Code 多层权限: Deny rules → Allow rules → Ask rules → Mode decision (claude-code-sourcemap/restored-src/src/permissions/)；OpenCode `evaluate(permission, pattern, ...rulesets)` last-match-wins (opencode/packages/opencode/src/session/permission/) --> |

## 文件结构

```
src/tools/
  types.ts          — 类型定义
  define-tool.ts    — defineTool() helper
  registry.ts       — ToolRegistry, ResolvedToolSet
  hooks/
    truncate.ts
    logger.ts
    permission.ts   — 占位
  builtins/            — 未来: file-read.ts, bash.ts, grep.ts, ...
  index.ts          — barrel export
```

## 受影响文件

**删除**：`src/agents/query/tools.ts`（含旧 echo 占位）、`ToolExecutor` / `ToolExecutorMap` from `types.ts`

**修改**：
- `src/agents/query/loop.ts` — QueryLoopOptions
- `src/agents/query/index.ts` — barrel export
- `src/agents/index.ts` — barrel export
- `src/agents/test-agent.ts` — 构造 ToolRegistry
- `src/agents/test-agent.test.ts` — 跟随 loop 改动
- `src/tui/App.test.ts` — 创建空 ToolRegistry

## TDD 顺序

1. `types.ts` + test
2. `define-tool.ts` + test
3. `registry.ts` + test — 注册/查询/resolve（unknown warning、重复 throw）
4. `registry.execute` test — safeParse、throw→error、before 修改后 re-parse、after hook 链（per-tool throw 后 global 仍执行）、AbortSignal 传递
5. `hooks/truncate.ts` + `hooks/logger.ts` + test
6. 改 QueryLoopOptions + loop
7. 删除旧代码（tools.ts 含 echo 占位），更新 test-agent.ts + App.test.ts + barrel exports
8. `bun run typecheck && bun test`

## 范围

**做**：defineTool()、ToolRegistry + ResolvedToolSet、truncate + logger hooks、QueryLoop 集成、AbortSignal、TDD 全覆盖

**不做**：更多内置工具、权限系统实现、MCP 集成、并发分区、store StreamEvent meta 扩展