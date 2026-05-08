# Tier 1: Core Tools 开发计划

> **定位**: 上层架构设计文档，聚焦系统结构和关键决策。代码细节留给实施阶段。
> **前提**: Tier 0 Permission System 已实施（types/registry pipeline/guard/confirmation 就位）。
> **范围**: 7 个核心工具 + 文件变异队列 + ripgrep 集成 + 并发调度 + 先读后写守卫。

---

## 系统架构总览

```
src/tools/
  types.ts              — 已有：类型定义（Tier 0 扩展后）
  define-tool.ts         — 已有：defineTool() factory
  registry.ts            — 已有：ToolRegistry + pipeline
  hooks/
    truncate.ts          — 已有：大输出截断
    logger.ts             — 已有：执行日志
    permission.ts         — 已有：guard helpers + combineGuardDecisions
    read-snapshot.ts      — 新增：先读后写 snapshot 读写 helpers（操作 store.readSnapshots）
    edit-error-recovery.ts — 新增：edit 失败认知助推
  builtins/              — 新增：内置工具模块
    file-read.ts
    file-write.ts
    file-edit.ts
    grep.ts
    glob.ts
    git-status.ts
    git-diff.ts
    index.ts             — barrel: createBuiltinToolDescriptors()
  ripgrep/               — 新增：ripgrep 子系统
    service.ts            — rg 二进制发现/下载/缓存
    search.ts             — rg --json 解析 + 结果类型
    index.ts
  concurrency/            — 新增：并发调度
    mutation-queue.ts     — 文件变异队列（per-file 串行化）
    partition.ts          — partitionToolCalls()（readOnly 并行，write/edit 串行）
  index.ts               — 更新 barrel exports
```

---

## 关键架构决策（已确认）

### D1: Write 只新建，Edit 只修改已存在文件

```
file_write guard:
  workspace 外 → deny
  文件已存在 → deny  ← 关键区别！不是 ask，是 deny
  敏感路径 → ask

file_edit guard:
  workspace 外 → deny
  文件未先读 → deny  ← read-snapshot 中无记录
  mtime 已变 → deny  ← 外部修改检测
```

**为什么这样设计**: 明确的职责分离。Write = 创建，Edit = 修改。消除 LLM 意图歧义（"是要覆盖还是修改？"），让工具语义唯一。

**参照**: Claude Code FileStateCache 双检查（validateInput + call mtime），oh-my-openagent per-session read set。Specra 融合两者：read-snapshot after hook 记录 + edit guard mtime 校验。

### D2: 两阶段 Fuzzy Exact Replace

```
Phase 1: 精确匹配  content.indexOf(oldString)
Phase 2: 模糊匹配  normalizeForFuzzyMatch() → indexOf
  - 尾空白剥离
  - 智能引号 → ASCII（' ' " " → ' "）
  - Unicode 破折号 → ASCII（— – → -）
  - CRLF → LF
Phase 2 不含: NFKC Unicode 规范化（v2 预留）
```

**替换在规范化空间执行** — pi-mono 证实这是可接受的 tradeoff（LLM 生成的 oldString 本身就是模糊的）。

**约束**: 每条 oldString 必须且只能匹配一次（0 或 >1 = reject），edits 不可重叠，oldString ≠ newText。

**参照**: pi-mono edit-diff.ts 两阶段；OpenCode 9 级 replacer 过于复杂，v1 不采纳。

### D3: 先读后写 — After Hook + Guard 混合

```
┌─────────────────────────────────────────────────┐
│ file_read after hook (每次读后):                    │
│   readSnapshot.set(realpath, { mtime })            │
│                                                    │
│ file_edit guard (编辑前):                          │
│   1. path in readSnapshot?  → 否 → deny            │
│   2. mtime unchanged?       → 否 → deny            │
│   3. 通过 → execute                               │
│                                                    │
│ file_write guard (写入前):                         │
│   1. workspace 内?         → 否 → deny            │
│   2. file exists?           → 是 → deny (不是ask)  │
│   3. 敏感路径?              → 是 → ask             │
│   4. 通过 → execute                              │
└─────────────────────────────────────────────────┘
```

**read-snapshot 生命周期**: per-session Map（session store 中持有），LRU 1024 路径。写入后使该路径 snapshot 失效（mtime 已变）。

**参照**: oh-my-openagent per-session Set + LRU；Claude Code FileStateCache + mtime 双检查。Specra 融合：用 after hook 注册（解耦），guard 校验 mtime（检测外部修改）。

### D4: 文件变异队列 — per-file 串行化

```typescript
// ≈24 行核心逻辑（pi-mono 证实足够）
const mutationQueue = new Map<string, Promise<void>>();

async function withFileMutationQueue(filePath: string, fn: () => Promise<void>) {
  const key = realpathSync.native(filePath);
  const prev = mutationQueue.get(key) ?? Promise.resolve();
  const next = prev.then(fn);
  mutationQueue.set(key, next);
  try { await next; }
  finally { if (mutationQueue.get(key) === next) mutationQueue.delete(key); }
}
```

**读操作不走队列**（安全并发），写/编辑走队列（同文件串行，不同文件并行）。

### D5: 并发调度 — partitionToolCalls

```
toolCalls: [read_a, read_b, write_c, read_d, edit_c, read_e]
          ↓ partitionToolCalls()
batch 1:  [read_a, read_b]           ← 并发安全，并行执行
serial:   write_c                     ← 破坏安全边界，单独执行
batch 2:  [read_d]                   ← 回到并发
serial:   edit_c                      ← 单独执行
batch 3:  [read_e]                   ← 并发
```

**实现位置**: QueryLoop 层（不是工具层），因为调度决策依赖 agent 上下文。

**参照**: Claude Code `partitionToolCalls()` 最多 10 并发。Specra v1 可用较小并发上限。

### D6: Ripgrep 集成 — 二进制发现 + 自动下载

```
RipgrepService.ensure():
  1. Bun.which("rg") → 找到 → 使用系统 rg
  2. 未找到 → ~/.specra/bin/rg-v15.1.0/{platform}/rg 存在?
     → 是 → 使用缓存
     → 否 → 下载 GitHub release → 解压 → 缓存 → 使用

搜索: rg --json -e pattern --glob filter path
文件: rg --files --glob filter --sortr modified path
```

**平台检测**: `process.platform` + `process.arch` → GitHub release asset 名映射。

**AbortSignal**: `Bun.spawn(["rg", ...], { signal: ctx.abort })` 原生支持。

### D7: Git 操作 — 直接 spawn

```typescript
// 无封装库，纯 subprocess
const result = Bun.spawn(["git", "status", "--porcelain=v1", "-z", ...], {
  cwd: ctx.workspaceRoot,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
});
```

**状态输出**: 解析 porcelain → 格式化文本（`M  src/foo.ts` / `A  bar.ts` / `?? baz.ts`）。

**Diff 输出**: 直接透传 `--no-color --unified=3` unified diff（LLM 理解此格式）。

**参照**: OpenCode 用 Effect wrapper 但本质一样。Claude Code 用类似 flags。

### D8: 错误消息 — 混合模式

```
结构化错误码（程序可读） + 认知助推文本（LLM 自修复指导）

示例:
  "EDIT_OLD_STRING_NOT_FOUND [TOOL_EDIT_NO_MATCH]
   The text to replace was not found in /path/to/file.ts.
   Re-read the file to get current content before editing."
```

**认知助推模式来自**: oh-my-openagent `edit-error-recovery` hook — 非阻塞追加修复指导，不是自动重试。作为 after hook 实现。

---

## 七个工具规格

### 1. file_read

| 维度 | 规格 |
|------|------|
| **traits** | `{ readOnly: true, destructive: false, concurrencySafe: true }` |
| **输入** | `path: string` (必填), `offset?: number` (1-indexed), `limit?: number` |
| **输出** | 带行号的文本 `1: foo\n2: bar\n` |
| **二进制检测** | 非文本文件 → 提示"Binary file, cannot display" |
| **上限** | 单次 50KB，超出由已有 outputTruncator 截断 |
| **guard** | workspace 外 → deny；.env/.env.*/私钥 → ask |
| **after hook** | read-snapshot 注册 |

**行号格式决策**: `1: content\n` 前缀，LLM 需要行号精确定位 edit 区域。参照: Claude Code, OpenCode 均用此格式。

**偏移量/限制**: 允许 LLM 只读文件局部（大文件分页），减少 token 消耗。

### 2. file_write

| 维度 | 规格 |
|------|------|
| **traits** | `{ readOnly: false, destructive: false, concurrencySafe: false }` |
| **输入** | `path: string`, `content: string` |
| **输出** | 成功: `"File written to /path"` |
| **原子写入** | 写 `.tmp.{pid}.{ts}` → rename（POSIX atomic），fallback 直接写 |
| **auto-mkdir** | 仅 workspace root 下的中间目录自动创建 |
| **guard** | workspace 外 → deny；**文件已存在 → deny**；敏感路径 → ask |
| **并发** | 走 mutation-queue |

**关键**: write 只用于创建新文件。修改已存在文件 = file_edit。这消除 LLM 意图歧义。

### 3. file_edit

| 维度 | 规格 |
|------|------|
| **traits** | `{ readOnly: false, destructive: false, concurrencySafe: false }` |
| **输入** | `path: string`, `edits: [{ oldString: string, newString: string }]` |
| **输出** | 成功: 应用了几条 edit + 文件路径 |
| **匹配** | 两阶段: 精确 → fuzzy(modest normalization) |
| **应用** | 批量 back-to-front（偏移稳定） |
| **prepareInput** | 兼容层: edits 字符串→数组, 单 oldString/newString→edits[] |
| **guard** | workspace 外 → deny；**未先读 → deny**；**mtime 已变 → deny** |
| **after hook** | edit-error-recovery (认知助推) |
| **并发** | 走 mutation-queue |

**multi-edit**: 一次调用多条 edit，back-to-front 应用保证偏移稳定。

**oldString 多匹配**: 拒绝整批 edit，要求 LLM 提供更精确的上下文。

### 4. grep

| 维度 | 规格 |
|------|------|
| **traits** | `{ readOnly: true, destructive: false, concurrencySafe: true }` |
| **输入** | `pattern: string` (regex), `path?: string`, `include?: string` (glob), `output_mode?: "content" \| "files_with_matches" \| "count"`, `context?: number` |
| **输出** | 匹配行（带文件路径+行号） |
| **上限** | 100 条结果 |
| **实现** | `rg --json` + 结果解析 |
| **guard** | workspace 外路径 → deny |

### 5. glob

| 维度 | 规格 |
|------|------|
| **traits** | `{ readOnly: true, destructive: false, concurrencySafe: true }` |
| **输入** | `pattern: string`, `path?: string` |
| **输出** | 匹配文件路径列表 |
| **排序** | 按 mtime 降序（最近修改在前） |
| **上限** | 100 条结果 |
| **实现** | `rg --files --glob pattern --sortr modified` |
| **guard** | workspace 外路径 → deny |

### 6. git_status

| 维度 | 规格 |
|------|------|
| **traits** | `{ readOnly: true, destructive: false, concurrencySafe: true }` |
| **输入** | 无 |
| **输出** | 格式化状态列表 `M  file.ts\nA  new.ts\n?? untracked.ts` |
| **实现** | `git status --porcelain=v1 -z --untracked-files=all --no-renames` |
| **guard** | always allow |

### 7. git_diff

| 维度 | 规格 |
|------|------|
| **traits** | `{ readOnly: true, destructive: false, concurrencySafe: true }` |
| **输入** | `staged?: boolean` (默认 false = unstaged) |
| **输出** | unified diff 文本 |
| **实现** | `git diff [--staged] --no-color --unified=3 --no-ext-diff --no-renames` |
| **guard** | always allow |

---

## 共享组件规格

### read-snapshot Store

```typescript
// 挂在 SessionStoreState 上，session 隔离
interface SessionStoreState {
  // ...现有字段...
  readSnapshots: Map<string, number>;  // realpath → mtime
}
```

**写入**: `file_read` after hook 通过 `ctx.store.setState()` 注册
**读取**: `file_edit` / `file_write` guard 通过 `ctx.store.getState()` 校验
**失效**: 写入/编辑成功后清除该路径 snapshot

**LRU**: 1024 路径上限（防止无限增长）— 在 setState 时检查并淘汰。

### RipgrepService

```typescript
interface RipgrepService {
  ensure(): Promise<string>;  // 返回 rg 可执行路径
  search(args: SearchArgs, signal?: AbortSignal): Promise<SearchResult>;
  files(args: FilesArgs, signal?: AbortSignal): Promise<string[]>;
}
```

**自动下载**: GitHub API → release asset → platfrom/arch 映射 → 缓存到 `~/.specra/bin/`。

**搜索结果解析**: `rg --json` NDJSON → Zod 验证 → 结构化 `Match[]`。

### MutationQueue

```typescript
// 约 24 行，pi-mono 证实极简即可
function withFileMutationQueue(filePath: string, fn: () => Promise<string>): Promise<string>;
```

**key**: `realpathSync.native()` 解析符号链接。

### partitionToolCalls

```typescript
function partitionToolCalls(calls: ToolCallLike[], registry: ToolRegistry): ToolCallBatch[];

type ToolCallBatch =
  | { type: "parallel"; calls: ToolCallLike[] }
  | { type: "serial"; call: ToolCallLike };
```

**判定依据**: `descriptor.traits.concurrencySafe` — true 并行，false 串行打断。

---

## Guard 矩阵（汇总）

| 工具 | workspace 外 | 敏感文件 | 已存在文件 | 未先读 | mtime 已变 | 默认 |
|------|-------------|---------|-----------|-------|-----------|------|
| file_read | deny | ask | — | — | — | allow |
| file_write | deny | ask | **deny** | — | — | allow |
| file_edit | deny | — | — | **deny** | **deny** | allow |
| grep | deny | — | — | — | — | allow |
| glob | deny | — | — | — | — | allow |
| git_status | — | — | — | — | — | **allow** |
| git_diff | — | — | — | — | — | **allow** |

**敏感文件规则**: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `id_rsa*`, `id_ed25519*`, `.gitconfig`, `.bashrc`, `.zshrc`, `.npmrc`（含 token）。

**workspace 边界**: `workspaceRoot = realpath(process.cwd())`，所有 `path` 输入 resolve 后必须在 workspaceRoot 下。符号链接解析后检查。

---

## 与 Tier 0 的对接点

Tier 0 已提供的、Tier 1 直接消费的接口:

| Tier 0 组件 | Tier 1 消费方式 |
|------------|---------------|
| `GuardHook` + `combineGuardDecisions` | 每个工具注册 per-tool guards |
| `ToolExecutionContext.allowedTools` | registry runtime mirror check 已实现 |
| `ToolExecutionContext.confirmPermission` | ask 判定走 TUI confirmation |
| `ToolDescriptor.guards` | defineTool 传入 guards 数组 |
| `ToolDescriptor.prepareInput` | file_edit 的 compat layer |
| Permission error codes | guard deny 返回结构化错误 |
| Global after hooks | read-snapshot 注册 + edit-error-recovery |

**Tier 1 需扩充的 Tier 0 类型**:

1. `GuardDecision` 需补充 `prompt` 字段（ask 时 TUI 显示的确认提示文本）— 当前 types.ts 缺失
2. `ToolConfirmationRequest` 需补充 `reason` 字段 — 当前 types.ts 缺失

---

## 实施波次（概要，细节留给实施计划）

```
Wave 1: 基础设施
  - RipgrepService (二进制发现 + 下载 + 搜索)
  - ReadSnapshotStore (store + after hook)
  - MutationQueue
  - partitionToolCalls

Wave 2: 只读工具
  - file_read (含 read-snapshot 注册)
  - grep (含 RipgrepService)
  - glob (含 RipgrepService)
  - git_status
  - git_diff

Wave 3: 写入工具
  - file_write (含 workspace/exist guard, mutation-queue)
  - file_edit (含 fuzzy match, prepareInput, read-before-write guard, mutation-queue, error-recovery)

Wave 4: 集成
  - createBuiltinToolDescriptors() + guard 注册
  - TestAgent 默认 tool set 接入
  - partitionToolCalls 接入 QueryLoop
  - 端到端验证
```

**TDD**: 每个工作单元先写测试，再实现。验证顺序 `bun run typecheck` → `bun test`。

---

## 开放问题（需讨论）

### Q1: read-snapshot Store 挂载位置 ✅ 已决定: A

| 方案 | 描述 | 结论 |
|------|------|------|
| A: 挂在 session store | `SessionStoreState.readSnapshots: Map<string, number>` | ✅ 选定 |
| B: 独立模块 + registry 注入 | 单例 Map，context 传入 | ❌ 多一套隔离逻辑 |
| C: context 新字段 | ctx.readSnapshot | ❌ 也要解决隔离+生命周期 |

**决策理由**: Session store 是 session 隔离的全状态管理器（非 TUI 专属），tools 已通过 `ctx.store` 访问。read-snapshot 是 session-scoped 运行态数据，与 `streamingTools` 同类，放 store 最自然。持久化未来免费。

### Q2: RipgrepService 单例 vs 实例化 ✅ 已决定: A

| 方案 | 描述 | 结论 |
|------|------|------|
| A: 模块单例 | `ensure()` 懒初始化，rg 二进制是全局资源 | ✅ 选定 |
| B: 类实例 | `new RipgrepService(cacheDir)` | ❌ 无多实例场景 |

**决策理由**: 一个 CLI 进程只有一个 rg 二进制路径，类实例引入"谁持有、怎么传"问题却无灵活性收益。

### Q3: partitionToolCalls 放置层级 ✅ 已决定: B

| 方案 | 描述 | 结论 |
|------|------|------|
| A: QueryLoop 内部 | 紧耦合 | ❌ 不好单独测试 |
| B: 独立模块 + loop 调用 | `concurrency/partition.ts` 导出 | ✅ 选定 |

**决策理由**: partition 逻辑是纯函数（输入 tool calls + registry → 输出分批结果），独立可测，loop 只管调度。

### Q4: file_read 的 offset 起始值 ✅ 已决定: B

| 方案 | 描述 | 结论 |
|------|------|------|
| A: 0-indexed | `offset=0` 表示从第一行开始 | ❌ |
| B: 1-indexed | `offset=1` 表示从第一行开始 | ✅ 选定 |

**决策理由**: 输出行号是 `1: foo` 格式，offset 1-indexed 与输出一致，减少 LLM 混淆。

---

## 参考项目致谢

| 模式 | 来源 |
|------|------|
| Operations 接口 + fuzzy edit + mutation queue + prepareArguments | pi-mono |
| partitionToolCalls + FileStateCache + atomic write + tool search | Claude Code |
| 9 级 replacer + Ripgrep auto-download + 3 层 permission | OpenCode |
| read-snapshot guard + error-recovery nudge + metadata store | oh-my-openagent |
| Zod schema + wildcard deny + typed errors | oh-my-opencode-slim |