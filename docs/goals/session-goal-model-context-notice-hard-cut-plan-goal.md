# Session Goal Model-Context Notice Hard-Cut Plan Goal

本计划是 Session Goal 进入模型上下文的新唯一合同。它只重构 Goal 的模型传递方式，不改变 Goal 的用户所有权、状态机、预算、自动续跑和 Review Gate。

## Objective

彻底删除“每次模型调用都从实时 `Session.goal` 重建 Goal System Prompt”的动态注入。Goal 创建或发生语义变化时，持久化一条待投递通知；Runtime 在下一个安全模型边界将其一次性转成有时间顺序的内部 Session 消息。Agent 必须从消息历史看见 Goal 何时创建、如何修改和当前内容，不能在相邻模型调用之间收到一份被静默替换的 Prompt。

完成后：

- `Session.goal` 仍是 UI、SSE、预算、continuation 和 Review Gate 的权威状态。
- Goal objective、status、generation、identity、budget 和 blocked reason 不再动态进入 System Prompt 或 Current Context。
- Goal 创建、编辑、暂停、恢复、清除、预算变化、预算跨限、blocked 和 complete 均通过持久消息传递。
- 不新增 Goal Notification Service、消息队列、数据库、后台 worker 或第二套 Goal 状态机。

## Current Defect

`ConfiguredAgent` 当前在每个模型步骤调用 `resolveSystemPrompt()`，`buildPromptContract()` 又读取实时 `store.getState().goal`。如果用户在模型流或工具执行期间修改 Goal，下一次调用会直接看见新 Goal，但 canonical messages 中没有“Goal 从 generation N 变成 N+1”的事实。

`session.goal_changed` 只负责持久状态和 SSE 投影；现有 `auto_inject` Reminder 又是单次临时注入。两者都不是可重启、可压缩、可追溯的模型消息。

## Locked Architecture

```text
Goal control
  -> SessionGoalService
       -> one durable mutation
            1. update canonical Session.goal
            2. append session.goal_changed
            3. append pending model_context Goal reminder

next model attempt
  -> consumeSteers
  -> materialize phase 1
  -> beforeModelBuild / auto-compact
  -> materialize phase 2
  -> toModelMessages / beforeModelCall / tool resolution
  -> persist step-start
  -> runLlmStream
```

### Ownership

- `SessionGoalService` 是 Goal mutation、notice 构造和 materialization 的唯一领域 owner。HTTP、Tool、Query Loop 和 Hook 不拼装 Goal 通知。
- 复用现有 durable `Reminder` 作为 pending record，增加明确的 `delivery: "model_context"` 和 `source.type: "session_goal_changed"`。
- `SessionGoalService.materializeModelContextNotices()` 在一次 `commitDurableSessionMutation()` 中追加内部 Session message，并消费对应 Reminder。
- `ConfiguredAgent` 只向 Query Loop 注入薄的 `prepareModelContext` callback；Query Loop 在通用 best-effort Hooks 外 fail-closed 调用。
- 允许在既有 `packages/agent-core/src/session-goal/` 内增加纯 helper 文件；不增加新 Service 或运行时模块。

### GoalNotice contract

Protocol 增加严格 `GoalNoticePart`：

```ts
interface GoalNoticePart {
  type: "goal-notice";
  id: string;
  action:
    | "created"
    | "edited"
    | "paused"
    | "resumed"
    | "cleared"
    | "budget_updated"
    | "budget_limited"
    | "blocked"
    | "completed";
  authority: "user_control" | "agent" | "runtime";
  instanceId: string;
  previousGeneration?: number;
  generation: number;
  goal: {
    objective: string;
    status: SessionGoalStatus;
    tokenBudget?: number;
    blockedReason?: string;
  } | null;
  createdAt: number;
}
```

- `goal` 是 mutation 后的完整 actionable snapshot，但不复制 usage、execution counters、review evidence 或时间统计。
- `goal.blockedReason` 必须与 canonical Goal 一致：`blocked` 时必有，Goal 因预算限制进入 `budget_limited` 时按现有状态规则保留。Notice 不另设顶层 mutation reason，避免两份原因产生歧义。
- Protocol 增加共享 `SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH = 4_000`；Session Goal schema、Agent block Tool input 和 Notice schema 共同使用该上限。此项是当前 canonical Goal 合同的收紧，不做截断或兼容分支。
- `edited` 必须有 `previousGeneration`，且新 generation 精确加一；`cleared` 使用 `goal: null`，但保留被清除 Goal 的 identity 和 generation。
- Notice ID 从 Reminder identity 确定；重试不得生成第二个消息 ID。
- 消息使用内部 `role: "user"`，但没有 `clientRequestId`、`modelAudit` 或 fresh-user-input provenance，不能授权 Goal 操作、工具执行或任何用户专属能力。
- Model projection 确定性渲染 `<goal-notice>`；objective/blockedReason 必须安全编码，不能伪造闭合标签。
- Web 必须显式识别并隐藏该 part，不显示成用户气泡，也不新增 timeline UI。

### Notice production

| Mutation | 产生条件 | Action / 必须内容 |
|---|---|---|
| create | 总是 | `created`，generation 1，完整 snapshot |
| edit | 总是 | `edited`，previous/current generation，完整新 snapshot |
| pause / resume | status 真实变化 | `paused` / `resumed`，完整 snapshot |
| clear | Goal 存在 | `cleared`，`goal: null`，原 identity |
| setTokenBudget | budget 或派生 status 真实变化 | `budget_updated`，完整 snapshot |
| recordUsage | 首次跨限并变为 `budget_limited` | `budget_limited`，runtime authority |
| Agent block | 总是 | `blocked`，完整 snapshot（含 blockedReason） |
| Agent complete | 总是 | `completed`，完整 snapshot |

No-op pause/resume/budget 和不改变 status 的普通 usage 结算不得产生 notice。原始用户消息和 Tool input 继续作为审计历史；`create_goal` result 收敛为简洁 receipt，不再承担长期 Goal 传递。

### Delivery, ordering and compaction

- Goal mutation、`session.goal_changed` 和 pending Reminder 必须由同一次 durable mutation 产生，并在持久化成功后发布。
- 每次模型尝试固定执行 `consumeSteers -> phase 1 -> hooks/auto-compact -> phase 2 -> toModelMessages`。两个 phase 调用同一幂等方法，均位于会吞掉非 Abort 错误的通用 `runHooks()` 之外。
- 每个 phase 按 `state.reminders` durable append position 声明 high-water mark，只处理该位置及之前的 pending Goal reminders。之后到达的 mutation 属于下一 phase 或下一模型调用，不等待“队列绝对为空”。
- Materialization 严格保留 Reminder append order。`createdAt` 和随机 ID 不参与因果排序。
- 追加 GoalNotice message 与消费 Reminder 是一次 durable mutation。成功后重试不会重复；失败时本轮 LLM 不得启动。
- `step-start` 只能在两个 phase、model projection、`beforeModelCall` 和 tool resolution 全部成功后持久化，并紧邻 `runLlmStream`；准备失败不得留下虚假或未闭合 Step。
- Goal 在流式输出或工具批次期间变化时不打断当前 effect，也不插入 assistant tool-call/result pair；下一模型边界再物化。
- Hard compact 和 DCP 若覆盖最新 notice，model projection 必须从持久消息确定性 carry-forward 最新完整 GoalNotice。未被覆盖时不得重复，且绝不能回读 `Session.goal` 动态补注入。

### Persistence boundary

- Materialization 写入失败必须 fail-closed：当前 model attempt 明确失败，`runLlmStream=0`，Reminder 以最后成功落盘状态保留。
- 本计划不实现磁盘故障下的同进程热恢复，不扩展 Store rollback/transaction、Agent cache eviction、BackgroundTask quiescence、Steer recovery 或 Queue eligibility。
- 操作者恢复存储后重启 Runtime，复用现有 restart repair、orphaned Steer recovery 和 continuation 流程。此处是明确的故障边界，不是兼容 fallback。

### Current-contract invariant and hard cut

Goal notice/reminder 只允许存在于 Root Lead Session。其完整链必须满足：

```text
never-goal Session:
  goal absent AND no Goal notice/reminder

Goal history exists:
  every consumed reminder <-> one exact internal GoalNotice message
  every pending reminder has no message
  materialized messages preserve reminder append order
  latest pending/materialized proof equals canonical goal snapshot
  OR, when canonical goal is absent, latest proof is cleared/null
```

- Session strict load、Goal mutation 和 materialization 都必须验证该 invariant；半物化状态直接 `CONTRACT_VIOLATION`，不得补写或修复。
- 现有“有 Goal、但没有 matching pending/materialized notice”的 Session 属于无效 current-contract state，必须以 actionable error 拒绝加载。
- 不迁移、不回填、不清空旧 Goal，不临时调用 `get_goal` 掩盖缺失链路，也不保留动态 Prompt fallback。
- 测试验证的是上述正向 invariant，不建立 legacy fixture、旧格式 parser 或“旧行为被拒绝”的墓碑测试。

### Prompt hard cut

- 删除 `PromptContractCompiler` 的 Session Goal section 和 `renderSessionGoal()`。
- `renderRuntime()` 不再输出 Goal identity/status/generation；`buildLifecycleCurrentContext()` 不再输出任何 `goal*` 字段。
- `RuntimePromptEnvelope.goal` 若只为 Prompt legal-mode 存在则直接删除；legal-mode 判断留在 Runtime/role validation。
- 保留 `run-goal` Skill 和 `get_goal`：Skill 从最新 GoalNotice 获取工作目标；`get_goal` 仅查询 usage、execution/budget 统计等 notice 未承载的数据，不得成为 objective/status/blockedReason 缺失时的 fallback。
- 删除旧 overlay 实现、测试、文档、feature flag、双写和兼容 wrapper。

## Implementation Plan

1. **Protocol**：增加 `GoalNoticePart`、model-context Reminder delivery/source、strict schema/guards/serialization 和所有 exhaustive switches。
2. **Goal domain**：集中 notice builder；让所有语义 mutation 原子产生 canonical Goal、SSE event 和 pending Reminder，并验证 current-contract invariant。
3. **Materialization**：实现按 append order/high-water 的幂等 durable materialization；稳定 ID，一次写入 message + consumed state。
4. **Query boundary**：接入 pre/post compact 两个 fail-closed phase；把 `step-start` 移到所有关键准备成功之后。
5. **Projection and hard cut**：删除动态 Goal Prompt；实现安全 model projection、hard compact/DCP carry-forward，以及 Web/background/full-history 的显式分支。
6. **Tool, Skill and docs**：收敛 `create_goal` receipt，更新 `run-goal`、AGENTS.md 和活跃架构文档。
7. **Verification**：完成定向测试、全仓验证、遗留搜索和独立 review；发现 blocking/high 必须 fix 后重新 review。

## Non-goals

- 不改变 Goal 授权、状态转换、预算算法、自动 continuation、Reviewer binding 或完成门禁。
- 不新增 Goal history 资源、Event Sourcing、ControlMessage 总线、通知中心或 Goal timeline UI。
- 不实现持久化故障的同进程热恢复。
- 不迁移、识别或兼容旧 Goal 上下文格式，不增加墓碑测试。

## Acceptance Criteria

以下 AC 必须全部有机械证据，缺一即 `NOT_DONE`。

### AC-01：动态 Goal Prompt 完全删除

- 用唯一 sentinel objective、identity、generation、budget 和 blockedReason 编译 Root Lead Prompt，结果与 trace 均不含这些值，也不存在旧 Session Goal section 或 `goal*` Current Context 字段。
- 两次模型调用之间 edit Goal，第二次 System Prompt 不因 Goal mutation 改变；model messages 出现对应 GoalNotice。
- 精确搜索不存在旧 overlay producer/consumer/test/doc、feature flag、双注入或 fallback；`run-goal` 和 `get_goal` 仍可用。

### AC-02：每种语义变化产生唯一完整通知

- Notice production 表中的每种变化各产生一条且只产生一条 pending Reminder；no-op 和普通 usage 增量不产生。
- Edit 的 generation、Clear 的 identity、budget crossing 的 runtime authority、Block 的逐字完整 blockedReason 均与 canonical Goal 一致。
- 被 block 后降低预算或 recordUsage 跨限进入 `budget_limited`，最新 `budget_updated`/`budget_limited` notice 必须继续携带原 blockedReason，并满足 current-contract invariant。
- objective/blockedReason 含 XML closing tag、Markdown、换行和各自最大合法长度时，projection 边界仍安全且内容逐字可恢复；超过 `SESSION_GOAL_BLOCKED_REASON_MAX_LENGTH` 必须在 Goal 领域入口被拒绝，不能截断。

### AC-03：投递、顺序和失败语义确定

- Materialization 一次 durable mutation写入 message 并消费 Reminder；重复/并发调用和成功后重启均不重复。
- 相同 `createdAt`、逆序随机 ID 的多条 mutation 仍严格按 Reminder append order 投递。
- streaming、串行/并行 tool batch 中修改 Goal，不破坏 tool-call/result pair；notice 位于完整 pair 后和下一 assistant output 前。
- Phase 1 后用 barrier 阻塞 auto-compact，再修改 Goal；phase 2 必须在当前 `toModelMessages()` 前物化。Phase 2 high-water 后的修改只在下一模型边界出现一次。
- 强制 materialization 写失败，`runLlmStream=0`，磁盘上 Reminder 仍 pending、notice 不存在，且没有该失败 attempt 的 `step-start`、未闭合 Step 或 step 统计增量。Runtime restart 后按现有恢复路径投递一次。

### AC-04：压缩后仍保留当前 Goal

- Hard compact summarizer 故意遗漏/篡改 objective 或 blocked reason 后，projection 仍从持久消息 carry-forward 最新 notice 的逐字内容。
- DCP 覆盖最新 notice 时同样 carry-forward；未覆盖时不重复。
- Carry-forward 只读持久消息；spy/architecture test 证明 projection 不读取 `Session.goal`。

### AC-05：权限、UI 和 current-contract invariant

- GoalNotice 没有 fresh-user-input provenance，不能授权 Goal mutation、工具或用户专属操作，不进入用户消息统计、title/memory 用户语义。
- Web live/reload 不显示用户气泡；现有 Goal row、Sidebar/Dashboard 和 SSE 继续显示 canonical Goal。
- create/mutate/materialize/load 的正向测试证明 never-goal 无链、当前 Goal/clear 均有 latest proof、consumed Reminder 与内部消息一一对应且顺序一致。
- 构造 pending+message、consumed-without-message、message-without-reminder、非 Root Lead notice、空 Goal 但 latest proof 非 clear 等半状态，strict validation 返回 actionable error；生产代码不存在修复、迁移、回填、清空或 `get_goal` fallback。

### AC-06：仓库验证和最终审查

- 定向测试覆盖 Protocol、Session strict schema、Goal service、双 phase/high-water、Query Loop step boundary、Prompt compiler、tool ordering、restart、hard compact/DCP 和 Web traversal。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 新鲜 direct deep Analyst 对最终 Diff 做只读审查；只有无 blocking/high 的 `VERDICT: APPROVED` 才完成，修改后必须重新审查。
