# Specra Multi-Agent Pipeline — 最终设计方案

> 状态：已确认，待实施
> 日期：2026-05-17

## 0. Correction Draft — 2026-05-18

This document is retained as the original multi-agent pipeline design record. Some later sections still describe stale pre-implementation names and artifact shapes; treat this correction draft as authoritative when it conflicts with older text below.

- **Current agent paths:** workflow agent code lives under `src/agents/definitions/` and is instantiated through `src/agents/factory.ts` using `AgentDefinition` and `ConfiguredAgent`.
- **Updated depth architecture:** `MAX_SUB_AGENT_DEPTH` is now `3`, not `2`. Depth 2 workflow agents such as Builder and Reviewer may delegate to depth 3 Explorer/Librarian-style read-only investigation, while depth 3 strips delegation tools.
- **Workflow agents:** the implemented workflow roles are `product`, `spec`, `critic`, `foreman`, `builder`, `reviewer`, and `librarian`.
- **Workflow tools:** the current workflow tool set is `workflow_create`, `workflow_read`, `workflow_update_stage`, `artifact_read`, `artifact_write`, and `workflow_task_check`.
- **Workflow state:** durable workflow metadata is stored at `.specra/workflows/{workflowId}/workflow.json`; there is no separate global `workflows.json` requirement in the current design.
- **Artifacts:** there is **no `PLAN.md` artifact**. `TASKS.md` is the Markdown-only source of truth for executable task state.
- **TASKS.md format:** executable tasks are top-level `- [ ] Tn. Title` / `- [x] Tn. Title` entries with required `Agent`, `Dependencies`, `Description`, `Acceptance`, and `QA` fields. Nested checkboxes under Acceptance/QA are validation details only, not executable tasks.

## 1. 设计哲学

- **信任 Agent 能力**：充分信任各 Agent 的专业能力，不过度硬编码
- **Prompt 级编排 + 关键状态机守卫**：流水线流转由 Orchestrator 的 system prompt 指导（灵活），关键转换由代码级 hook 守卫（确定性）
- **显式 Artifact 防漂移**：每个阶段产出结构化文件（PRD.md → SPEC.md → PLAN.md → TASKS.md），下游 Agent 基于文件而非记忆
- **错误上抛**：实现阶段 Agent 自主处理；PRD/Spec 阶段错误上抛给 Orchestrator 与用户讨论
- **Given-When-Then 验收标准**：PRD 验收标准强制使用 Given-When-Then 格式，确保可验证性

## 2. Agent 拓扑

```
                               User
                                │
                          Orchestrator (depth 0)
                    │  │  │  │  │  │  │
       ┌───────────┘  │  │  │  │  │  └──────────┐
       │              │  │  │  │  │             │
    Product      Spec Agent  │  Foreman      Critic
    (depth 1)    (depth 1)   │  (depth 1)   (depth 1, read-only)
    (深度交互+研究) (可能交互)  │  (执行调度)    (质量门禁)
         │              │     │    │                │
     Librarian      Librarian  │    │                │
     (depth 2)      (depth 2)  │    │                │
     (外部研究)      (外部研究)  │    │                │
                               │    │                │
                          ┌────┘    └─────┐         │
                          │               │         Explorer
                     Builder          Reviewer       (depth 2)
                     (depth 2)        (depth 2)     (代码库搜索)
                     (写代码)          (审阅代码)
                          │               │
                      Explorer         Explorer
                      (depth 3)        (depth 3)
```

### 各 Agent 职责

| Agent | 职责 | 与用户交互 | 委派目标 |
|-------|------|-----------|---------|
| **Orchestrator** | 顶层流转控制，状态守卫 | 接收初始请求，处理关键错误 | product, spec, critic, foreman |
| **Product Agent** | 需求澄清，竞品研究，产出 PRD | 多轮深度讨论 | explore, librarian |
| **Spec Agent** | 技术规格，计划，任务图，验收标准 | 可能讨论 | explore, librarian |
| **Critic Agent** | 质量门禁，检查 PRD/Spec/TaskGraph 完整性 | 无 | explore |
| **Foreman Agent** | 按 TaskGraph 严格分批派发任务 | 无 | builder, reviewer, explore |
| **Librarian Agent** | 外部文档/竞品/最佳实践搜索 | 无 | explore |
| **Builder Agent** | 代码实现（TDD 约束） | 几乎不问 | explore |
| **Reviewer Agent** | 代码审阅，验收对照 | 几乎不问 | explore |
| **Explorer** | 只读代码库搜索 | 无 | 无（终端 Agent） |

### 深度限制

`MAX_SUB_AGENT_DEPTH = 3`（从 2 增加到 3）

- depth 0: Orchestrator
- depth 1: Product / Spec / Critic / Foreman
- depth 2: Librarian / Builder / Reviewer
- depth 3: Explorer（delegation tools 被剥离）

## 3. 工作流状态机

```
pending → product → critic(check PRD) → spec → critic(check Spec+TaskGraph) → foreman → completed
              │                                   │                              ↕
              │                                   │                    building ↔ reviewing
              │                                   │                    (max 5 轮)
              │                                   │
              └──────── 返工 ──────────────────────┘
              
失败路径: 任何阶段 → failed (上抛给 Orchestrator 处理)
```

### 状态枚举

```typescript
type WorkflowStatus = 
  | "pending"    // 刚创建，未开始
  | "product"   // Product Agent 工作中
  | "reviewing_prd"    // Critic 检查 PRD
  | "spec"       // Spec Agent 工作中
  | "reviewing_spec"   // Critic 检查 Spec+Plan+Tasks
  | "foreman"    // Foreman 调度中
  | "building"   // Builder 实现中（foreman 子状态）
  | "reviewing"  // Reviewer 审阅中（foreman 子状态）
  | "completed"  // 全部完成
  | "failed"     // 失败
  | "paused"      // 暂停（用户中断）
```

### 状态守卫（代码级 Hook）

| 转换 | 守卫条件 | 实现位置 |
|------|---------|---------|
| * → product | 无守卫（起始阶段） | — |
| product → reviewing_prd | PRD.md 存在（Content Agent 已产出） | `src/agents/pipeline/guards.ts` |
| reviewing_prd → spec | `PRD.md` 存在且 `status: approved`（Critic 通过） | `src/agents/pipeline/guards.ts` |
| spec → reviewing_spec | SPEC.md + PLAN.md + TASKS.md 存在 | `src/agents/pipeline/guards.ts` |
| reviewing_spec → foreman | SPEC.md + PLAN.md + TASKS.md 存在且 `status: approved`（Critic 通过） | `src/agents/pipeline/guards.ts` |
| foreman → completed | 所有 TaskGraph 任务完成且 Reviewer 通过 | Foreman 的 todo-continuation |
| reviewing_prd → product | Critic 拒绝，打回 Product 返工 | Orchestrator 决策 |
| reviewing_spec → spec | Critic 拒绝，打回 Spec 返工 | Orchestrator 决策 |

### Critic 门禁规则

Critic 作为可选门禁，有两种模式：

1. **必需门禁（MVP 默认）**：每个阶段转换必须经过 Critic 审核通过
2. **可选门禁（未来）**：Orchestrator 可以跳过 Critic 直接推进（简单任务时）

Critic 审核内容：

| 门禁 | 检查项 |
|------|--------|
| **PRD 门禁** | 验收标准是否可验证、需求是否完整、优先级是否明确、Given-When-Then 格式是否正确 |
| **Spec 门禁** | 技术方案是否覆盖所有 P0 需求、组件设计是否明确、依赖是否合理、文件路径是否存在于代码库 |
| **TaskGraph 门禁** | 任务是否可执行粒度、依赖关系是否正确、批并行标记是否合理、验收标准是否有对应任务 |

## 4. Artifact 格式

所有 Artifact 使用 YAML frontmatter + Markdown 格式，存储在 `.specra/workflows/{workflowId}/` 目录。

### PRD.md（Product Brief）

```markdown
---
stage: product
attempt: 1
actorClock:
  product: 1
createdAt: 2026-05-17T10:30:00Z
updatedAt: 2026-05-17T10:30:00Z
status: approved  # draft | approved | rejected
---

# Product Brief: [Feature Name]

## Background & Motivation
[Why this feature matters, what problem it solves]

## Goals & Success Metrics
[Measurable outcomes that define success]

## User Stories
### US-1: [Story Title]
As a [role], I want to [action], so that [benefit].

## Requirements (Priority)
- [P0] Requirement 1 (must-have)
- [P1] Requirement 2 (should-have)
- [P2] Requirement 3 (nice-to-have)

## Non-Functional Requirements
[Performance, Security, Scalability, Reliability]

## Acceptance Criteria (Given-When-Then)
### AC-1: [Criterion Title]
- **Given** [precondition]
- **When** [action]
- **Then** [expected result]

### AC-2: [Criterion Title]
- **Given** [precondition]
- **When** [action]
- **Then** [expected result]

## Out of Scope
- [What this feature does NOT cover]

## Open Questions
- [ ] [Unresolved question]
```

### SPEC.md（Technical Specification）

```markdown
---
stage: spec
attempt: 1
actorClock:
  product: 1
  spec: 1
createdAt: ...
status: approved
---

# Technical Specification: [Feature Name]

## Overview
[High-level technical approach — 2-3 sentence summary]

## Architecture Decisions
[Key technical decisions and rationale — why this approach over alternatives]

## Component Design
[Detailed component/interface descriptions — what changes, what stays the same]

## Data Model
[Entities, relationships, constraints — new or modified data structures]

## API Contracts
[Endpoints, request/response schemas — new or modified APIs]

## Acceptance Criteria Mapping
| AC ID | Spec Section | Implementation Notes |
|-------|---------------|---------------------|
| AC-1  | Component X   | ...                 |
| AC-2  | Data Model    | ...                 |

## Validation Hooks
[File paths that should exist, APIs that should be callable, deps that should be installed]
```

### PLAN.md（Technical Plan）

```markdown
---
stage: plan
attempt: 1
actorClock:
  product: 1
  spec: 1
  plan: 1
createdAt: ...
status: approved
---

# Implementation Plan: [Feature Name]

## Approach Overview
[High-level implementation strategy — the big picture]

## Implementation Steps

### Phase 1: [Name]
[Description of what this phase accomplishes]

#### Step 1.1: [Name]
- **Files to modify**: `src/foo/bar.ts`
- **Changes**: [What to add/change/remove]
- **AC refs**: AC-1, AC-2

#### Step 1.2: [Name]
- **Files to modify**: `src/baz/qux.ts`
- **Changes**: [What to add/change/remove]
- **AC refs**: AC-3

### Phase 2: [Name]
[Description — this phase depends on Phase 1]

#### Step 2.1: [Name]
- **Files to modify**: ...
- **Changes**: ...
- **AC refs**: ...

## Testing Strategy
[How to verify the implementation — unit tests, integration tests, manual verification]

## Risk Assessment
[Potential risks and mitigation strategies]
```

### TASKS.md（Task Graph）

```markdown
---
stage: tasks
attempt: 1
actorClock:
  product: 1
  spec: 1
  tasks: 1
createdAt: ...
status: approved
---

# Task Graph: [Feature Name]

## Batch 1 — [Phase Name] (sequential within, parallel marked [P])
- [ ] 1.1: [Task description] — `src/foo/bar.ts` [P]
- [ ] 1.2: [Task description] — `src/baz/qux.ts` [P]
- [ ] 1.3: [Task description] — `src/core/engine.ts` (depends on 1.1, 1.2)

## Batch 2 — [Phase Name] (depends on Batch 1)
- [ ] 2.1: [Task description] — `src/api/routes.ts` [AC-1, AC-2]
- [ ] 2.2: [Task description] — `src/api/handlers.ts` [P] [AC-3]

## Batch 3 — [Phase Name] (depends on Batch 2)
- [ ] 3.1: [Task description] — `src/tests/integration.ts` [AC-1, AC-2, AC-3]

## Verification
- [ ] All P0 requirements covered by at least one task
- [ ] All acceptance criteria have corresponding tasks
- [ ] All file paths in tasks exist in codebase
- [ ] No circular dependencies between batches
```

### Review Report（review-{n}.md）

```markdown
---
stage: review
attempt: 1
actorClock:
  product: 1
  spec: 1
  review: 1
createdAt: ...
decision: approved  # approved | changes_requested | concerns
---

# Review Report

## Summary
[Brief summary of review findings]

## Issues
### Critical
- [file:line] Description + suggestion

### Major
- [file:line] Description + suggestion

### Minor
- [file:line] Description + suggestion

## Acceptance Criteria Checklist
- [x] AC-1: [criterion met]
- [ ] AC-2: [criterion not met, reason]
```

### Critic Report（critic-{stage}-{n}.md）

```markdown
---
stage: critic
gate: reviewing_prd  # reviewing_prd | reviewing_spec
attempt: 1
actorClock:
  product: 1
  critic: 1
createdAt: ...
decision: approved  # approved | changes_requested | rejected
---

# Critic Report: [PRD | Spec+Plan+Tasks] Review

## Completeness Check
- [x] All required sections present
- [x] Acceptance criteria in Given-When-Then format
- [ ] [Missing section or format issue]

## Consistency Check
- [x] Requirements trace to acceptance criteria
- [x] Acceptance criteria map to tasks
- [ ] [Inconsistency found]

## Feasibility Check
- [x] Referenced files exist in codebase
- [x] Dependencies are available
- [ ] [Feasibility concern]

## Decision
[approved | changes_requested with specific items to fix | rejected with rationale]

## Suggestions
[Optional improvement suggestions — not blocking, but recommended]
```

## 5. Workflow 状态管理

### 文件结构

```
.specra/workflows/
├── workflows.json              # 全局索引（对象格式，key=workflowId）
├── auth-system/                # workflowId
│   ├── workflow.json            # 工作流状态
│   ├── PRD.md                  # Product Brief
│   ├── SPEC.md                 # Technical Specification
│   ├── PLAN.md                 # Implementation Plan
│   ├── TASKS.md                # Task Graph
│   ├── evidence/               # QA 证据
│   ├── review/                 # Builder↔Reviewer 审阅报告
│   │   ├── review-1.md
│   │   └── review-2.md
│   └── critic/                 # Critic 门禁报告
│       ├── critic-prd-1.md
│       └── critic-spec-1.md
```

### workflows.json 格式

```jsonc
{
  "auth-system": {
    "workflowId": "auth-system",
    "status": "foreman",
    "currentStage": "foreman",
    "createdAt": "2026-05-17T10:00:00Z",
    "updatedAt": "2026-05-17T10:30:00Z"
  }
}
```

仅 Orchestrator 写入 `workflows.json`。

### workflow.json 完整 Schema

```typescript
const WorkflowSchema = z.object({
  workflowId: z.string(),
  status: z.enum([
    "pending", "product", "reviewing_prd", "spec", "reviewing_spec",
    "foreman", "building", "reviewing",
    "completed", "failed", "paused"
  ]),
  currentStage: z.enum([
    "product", "reviewing_prd", "spec", "reviewing_spec",
    "foreman", "completed"
  ]),
  retryCount: z.number().default(0),
  maxRetries: z.number().default(5),
  stages: z.object({
    product: z.object({
      status: z.enum(["pending", "active", "completed", "failed"]),
      artifactPath: z.string().optional(),
      sessionId: z.string().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
    }),
    criticPrd: z.object({
      status: z.enum(["pending", "active", "approved", "rejected"]),
      reportPath: z.string().optional(),
      sessionId: z.string().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
    }),
    spec: z.object({
      status: z.enum(["pending", "active", "completed", "failed"]),
      artifactPaths: z.object({
        spec: z.string().optional(),
        plan: z.string().optional(),
        tasks: z.string().optional(),
      }).optional(),
      sessionId: z.string().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
    }),
    criticSpec: z.object({
      status: z.enum(["pending", "active", "approved", "rejected"]),
      reportPath: z.string().optional(),
      sessionId: z.string().optional(),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
    }),
    foreman: z.object({
      status: z.enum(["pending", "active", "completed", "failed"]),
      sessionId: z.string().optional(),
      currentBatch: z.number().default(0),
      totalBatches: z.number().default(0),
      startedAt: z.string().optional(),
      completedAt: z.string().optional(),
    }),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
```

## 6. Agent 定义

### 新增 Agent Definitions

| Agent | promptAgentId | Tools | delegateTargets | childPolicy | Hooks |
|-------|--------------|-------|-----------------|-------------|-------|
| **product** | "product" | ask_user, file_read, file_write(pipeline only), grep, glob, web_fetch, memory_*, lsp_*, delegate, background_output, wait_for_reminder, view_tool_output, todo_write | ["explore", "librarian"] | maxDepth:1, maxConcurrent:5, timeoutMs:10min | todoContinuation:disabled (交互式), autoCompact, titleGeneration |
| **spec** | "spec" | 同 product + pipeline-state 工具 | ["explore", "librarian"] | maxDepth:1, maxConcurrent:5, timeoutMs:10min | todoContinuation, autoCompact, titleGeneration |
| **critic** | "critic" | file_read, grep, glob, lsp_diagnostics, lsp_symbols, delegate, memory_read | ["explore"] | maxDepth:1, maxConcurrent:3, timeoutMs:10min | autoCompact, enforceToolOutputQuota |
| **foreman** | "foreman" | file_read, grep, glob, todo_write, memory_read, delegate, background_output, wait_for_reminder, view_tool_output, pipeline-state | ["builder", "reviewer", "explore"] | maxDepth:2, maxConcurrent:3, timeoutMs:20min | todoContinuation, autoCompact, titleGeneration, enforceToolOutputQuota |
| **librarian** | "librarian" | file_read, grep, glob, web_fetch, delegate, memory_read | ["explore"] | maxDepth:1, maxConcurrent:3, timeoutMs:5min | autoCompact, enforceToolOutputQuota |
| **builder** | "builder" | All write tools (file_read, file_write, file_edit, bash, lsp_*, grep, glob), delegate, memory_read, todo_write | ["explore"] | maxDepth:1, maxConcurrent:2, timeoutMs:15min | todoContinuation, autoCompact, enforceToolOutputQuota |
| **reviewer** | "reviewer" | Read-only + bash(tests only, prompt-constrained), lsp_*, delegate, memory_read, todo_write | ["explore"] | maxDepth:1, maxConcurrent:2, timeoutMs:10min | todoContinuation, autoCompact, enforceToolOutputQuota |

### Librarian Agent 详细设计

**定位**：轻量外部搜索 Agent，只读不写，专注于多步研究后返回摘要。

**特点**：
- **Read-only + 搜索**：不修改任何文件，不与用户交互
- **多步研究**：可以多轮搜索（搜 → 评估 → 深入搜索），返回结构化摘要
- **并行研究**：Product Agent 对话时可后台委派 Librarian 做研究，不阻塞对话
- **fast/cheap 模型**：搜索任务不需要最强模型，节省成本

**为什么不用 MCP 工具直接搜索**：
- MCP 工具（context7、grep.app、exa）是单次查询，无法做多步综合研究
- Librarian 可以搜多个来源 → 评估 → 组合 → 返回精炼摘要
- Product 对话期间可并行委派 Librarian 做后台研究
- 隔离搜索上下文，不污染主 Agent 的对话历史

### Critic Agent 详细设计

**特点**：
- **Read-only**：不修改任何文件，只产出 critic report
- **强制 Given-When-Then 检查**：验证验收标准是否符合格式
- **代码库一致性检查**：验证 Spec 中引用的文件路径、API、依赖是否存在
- **不同模型**：建议配置为比 Product/Spec 更强或不同家族的模型（利用视角多样性）

**门禁流程**：
```
Product 产出 PRD.md → Orchestrator 委派 Critic → Critic 检查 PRD → 
  → approved: 进入 Spec 阶段
  → changes_requested: 打回 Product 修改
  → rejected: 严重问题，Orchestrator 处理
```

### Orchestrator 更新

- `delegateTargets` 添加: `["explore", "product", "spec", "critic", "foreman"]`
  - 注意：Orchestrator **不直接委派 Librarian**，Librarian 由 Product/Spec/Builder/Reviewer 委派
- System prompt 描述完整 Pipeline 流程（含 Critic 门禁）
- 新增 Pipeline 工具集（workflow_create, workflow_read, workflow_update_stage, artifact_write, artifact_read）

### Builder TDD 约束

Builder Agent 的 system prompt 中包含 TDD 约束：
- 优先写测试，再写实现
- 每个任务完成后运行相关测试
- 如果测试不通过，不报告任务完成

（Prover Agent 留作后期扩展，初期通过 prompt 约束实现 TDD）

## 7. 新增代码结构

```
src/agents/
├── definitions/
│   ├── index.ts              # 注册所有定义（aggregator）
│   ├── orchestrator.ts       # 现有
│   ├── explore.ts            # 现有
│   ├── product.ts            # 新增
│   ├── spec.ts               # 新增
│   ├── critic.ts             # 新增
│   ├── foreman.ts            # 新增
│   ├── librarian.ts          # 新增
│   ├── builder.ts            # 新增
│   └── reviewer.ts           # 新增
├── pipeline/
│   ├── guards.ts             # 状态守卫：PRD→Spec, Spec→Foreman 的 artifact 检查
│   ├── artifacts.ts          # Artifact 读写（frontmatter 解析/生成/验证）
│   ├── workflow-state.ts     # workflow.json + workflows.json 管理
│   └── prompts.ts            # 各 Pipeline Agent 的 prompt 模板
└── ...

src/tools/
├── pipeline-create.ts        # workflow_create: 创建新 workflow
├── pipeline-read.ts          # workflow_read: 读取 workflow 状态
├── pipeline-update-stage.ts  # workflow_update_stage: 更新阶段状态
├── artifact-write.ts         # artifact_write: 写入 artifact（自动 frontmatter + 状态同步）
└── artifact-read.ts         # artifact_read: 读取 artifact（解析 frontmatter）
```

### Pipeline 工具详细设计

| 工具 | 谁用 | 做什么 | 关键行为 |
|------|------|--------|---------|
| `workflow_create` | Orchestrator | 创建新 workflow，生成目录和初始 workflow.json | 自动生成 slug，创建 `.specra/workflows/{id}/` 目录 + workflow.json |
| `workflow_read` | 所有 pipeline agent | 读取当前 workflow 状态 | 返回 parsed WorkflowSchema 对象 |
| `workflow_update_stage` | 当前阶段的 Agent | 更新自己阶段的状态 | 只允许更新自己负责的 stage，自动带 timestamp |
| `artifact_write` | 有写权限的 Agent | 写入 artifact 文件 | 自动注入 frontmatter（stage, attempt, actorClock, timestamps, status），同步更新 workflow.json |
| `artifact_read` | 所有 Agent | 读取 artifact 文件 | 解析 YAML frontmatter，返回 `{ frontmatter, body }` 结构化数据 |

**为什么不直接用 file_read/file_write**：
- Frontmatter（actorClock, status, attempt 等）需要自动生成和递增，Agent 手动维护容易出错
- 写 artifact 时需要同步更新 workflow.json 的对应 stage 状态
- 格式验证防止无效 frontmatter 破坏状态机守卫
- 简化 Agent prompt — Agent 只需知道写什么内容，不需要了解 frontmatter 格式

## 8. 上下文传递机制

遵循 oh-my-openagent 模式：
- **Delegate prompt 内注入上下文**：父 Agent 委派时在 prompt 中包含上游 Artifact 的关键内容摘要
- **完整文件在磁盘上**：子 Agent 可通过 file_read 读取完整 Artifact
- **不共享 session 历史**：每个子 Agent 从空 Store 启动

示例：Orchestrator 委派 Spec Agent 时的 prompt：
```
你收到了一个已通过 Critic 审核的 Product Brief。

## Product Brief 摘要
[自动提取的 PRD 关键内容：需求、验收标准、优先级]

## 你的任务
1. 读取完整 PRD: .specra/workflows/{id}/PRD.md
2. 基于代码库现状，生成 SPEC.md、PLAN.md、TASKS.md
3. 确保每个验收标准都有对应的技术方案和任务
```

## 9. 错误处理策略

| 阶段 | 错误处理 |
|------|---------|
| Product | 错误上抛给 Orchestrator，与用户讨论 |
| Critic (PRD) | 打回 Product 修改，或 Orchestrator 处理 |
| Spec | 错误上抛给 Orchestrator，可能讨论 |
| Critic (Spec) | 打回 Spec 修改，或 Orchestrator 处理 |
| Foreman/Builder/Reviewer | Foreman 自主处理（重试、调整策略），不干扰用户 |
| 超过 maxRetries | Foreman 报告失败给 Orchestrator，Orchestrator 决定策略 |

## 10. 中断恢复

Orchestrator 重启时：
1. 读取 `workflows.json` 找到未完成的 workflow
2. 读取对应 `workflow.json` 获取状态
3. 检查各 stage 的 status 和 actorClock
4. 从未完成的 stage 恢复：
   - product/spec 阶段中断 → 重新委派该 Agent（从空 Store）
   - foreman 阶段中断 → 根据 currentBatch 和 totalBatches 恢复进度
   - critic 阶段中断 → 重新委派 Critic

## 11. 完整工作流示例

```
用户: "我想给 Specra 加一个 auth 系统"

1. Orchestrator 创建 workflow "auth-system"
   → 写入 .specra/workflows/auth-system/workflow.json (status: "product")

2. Orchestrator 委派 Product Agent
   → Product 多轮讨论需求
   → 产出 PRD.md (status: "draft")
   → 与用户讨论后 PRD.md (status: "approved")
   → workflow.json 更新为 status: "reviewing_prd"

3. Orchestrator 委派 Critic (PRD gate)
   → Critic 检查 PRD 完整性、Given-When-Then 格式、需求可追踪性
   → Critic 通过 → critic-prd-1.md (decision: "approved")
   → workflow.json 更新为 status: "spec"

4. Orchestrator 委派 Spec Agent
   → Spec 读取 PRD.md
   → 产出 SPEC.md + PLAN.md + TASKS.md (status: "draft")
   → 审核后 (status: "approved")
   → workflow.json 更新为 status: "reviewing_spec"

5. Orchestrator 委派 Critic (Spec gate)
   → Critic 检查 Spec 完整性、Plan 可行性、TaskGraph 依赖关系
   → Critic 通过 → critic-spec-1.md (decision: "approved")
   → workflow.json 更新为 status: "foreman"

6. Orchestrator 委派 Foreman Agent
   → Foreman 读取 TASKS.md
   → Foreman 按批次委派 Builder + Reviewer

   Batch 1:
   → Foreman 委派 Builder (Task 1.1, 1.2)
   → Foreman 委派 Reviewer → review-1.md
   → Reviewer 通过或要求修改
   
   ... (repeat for each batch)

   → 所有批次完成，所有 Reviewer 通过
   → workflow.json 更新为 status: "completed"

7. Orchestrator 报告完成
```

## 12. MVP 范围

- ✅ 单活跃 workflow
- ✅ 完整 5 阶段 pipeline（Product → Critic(PRD) → Spec → Critic(Spec) → Foreman → Builder/Reviewer）
- ✅ Critic 作为必需门禁
- ✅ Foreman 严格按 TaskGraph 分批派发
- ✅ Builder↔Reviewer 修复循环（硬上限 5 轮）
- ✅ Builder TDD 约束（prompt 级别）
- ✅ Librarian 外部研究 Agent
- ✅ 状态守卫（PRD approved → Spec, Spec approved → Foreman）
- ✅ Given-When-Then 验收标准格式
- ✅ 三文件 Spec 产物（SPEC.md + PLAN.md + TASKS.md）
- ✅ Pipeline 工具集（workflow_create, workflow_read, workflow_update_stage, artifact_write, artifact_read）
- ✅ 中断恢复
- ✅ 每个 Agent 独立定义文件
- ❌ Direct mode（简化路径，后续添加）
- ❌ 多并发 workflow（后续添加）
- ❌ Prover Agent（后续添加，初期用 Builder TDD prompt 约束代替）
- ❌ 跨模型 Reviewer（后续添加，配置支持已就绪）
- ❌ Critic 可选跳过（后续添加）

## 13. 后续扩展（非 MVP）

| 扩展 | 描述 | 优先级 |
|------|------|--------|
| **Direct Mode** | 简单 bug 修复跳过 Product/Spec，直接进入 Foreman | P1 |
| **Prover Agent** | 专门测试生成 Agent，不同模型家族 | P1 |
| **多并发 Workflow** | 支持多个 workflow 并行执行 | P2 |
| **Critic 可选跳过** | Orchestrator 可决定跳过 Critic 门禁 | P2 |
| **跨模型 Reviewer** | Reviewer 配置为不同模型家族 | P1 |
| **Security Reviewer** | 专门安全审阅 Agent | P3 |
| **Constitution** | 全局项目约束文件，类似 .cursorrules | P3 |
