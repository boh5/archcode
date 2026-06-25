# ArchCode Tools 系统设计规划

> **核心决策**: Core Tools + 安全底座先行；Per-agent allowedTools + Hard Guards 权限模型；Orchestration 远期规划；MCP 暂缓。

---

## 背景

ArchCode 已实现统一 Tools 基础框架（`defineTool` + `ToolRegistry` + Hooks 系统），Tier 0 权限基础设施和 Tier 1 七个基石工具（`file_read`、`file_write`、`file_edit`、`grep`、`glob`、`git_status`、`git_diff`）均已实现。本文档基于对 Claude Code、OpenCode、oh-my-openagent、pi-mono 的调研，制定工具系统建设方案。

核心架构优势：Hooks 系统（global + per-tool before/after 管道）比竞品更灵活，Hard Guards 作为独立的 `GuardHook` 阶段实现三档安全判定，不复用 `BeforeHook` 通道。

---

## 设计哲学

1. **分层隔离** — Tier 0 Permission → Tier 1 Core → Tier 2 Experience → Tier 3 Advanced → Tier 4 Ecosystem → Tier 5 Orchestration（远期）
2. **allowedTools + Hard Guards** — 工具可见性由 allowedTools 白名单控制，安全性由 Hard Guards 代码三档判定（allow/deny/ask），不可配置覆盖
3. **安全底座先行** — 破坏性工具在有安全模型前不开放

---

## 工具分层架构

### Tier 0: Permission System（权限基础设施层）

Per-agent 权限模型：每个 agent 拥有独立 `allowedTools` 白名单，Hard Guards 统一执行三档判定。

#### allowedTools + Hard Guards 模型

```
toolCall → ① allowedTools → ② Hard Guards → 执行/拒绝/询问
                                    │
                                    ├─ 安全 → 允许（allow）
                                    ├─ 危险 → 拒绝（deny）
                                    └─ 不确定 → 询问（ask）
```

**设计原则**：
- **allowedTools**：agent 能用什么工具。不在列表 → LLM schema 中不存在，也无法调用。与代码中 `QueryLoopOptions.agentTools` 对齐。
- **Hard Guards**：代码实现的不可配置安全判定，三档决策：
  - `allow`：明确安全，直接放行（如 `git status`）
  - `deny`：明确危险，直接拒绝（如 `rm -rf /`、workdir 外写文件）
  - `ask`：不确定，需要用户确认（如读 `.env`）
- **无 Rules 引擎**：安全策略全部在 Hard Guards 代码中，不可被配置覆盖。
- **无 Mode 切换**：没有 interactive/yolo/plan 模式，只有一个默认行为。

#### GuardDecision 类型定义

```ts
type GuardDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "ask"; reason: string; prompt: string };
```

Hard Guards 作为独立 `GuardHook`，不复用现有 `BeforeHook` 通道：

```ts
type GuardHook = (
  input: unknown,
  ctx: ToolExecutionContext,
) => MaybePromise<GuardDecision>;
```

`BeforeHook` 只负责 input mutation（返回 mutated input 或 void），`GuardHook` 只负责权限判定（返回 `GuardDecision`）。两者在 registry 内按顺序执行，语义不冲突。

#### Ask 结果语义

| 用户操作 | 行为 |
|----------|------|
| 同意 | 本次 tool call 继续执行 |
| 拒绝 | 不执行工具，返回 `isError: true` 的 tool result 给 LLM |
| 超时/中断 | 按拒绝处理 |

确认默认只对当前 tool call 生效。未来可加入 session-scope approval 缓存（本次会话内相同操作不再重复询问）。

#### Guard 判定组合规则

当多个 guard 检查同时命中时，优先级固定：**deny > ask > allow**。边界/安全完整性类问题直接 deny；敏感但可授权的操作 ask。

例如：写入未先读取的 `.env` 文件同时命中 "未先读取 → deny" 和 "敏感文件 → ask"，最终判定为 deny。

#### ToolExecutionContext 扩展

权限系统需要 `ToolExecutionContext` 补充以下字段：

```ts
interface ToolExecutionContext {
  // ...现有字段...
  /** 当前 agent 的 allowed tool set，用于 runtime mirror check */
  allowedTools: ReadonlySet<string>;
  /** 项目 workspace root（canonical realpath），所有文件路径校验的基准 */
  workspaceRoot: string;
  /** Hard Guards ask 判定的 confirmation 回调。缺省时 ask 按 deny 处理 */
  confirmPermission?: ToolConfirmationCallback;
}
```

**Runtime mirror check**：`resolveForAgent(agentTools)` 控制 LLM schema 暴露，`registry.execute` 在执行前必须再次校验 `ctx.allowedTools`。如果 tool call 不在 allowed set 内，直接返回 permission error，不进入 guard 或 execution 流程。

**缺省行为**：如果 `GuardDecision.outcome === "ask"` 但没有 `confirmPermission` callback（如 headless/test 场景），按 deny 处理。

#### Confirmation 回调接口

```ts
export interface ToolConfirmationRequest {
  toolName: string;
  toolCallId: string;
  input: unknown;
  reason: string;
  prompt: string;
}

export type ToolConfirmationCallback = (
  request: ToolConfirmationRequest,
  ctx: ToolExecutionContext,
) => Promise<"approve" | "deny" | "timeout">;
```

Phase 1 中 callback 由 TUI 层注入，实现用户确认 UI。`ask_user` 工具（Tier 2）用于 agent 主动向用户澄清需求，与权限 confirmation 完全独立。

#### Hard Guards 判定示例

| 操作 | 判定 | 原因 |
|------|------|------|
| `git status` | allow | 只读，无副作用 |
| `file_read` 普通文件 | allow | 只读操作 |
| `file_read .env` | ask | 包含敏感信息 |
| `file_read .env.production` | ask | 包含敏感信息 |
| `file_write` workdir 内新建 | allow | 在安全区域内创建新文件 |
| `file_write` workdir 内覆盖已读且未变文件 | allow | read-before-write 通过 |
| `file_write .env` | ask | 覆盖敏感文件 |
| `file_write` workdir 外 | deny | 超出工作区边界 |
| `file_edit` 未先读取文件 | deny | 未满足 read-before-write 前置条件 |
| `grep` / `glob` 扫描 workdir 外路径 | deny | 超出工作区边界 |
| `rm -rf /` | deny | 破坏性命令 |
| `bash` 涉及 `sudo` | deny | 提权操作 |
| symlink 转义路径 | deny | 路径遍历攻击 |

每个工具必须拥有自己的 guard policy，以上仅列代表性案例（含未来 Tier 2 `bash` 的示例）。

#### 配置示例

```ts
export const backendAgent = defineAgent({
  role: "backend",
  allowedTools: ["file_read", "file_write", "file_edit", "grep", "glob", "bash",
                  "git_status", "git_diff", "todo_write"],
})

export const reviewerAgent = defineAgent({
  role: "reviewer",
  allowedTools: ["file_read", "grep", "glob", "git_status", "git_diff"],
})
```

**注意**：配置中只有 `allowedTools`，没有 `rules`。安全策略完全由 Hard Guards 代码控制。`allowedTools` 与 `QueryLoopOptions.agentTools` 对齐。

**术语区分**：本文的 `allowedTools` 是 agent 级工具白名单（哪些工具可用）。代码中 `ToolDescriptor.capabilities: ToolCapabilities { readOnly, destructive, concurrencySafe }` 是工具元数据（描述工具属性），两者不是同一概念。实现时建议将 `ToolCapabilities` 重命名为 `ToolTraits` 或 `ToolMetadata`，避免混淆。

#### 交付策略

一次性交付。allowedTools 控制 LLM schema + runtime 镜像检查；Hard Guards 作为独立的 `GuardHook` 阶段执行（不复用 `BeforeHook` 通道），三档判定逻辑在代码中实现。Host confirmation 回调注入 `ToolExecutionContext`，不依赖 `ask_user` 工具。

---

### Tier 1: Core Tools（基石层）

| 工具 | 设计要点 |
|------|---------|
| **file_read** | 文本读取 + offset/limit + 二进制检测。输出上限 50KB。 |
| **file_write** | 创建/覆盖文件，自动 mkdir，原子写入（先写临时文件再 rename）。自动 mkdir 仅允许在 canonical workspace root 下创建。 |
| **file_edit** | Pi 式 fuzzy exact replace。多 edits 批量从后往前应用。oldString 多匹配时拒绝。read-before-write 冲突检测。 |
| **grep** | ripgrep (`rg --json`)，支持正则、glob 过滤、上下文行。上限 100 条。 |
| **glob** | ripgrep 文件名匹配，按 mtime 排序。上限 100 条。 |
| **git_status** | 仓库状态：modified / staged / untracked。 |
| **git_diff** | staged 或 unstaged diff。 |

`bash` 不在 Phase 1 开放。`file_edit` v1 采用 fuzzy exact replace，未来可增加 hashline 模式和 unified diff artifact 格式。

### Tier 2: Development Experience + Task State

| 工具 | 用途 | 设计要点 |
|------|------|----------|
| **bash** | shell 执行 | timeout + cwd 限制 + dangerous command confirmation + secret redaction |
| **todo_write** | 任务跟踪 | pending / in_progress / completed / cancelled |
| **lsp_diagnostics** | 编译反馈 | **已推迟**：推迟至后续独立的 diagnostics/LSP 计划，不在当前 Tier 2 计划中实现 |
| **ask_user** | 用户交互 | agent 主动向用户澄清需求；与 Hard Guards 权限 confirmation 独立 |

### Tier 3: Advanced / Search

| 工具 | 优先级 |
|------|--------|
| **ast_search** / **ast_replace** | P2（重构刚需） |

### Tier 4: Ecosystem（暂缓）

| 工具 | 说明 |
|------|------|
| **mcp_invoke** | 权限模型成熟后再开放 |
| **interactive_bash** | P3 |
| **session_manage** | P3 |

### Tier 5: Orchestration（远期规划）

- `call_agent` — 同步角色调用
- `delegate_task` — 异步任务委派 + 状态机

`pr_review` / `run_tests` 作为 `call_agent` 的 prompt 模板，不作为独立工具。

---

## 关键架构决策

### 1. 文件写入并发控制

Pi 式 file-mutation-queue — 按文件路径（`realpath`）序列化写入。不同文件并行，同一文件串行。

### 2. 读后写一致性

Hooks 层实现。`file_read` 成功后的 after hook 记录 session 级 read snapshot（realpath + mtime/hash）；`file_write`/`file_edit` 的 GuardHook 对已存在文件校验 read snapshot 是否存在且未变化。

### 3. 权限系统

详见 Tier 0。allowedTools + Hard Guards 模型：allowedTools 白名单控制工具可见性，Hard Guards 三档判定（allow/deny/ask）不可配置覆盖。

**重要**：`resolveForAgent(agentTools)` 只控制 LLM schema 暴露，runtime execution 必须再次校验 allowed tool set。`registry.execute` 不能接受 schema 外的 tool call。

### 4. 错误恢复注入

after hook 检测常见错误模式并追加恢复指导。非阻塞追加，不替换原始输出。

### 5. Doom 循环检测

QueryLoop 层实现。同一工具 + 相同输入重复 3 次 → 暂停并报告。

### 6. 工具参数兼容层

`prepareInput?: (raw: unknown) => unknown`，在 safeParse 前做轻微修正。

#### 工具执行完整流程

```
raw input
  → descriptor.prepareInput?(raw)     // 轻微修正
  → inputSchema.safeParse             // 参数校验
  → ctx.allowedTools runtime check    // 工具白名单校验
  → GuardHook (per-tool)              // 权限三档判定
  → global before hooks               // input mutation
  → tool execute                      // 执行
  → global after hooks                // 副作用（secret redaction 等）
```

### 7. Secret Redaction

global after hook 覆盖常见 secret pattern（`.env`、Bearer token、private key 等）。

### 8. Metadata 管道

`ToolExecutionResult.meta` 用于 hooks 间通信，不写入 store/不发给 LLM。

### 9. 大输出持久化

超出 50KB / 2000 行时截取前 5 行预览，完整输出写入 `~/.archcode/tool-output/`。

---

## 演进路线图

### Phase 1: Core + 安全底座（当前重点）

- `file_read`, `file_write`, `file_edit`, `grep`, `glob`, `git_status`, `git_diff`
- file-mutation-queue, read-before-write guard
- permission system: allowedTools + Hard Guards（allow/deny/ask 三档判定）+ TUI confirmation 回调
- output truncator + prepareInput 兼容层

**不做**: `bash`、MCP、interactive_bash

### Phase 2: 体验 + 任务管理（当前实施中）

- `bash`（fresh process per call，无持久 shell/session cwd/env/alias，无后台进程）
- `todo_write`（store-backed session-only，全量替换，不写 workspace 文件）
- `ask_user`（与权限 confirmation 独立，一次一个 pending question）
- Doom 循环检测（连续 3 次相同 normalized tool call → 阻断执行）
- error recovery（结构化可操作错误反馈，无自动重试）
- secret redaction（redaction-first 输出管道：redaction → truncation → audit → logger）
- audit trail v1（最小化 injectable-sink 结构化事件，无数据库/query UI/raw output 存储）
- PathValidator 集中化（workspace 路径校验统一模块）
- **不做**: `lsp_diagnostics`（推迟至后续独立计划）、permission modes、MCP、interactive_bash、persistent shell、background process
- **实施期间不 commit**，最终验证通过后经用户审查再统一 commit

### Phase 3: 高级搜索

- `ast_search` / `ast_replace`

### Phase 4: 生态扩展

- `mcp_invoke`, `interactive_bash`, `session_manage`

### Phase 5: Orchestration（远期）

- `call_agent`, `delegate_task`

---

## 与竞品对比

| 维度 | Claude Code | OpenCode | oh-my-openagent | pi-mono | **ArchCode** |
|------|-------------|----------|-----------------|---------|------------|
| 工具数量 | 45+ | 17 | 39+ | 7 | ~15 |
| 编辑策略 | search/replace | dual-mode | hashline | fuzzy exact | fuzzy exact (v1) |
| 子 Agent | AgentTool (3种) | task | task + team | 无 | 远期 |
| 权限系统 | 7层 | 3层 | 3层+AI分类 | 无内置 | allowedTools + Hard Guards |
| 安全底座 | 沙盒+AI分类 | 3层权限 | 3层+哈希 | 无 | read-before-write + workspace + hard guards |
| LSP | LSPTool | 基础 | 6个 | 无 | diagnostics (v2) |
| MCP | ✅ | ✅ | ✅ | ❌ | v4 |

---

## 参考项目

- **Claude Code**: https://github.com/ChinaSiro/claude-code-sourcemap
- **OpenCode**: https://github.com/anomalyco/opencode
- **oh-my-openagent**: https://github.com/code-yeongyu/oh-my-openagent
- **oh-my-opencode-slim**: https://github.com/alvinunreal/oh-my-opencode-slim
- **pi-mono**: https://github.com/badlogic/pi-mono

---

## 变更记录

| 日期 | 变更 |
|------|------|
| 2026-05-07 | 初稿 → Oracle 审核 → 用户确认 → per-agent 权限重构 → 简化为 allowedTools + Hard Guards |
| 2026-05-07 | 移除 Rules 引擎 + Mode 切换，简化为 allowedTools + Hard Guards 三档模型（allow/deny/ask）|
| 2026-05-07 | Oracle review 后补充：GuardDecision 类型定义、ask 结果语义、capabilities→allowedTools 重命名、Hard Guards 示例扩充、runtime mirror check 说明、escalation→confirmation 术语修正 |
| 2026-05-07 | 第二轮 Oracle review：GuardHook 独立类型、ToolExecutionContext 扩展（allowedTools/workspaceRoot/confirmPermission）、confirmation 回调接口、deny>ask>allow 组合规则、ask_user 与 permission 独立、ToolCapabilities 重命名建议、read-before-write after/before 修正、prepareInput 执行流程、file_write mkdir 边界 |