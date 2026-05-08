# oh-my-openagent v4.0 Team Mode 深度分析

> 本报告基于 oh-my-openagent v4.0.0（发布于 2026-05-07）的源码和文档，
> 深入分析 Team Mode 的架构设计、实现细节与关键决策。

---

## 目录

1. [概述](#1-概述)
2. [整体架构](#2-整体架构)
3. [模块布局](#3-模块布局)
4. [智能体通信：邮箱系统](#4-智能体通信邮箱系统)
5. [任务系统](#5-任务系统)
6. [运行时状态管理](#6-运行时状态管理)
7. [生命周期管理](#7-生命周期管理)
8. [Hook 系统](#8-hook-系统)
9. [成员资格与角色](#9-成员资格与角色)
10. [配置参考](#10-配置参考)
11. [与单智能体模式对比](#11-与单智能体模式对比)
12. [关键架构决策](#12-关键架构决策)

---

## 1. 概述

Team Mode 是 oh-my-openagent v4.0 的核心新特性，由 PR #3493（160 commits）引入。
它将 oh-my-openagent 从 "1 个主智能体 + 后台子智能体" 的模式，升级为
**真正的多智能体并行协调系统**——一个 Lead 智能体协调多个专门化的 Member 智能体，
所有成员通过共享邮箱（mailbox）、共享任务列表（task list）和可选的 tmux 可视化布局
进行实时通信。

**默认关闭**——必须通过 `team_mode.enabled: true` 在配置中显式启用。

---

## 2. 整体架构

### 架构层级

```
┌──────────────────────────────────────────────────────────┐
│                    Plugin Layer                           │
│  ┌──────────────────────────────────────────────────────┐ │
│  │              12 team_* MCP Tools                      │ │
│  │  (create / delete / send_message / task_* / status)   │ │
│  └──────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│                   Feature Layer                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐  │
│  │ Registry │ │  State   │ │ Mailbox  │ │  Tasklist   │  │
│  │ (teams)  │ │  Store   │ │ (async)  │ │ (shared)    │  │
│  ├──────────┤ ├──────────┤ ├──────────┤ ├─────────────┤  │
│  │ Runtime  │ │ Worktree │ │  Tmux    │ │ Session     │  │
│  │(lifecycle)│ │ (git)    │ │ (Layout) │ │ Registry    │  │
│  └──────────┘ └──────────┘ └──────────┘ └─────────────┘  │
├──────────────────────────────────────────────────────────┤
│                  Hook Layer                               │
│  ┌─────────────────┐ ┌──────────────┐ ┌───────────────┐  │
│  │ Mailbox Injector │ │Tool Gating   │ │Session Events │  │
│  │(transform-phase) │ │(role-based)  │ │(idle/error/   │  │
│  │                  │ │              │ │ orphan)       │  │
│  └─────────────────┘ └──────────────┘ └───────────────┘  │
└──────────────────────────────────────────────────────────┘
```

三层架构的设计理念：

- **Plugin Layer**：对外暴露 12 个 `team_*` MCP 工具，是 Lead 和 Member 智能体的操作接口
- **Feature Layer**：核心能力模块，包括团队注册、状态存储、消息投递、任务管理、生命周期管理、
  git worktree 隔离、tmux 可视化布局和会话注册
- **Hook Layer**：横切关注点——消息注入、角色权限控制和会话事件处理

---

## 3. 模块布局

所有 Team Mode 代码位于 `src/features/team-mode/` 下：

```
src/features/team-mode/
├── index.ts                                  # barrel export
├── types.ts                                  # 核心 Zod schemas + AGENT_ELIGIBILITY_REGISTRY
├── deps.ts                                   # tmux/git 可用性探测
├── member-parser.ts                          # 成员 eligibility 验证
├── member-guidance.ts                        # 自动注入的团队成员行为指南
├── member-session-resolution.ts              # 成员 session 解析
├── member-session-routing.ts                # 成员 session 路由
├── resolve-caller-team-lead.ts               # 判断调用者是否能做 team lead
├── team-session-registry.ts                  # spawn-race-safe sessionID → team/member 查询
│
├── team-registry/                            # 团队规格加载
│   ├── paths.ts                              # 基础目录解析
│   ├── loader.ts                             # 从磁盘加载 TeamSpec JSON
│   ├── team-spec-input-normalizer.ts         # 输入规范化
│   └── validator.ts                          # 团队规格验证
│
├── team-state-store/                         # 持久化运行时状态
│   ├── store.ts                              # create/load/save/transitionRuntimeState
│   ├── locks.ts                              # 原子文件锁（PID-based）
│   └── resume.ts                             # 启动恢复 + 孤儿清理 + 过期锁回收
│
├── team-mailbox/                             # 异步消息系统
│   ├── send.ts                               # 发送消息（广播检查、背压、写时预预留）
│   ├── inbox.ts                              # listUnreadMessages
│   ├── poll.ts                               # pollAndBuildInjection（构建 <peer_message> 信封）
│   ├── ack.ts                                # 确认已读（移至 processed/）
│   └── reservation.ts                        # 原子重命名预留
│
├── team-tasklist/                            # 共享任务列表
│   ├── store.ts                              # CRUD + highwatermark 计数器
│   ├── claim.ts                              # flock-style 任务认领
│   └── update.ts                             # 状态更新
│
├── team-worktree/                            # 可选的 git worktree
│   └── manager.ts                            # create/validate/cleanup
│
├── team-runtime/                             # 运行时生命周期
│   ├── create.ts                             # 创建工作流（含回滚）
│   ├── shutdown.ts                           # 2 阶段关闭
│   ├── status.ts                             # 运行时状态查询
│   ├── delete-team.ts                        # 完整资源清理
│   ├── resolve-member.ts                     # 将成员映射到代理 + 模型
│   ├── resolve-member-dependencies.ts        # 依赖注入（category/subagent resolver）
│   ├── activate-team-layout.ts               # tmux 面板布局激活
│   └── cleanup-team-run-resources.ts         # 创建失败后的回滚清理
│
├── team-layout-tmux/                         # tmux 可视化布局
│   ├── layout.ts                             # pane 拆分 + opencode attach
│   ├── resolve-caller-tmux-session.ts        # 解析调用者 tmux pane
│   └── sweep-stale-team-sessions.ts          # 清理过期 session
│
└── tools/                                    # 12 个 team_* MCP 工具
    ├── lifecycle.ts                          # create / delete / shutdown_request / approve / reject
    ├── messaging.ts                          # send_message
    └── tasks.ts                              # task_create / list / update / get
    └── query.ts                              # status / list
```

**相关 hooks** 位于 `src/hooks/` 下：

- `team-mailbox-injector/` — Transform 阶段 hook，在每个 turn 前将 `<peer_message>` 信封注入对话
- `team-tool-gating/` — Tool Guard 阶段 hook，基于角色（lead vs member）控制工具权限
- `team-session-events/` — 事件处理器：`lead-orphan`、`member-error`、`idle-wake-hint`

---

## 4. 智体通信：邮箱系统

Team Mode 使用**异步 mailbox 模型**，基于文件系统原子操作实现**至少一次投递**（at-least-once delivery）。

### 消息流程

```
1. team_send_message(sender, recipient, body)
   ↓
2. send.ts: 检查广播权限（仅 lead 可 to:"*"），验证消息大小（默认 32KB 上限）
   ↓
3. 写入收件人 inbox 目录：
   ├── Live recipient (session 在线)
   │   → .delivering-{uuid}.json  （预预留文件，对 poll 不可见）
   └── Offline recipient
       → {uuid}.json  （poll 可见）
   ↓
4. Transform hook (team-mailbox-injector) 在每个 turn 前调用 poll.ts
   ↓
5. poll.ts: 构建 <peer_message> 信封注入对话
   ↓
6. 记录 pendingInjectedMessageIds 到 durable RuntimeState
   ↓
7. 当 agent 进入 idle 状态 → ack.ts: 将消息从 inbox 移至 processed/ 目录
```

### 关键设计细节

**`.delivering-*` 预预留机制**：这是解决 `promptAsync` 与 transform hook 之间竞态条件的关键设计
（Oracle R21 修复）。

- 当 Lead 调用 `team_send_message` 时，如果收件人 session 正在线，消息先以
  `.delivering-{uuid}.json` 的名字写入收件人 inbox
- 此文件名以点号开头，`poll.ts` 会跳过这些文件（类似 Unix 隐藏文件约定）
- 当 `promptAsync` 完成后，再原子重命名为 `{uuid}.json`，此时 poll 才能看到
- 如果 session crash，`resume.ts` 会在 10 分钟 TTL 后回收这些 stranded 预留文件

**背压控制**：每个收件人有一个未读字节上限（默认 256KB），超过限制后发送方会收到错误，
防止消息无限堆积。

**原子写入**：所有文件写入使用 `atomicWrite()`——先写临时文件 → fsync → 原子 rename，
确保不会出现半写文件。

---

## 5. 任务系统

共享任务列表使用**文件系统锁**实现并发控制：

### 操作流程

```
team_task_create  → 写入 {tasksDir}/{id}.json
                    ↑ 原子递增 .highwatermark 计数器获取 ID

team_task_claim   → withLock() → 写入 claims/{id}.lock
                    ↑ flock-style 原子认领

team_task_update  → 更新 task 字段（owner, status, blocks/blockedBy）

team_task_list    → 读取所有任务（支持按 status/owner 过滤）

team_task_get     → 读取单个任务详情
```

### 任务状态机

```
pending → claimed → in_progress → completed
                                    └── deleted
```

- `pending` — 任务已创建，等待认领
- `claimed` — 某个 member 已认领，但尚未开始工作
- `in_progress` — 正在执行中
- `completed` — 已完成
- `deleted` — 已删除

### 依赖关系

任务支持 `blocks` 和 `blockedBy` 字段，允许表达任务间的依赖关系：
- `blocks: ["task-2"]` — 当前任务阻塞 task-2
- `blockedBy: ["task-1"]` — 当前任务被 task-1 阻塞

### ID 生成

任务 ID 通过 `.highwatermark` 文件原子递增生成，确保在多个 member 并发创建任务时
ID 不会冲突：

```
# .highwatermark 文件内容示例
42
```

每次创建任务时，读取当前值 +1，然后原子写回新值。使用文件锁 `tasks/.lock` 保护。

---

## 6. 运行时状态管理

### 状态文件

状态以 JSON 文件持久化到 `~/.omo/runtime/{teamRunId}/state.json`，使用原子写入。

### 状态机

```
creating → active → shutdown_requested → deleting → deleted
         → failed
                                orphaned ← (recovered)
```

### 合法状态转换

```
creating:           → active, failed
active:             → shutdown_requested, deleting
shutdown_requested: → deleting
deleting:           → deleted
```

### RuntimeState 核心结构

```typescript
{
  version: 1,
  teamRunId: uuid,
  teamName: string,
  specSource: "project" | "user",
  createdAt: timestamp,
  status: "creating" | "active" | "shutdown_requested" | "deleting" | "deleted" | "failed" | "orphaned",

  leadSessionId?: string,
  tmuxLayout?: { ownedSession, targetSessionId, ... },

  members: [{
    name: string,
    sessionId?: string,
    agentType: "leader" | "general-purpose",
    status: "pending" | "running" | "idle" | "errored",
    subagent_type?: string,
    category?: string,
    model?: { providerID, modelID, variant?, ... },
    lastInjectedTurnMarker?: string,
    pendingInjectedMessageIds: string[],
    worktreePath?: string
  }],

  shutdownRequests: [{
    memberId: string,
    requesterName: string,
    requestedAt: timestamp,
    ...
  }],

  bounds: {
    maxMembers: number,
    maxParallelMembers: number,
    ...
  }
}
```

### 文件系统布局

```
~/.omo/
├── teams/{name}/config.json                      # 声明的团队规格
├── .highwatermark                                # 运行时状态奇偶标记
└── runtime/{teamRunId}/
    ├── state.json                                # 持久化运行时状态
    ├── state.lock                                # 单实例锁
    ├── inboxes/{member}/{uuid}.json              # 未读消息
    ├── inboxes/{member}/.delivering-{uuid}.json  # 实时投递预留（hidden from poll）
    ├── inboxes/{member}/processed/               # 已 ack 消息
    ├── inboxes/{member}.lock                     # per-recipient 锁
    ├── tasks/{id}.json                           # 共享任务
    ├── tasks/.highwatermark                      # 任务 ID 计数器
    ├── tasks/.lock                               # 任务锁
    └── claims/{id}.lock                          # 任务认领锁
```

---

## 7. 生命周期管理

### 创建流程

`team_create` 触发以下事务式流程：

1. 验证团队规格（TeamSpec）
2. 解析每个 member → 选择智能体 + 模型
3. 为每个 member 创建 git worktree（可选）
4. 启动 member sessions
5. 写入 RuntimeState（`creating` → `active`）
6. 激活 tmux 布局（可选）

**创建回滚**：如果任何步骤失败，`cleanup-team-run-resources.ts` 自动清理已创建的
member session、worktree 和 tmux pane，避免资源泄漏。

### 2 阶段关闭

```
Lead 发送 team_shutdown_request(memberId)
   ↓
Member 收到请求 → team_approve_shutdown() 或 team_reject_shutdown()
   ↓
如果批准 → Member session 被清理，状态变为 deleting → deleted
```

这个设计防止 member 被意外终止，给予它们完成当前工作的机会。

### 启动恢复

`resumeAllTeams()` 在插件启动时自动运行：

| RuntimeState 状态 | 恢复处理 |
|---|---|
| `creating` | 超时（30min）→ 清理 worktrees → 标记 `failed` |
| `active` | Lead session 已死 → 标记 `orphaned`；Worker session 死亡 → 标记 `errored`；所有 worker 已死 → 标记 `orphaned`；回收 `.delivering-*` stranded 文件 |
| `deleting` | 清理 → 删除目录 |
| `deleted` / `failed` | 直接清理 |
| `shutdown_requested` / `orphaned` | 跳过（等待手动处理） |

---

## 8. Hook 系统

### team-mailbox-injector（Transform 阶段）

在每个 agent turn 前注入未读邮箱消息：

1. 调用 `poll.ts` → 构建所有未读消息的 `<peer_message>` 信封
2. 将信封注入到下次 `streamText` 调用的 `messages` 中
3. 记录 `pendingInjectedMessageIds` 到 RuntimeState（确保消息不会丢失）
4. 当 agent 处于 idle 状态时，触发 `ack` 确认消息已 读

```
<peer_message from="scout-1" to="lead" kind="result" summary="发现认证模式">
  探索完成，在 src/auth/ 目录下找到 JWT 认证模式...
</peer_message>
```

### team-tool-gating（Tool Guard 阶段）

基于角色控制工具权限：

**Lead-only 工具：**
- `team_shutdown_request`
- `team_delete`
- `team_approve_shutdown`
- `team_reject_shutdown`
- 广播消息（`to: "*"`）

**Member 限制：**
- 不能调用 `team_create`（禁止嵌套团队）
- `delegate-task` 在 member 内预算为零（禁止再委托）

### team-session-events

- `lead-orphan` — Lead session 死亡时的孤儿团队检测
- `member-error` — Member session 出错时的错误处理
- `idle-wake-hint` — Member 进入 idle 时自动 ack 消息并通知 Lead

---

## 9. 成员资格与角色

### Member 类型

```json
// 类型 1：Category Member — 通过 sisyphus-junior 路由到指定 category
{
  "kind": "category",
  "name": "scout-1",
  "category": "deep",
  "prompt": "在 src/ 目录探索认证模式"  // 必填
}

// 类型 2：SubagentType Member — 直接使用指定 agent 类型
{
  "kind": "subagent_type",
  "name": "analyst",
  "subagent_type": "sisyphus",
  "prompt": "分析项目的测试覆盖率"  // 可选
}
```

### Agent Eligibility

并非所有 agent 都能成为 team member：

| Eligibility | Agent 类型 |
|---|---|
| **Eligible** | `sisyphus`, `atlas`, `sisyphus-junior` |
| **Conditional** | `hephaestus`（需要额外 `teammate: "allow"` 权限） |
| **Hard-reject** | `oracle`, `librarian`, `explore`, `multimodal-looker`, `metis`, `momus`, `prometheus` |

Hard-reject 的原因：这些只读或 planner-only agent 无法写入 mailbox，不适合作为 team member。
Eligibility 在 TeamSpec 解析时验证——不合适的 agent 会在创建时就抛出具体错误，永远不会进入运行时。

### 协调模式

```
Lead (Sisyphus)                Member 1 (category: deep)      Member 2 (subagent_type: sisyphus)
     │                               │                               │
     │  team_task_create(task)        │                               │
     │───────────────────────────────>│                               │
     │  team_send_message("探索 X")    │                               │
     │───────────────────────────────>│                               │
     │                               │  team_task_update(claimed)    │
     │                               │──────────────────────────────>│  (锁机制)
     │                               │  team_send_message("发现 Y")  │
     │                               │──────────────────────────────>│
     │  team_send_message("请处理 Y")  │                               │
     │──────────────────────────────────────────────────────────────>│
     │                               │                               │ task completed
     │                               │  team_send_message("完成")     │
     │                               │───────────────────────────────│
     │  team_shutdown_request(member1)│                               │
     │───────────────────────────────>│                               │
     │   team_approve_shutdown        │                               │
     │───────────────────────────────>│                               │
```

### 成员行为约束

`member-guidance.ts` 自动注入到每个 member 的 prompt 中。关键约束包括：

- **必须用 `team_send_message` 通信**——纯文本对方看不见
- **不能调用 `terminal` 检查队友 session**——发消息即可
- **不能从 member 内调用 `delegate-task`**——预算为零
- **完成任务后必须**：发结果给 lead + 标记任务完成 + 发完成通知

---

## 10. 配置参考

### 启用方式

```jsonc
// ~/.config/opencode/oh-my-openagent.jsonc 或 .opencode/oh-my-openagent.jsonc
{
  "team_mode": {
    "enabled": true,
    "max_parallel_members": 4,
    "max_members": 8,
    "tmux_visualization": false
  }
}
```

### 定义团队规格

**文件路径：** `~/.omo/teams/{team-name}/config.json`（user 范围）或
`<project>/.omo/teams/{team-name}/config.json`（project 范围，优先级更高）

```json
{
  "name": "ccapi-explorers",
  "description": "并行探索 ccapi 项目结构",
  "lead": {
    "kind": "subagent_type",
    "subagent_type": "sisyphus"
  },
  "members": [
    {
      "kind": "category",
      "name": "scout-1",
      "category": "deep",
      "prompt": "在 src/ 目录探索认证模式"
    },
    {
      "kind": "subagent_type",
      "name": "analyst",
      "subagent_type": "sisyphus",
      "prompt": "分析项目的测试覆盖率"
    }
  ]
}
```

### 全量配置选项

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `false` | 总开关 |
| `tmux_visualization` | boolean | `false` | tmux pane 可视化 |
| `max_parallel_members` | number | `4` | 并行最大成员数 (1-8) |
| `max_members` | number | `8` | 团队人数上限 (1-8) |
| `max_messages_per_run` | number | `10000` | 每次运行消息上限 |
| `max_wall_clock_minutes` | number | `120` | 运行时限（分钟） |
| `max_member_turns` | number | `500` | 每成员 turn 上限 |
| `base_dir` | string? | `null` | 基础目录覆盖 |
| `message_payload_max_bytes` | number | `32768` | 单条消息大小上限 (≥1024) |
| `recipient_unread_max_bytes` | number | `262144` | 收件人未读上限 (≥1024) |
| `mailbox_poll_interval_ms` | number | `3000` | 轮询间隔 (≥500ms) |

---

## 11. 与单智能体模式对比

| 维度 | Single-Agent Mode | Team Mode |
|---|---|---|
| **智能体数量** | 1 个主 agent + 后台 sub-agent | 1 Lead + 最多 8 个并行 Member |
| **通信方式** | sub-agent 返回结果给主 agent（单向） | 双向 peer-to-peer mailbox 消息 |
| **任务协调** | 主 agent 自行分配 | 共享 `team_tasklist` + `team_send_message` |
| **会话管理** | 单个 session | 每个 member 独立 session，通过 `team-session-registry` 追踪 |
| **持久化** | 对话历史 | 文件系统持久化的 RuntimeState + mailbox + tasklist |
| **模型分配** | 主 agent 选一个模型 | 每个 member 可路由到不同 category/model |
| **可视化** | 无 | 可选 tmux pane 布局（`opencode attach`） |
| **并发控制** | 无（串行 turn） | 文件锁、原子写入、背压控制 |
| **恢复机制** | 无 | `resumeAllTeams()` 自动恢复/清理 |
| **工具系统** | 所有工具可用 | 新增 12 个 `team_*` 独占工具，`delegate-task` 被限制 |

### Hyperplan Skill

作为 Team Mode 的高级用例，v4.0 还引入了 **Hyperplan Skill**——一种结构化的多智能体规划模式：

- 5 个对抗性成员（Devil's Advocate、Risk Analyst、Feasibility Checker、Simplicity Auditor、Integration Validator）
- 3 轮交叉批评
- 最终由 Lead 综合输出最终计划

这不是 Team Mode 的必需组件，而是一个基于 Team Mode 能力构建的高级 skill。

---

## 12. 关键架构决策

### 12.1 文件系统即状态

所有状态（mailbox、tasks、runtime）存储在 `~/.omo/` 下，用原子文件操作确保一致性，
无需外部数据库。

**理由**：
- 无需额外基础设施（Redis、Postgres 等）
- 进程 crash 后状态不丢失
- 跨进程共享天然支持（文件系统是共享的）
- 调试直观——直接看文件即可理解状态

### 12.2 写时预预留（Write-Time Reservation）

解决 `promptAsync` 与 transform hook 之间的竞态条件（Oracle R21 修复）。

**问题**：当 Lead 发送消息时，如果收件人 session 正在处理 turn，
`promptAsync` 和 `mailbox-injector` transform hook 可能同时读取 inbox，
导致消息被重复注入或遗漏。

**解决方案**：消息先以 `.delivering-{uuid}.json` 写入（poll 不可见），
等 `promptAsync` 完成后再原子重命名为可见文件名。

### 12.3 2 阶段关闭

`shutdown_request → approve/reject` 模式防止 member 被意外终止。

**理由**：Member 可能正在执行关键操作（如文件写入、git commit），
直接杀死可能导致数据不一致。2 阶段关闭让 member 有机会优雅退出。

### 12.4 创建回滚

`createTeamRun()` 使用事务式工作流：任何步骤失败时自动清理已创建的资源。

**理由**：创建流程涉及多个步骤（创建 sessions、worktrees、tmux panes），
部分失败会留下孤立的资源。回滚确保团队创建是原子操作。

### 12.5 角色隔离

`team-tool-gating` hook 确保：
- Lead-only 工具不会被 member 调用
- `delegate-task` 在 member 内预算为零
- `team_create` 在 member 内被阻止（禁止嵌套团队）

**理由**：角色权限混乱会导致不可预测的行为和安全风险。
在 hook 层面强制执行比在每个工具中检查更可靠。

### 12.6 禁止嵌套团队

`team-tool-gating` 阻止 member 调用 `team_create`。

**理由**：嵌套团队会产生复杂的依赖关系和资源管理问题。
Lead 的 Lead 可能不知道中间层 Member 也在管理团队，
导致 shutdown 和资源清理变得不可预测。

### 12.7 Eligibility 在解析时拒绝

不合适的 agent 在 TeamSpec 解析时就抛出具体错误，永远不会进入运行时。

**理由**：快速失败优于运行时错误。只读 agent（如 oracle、librarian）无法写入 mailbox，
如果在运行时才发现会导致团队功能异常。

---

## 附：12 个 team_* 工具清单

| 工具 | 类别 | 权限 |
|---|---|---|
| `team_create` | 生命周期 | 任何 eligible agent |
| `team_delete` | 生命周期 | Lead-only（可 force） |
| `team_shutdown_request` | 生命周期 | Lead-only |
| `team_approve_shutdown` | 生命周期 | Lead 或目标 member |
| `team_reject_shutdown` | 生命周期 | Lead 或目标 member |
| `team_send_message` | 消息 | 任何 member（广播仅 lead） |
| `team_task_create` | 任务 | 任何 member |
| `team_task_list` | 任务 | 任何 member |
| `team_task_update` | 任务 | 任何 member |
| `team_task_get` | 任务 | 任何 member |
| `team_status` | 查询 | 任何 member |
| `team_list` | 查询 | 任何 member |