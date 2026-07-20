# Agent-Owned Goal And Delegation Hard-Cut Plan Goal

本文件是本轮重构的唯一实施与验收契约。目标是让 Agent 控制 Goal 的工作流程，让 Goal 只保存状态，并让所有子 Agent 以普通最终回复交付结果。旧协议直接删除，不迁移、不兼容、不保留 fallback。

## Objective

完成两项全局硬切：

1. 删除 `submit_child_result`、`ChildResult`、receipt 和结构化纠错协议；所有子 Agent 正常结束并由 `delegate` / `background_output` 返回最终 assistant 文本。
2. 删除 Goal 的 Evaluator、Review Gate、Review/Remediation 状态机和 source monitor；Engineer 负责发起 Reviewer、读取报告、修复并完成 Goal，后端只持久化 Goal 状态、执行通用 Session 调度和校验 mandatory Review。

## Locked Architecture

```text
active Goal
  -> Engineer works
  -> Engineer delegates Reviewer
  -> Reviewer returns a normal final message
       VERDICT: CHANGES_REQUESTED -> Engineer fixes and reviews again
       VERDICT: APPROVED          -> Engineer calls update_goal(complete)
  -> Goal becomes complete
```

- Agent 决定工作、委派、Review、修复和完成；后端不自动判断完成、不创建 Reviewer、不启动 remediation。
- Goal 是根 Engineer Session 上的可选持久字段，不是 workflow engine。
- active Goal 的根 Session family 空闲且可运行时，后端只负责再次运行同一 Engineer；该触发器无领域状态、无模型 Evaluator、无独立调度器。
- mandatory Review 是 `update_goal(status=complete)` 的前置校验，不是 Goal 子状态。

## Target Contracts

### Delegation

`delegate` 硬切为严格 `DelegationRequest`：

```ts
interface DelegationRequest {
  agent_type: "plan" | "build" | "reviewer" | "explore" | "librarian";
  title: string;
  objective: string;
  owned_scope: ScopeRef[];
  skills: string[];
  background: boolean;
}
```

- Build 必须有非空 `owned_scope`；其他 Agent 必须传空数组。
- 删除 `non_goals`、`acceptance_criteria`、`evidence`、`verification`、`depends_on` 和 contract hash。需要表达的业务要求直接写入 `objective`；并发写安全只由 `owned_scope` 和现有 Build ownership lease 强制。
- `resume_session` 只追加 instruction，不改变 Agent 身份、Skills 或 owned scope。
- `background=false` 返回 Session ID、Execution 状态和最终 assistant 文本；`background=true` 返回 Session ID，终态 reminder 后由 `background_output` 返回同一最终文本。
- `resume_session` 的 strict input 固定为 `{ session_id, instruction, background }`，三个字段全部必填；删除 `new_evidence` 及其全部 schema、runtime、Prompt 和 Web 路径。
- `finalOutputForExecution(state, executionId)` 是同步 delegate、`background_output` 和 Goal completion 共用的唯一终态文本读取规则：只读取 `executionId` 匹配当前 Execution 的最后一条 assistant message，并拼接该 message 的 text parts；该 Execution 没有文本就返回空字符串，绝不回退其他 Execution。
- 只有 `completed` 暴露 canonical final output。`max_steps|failed -> failed`、`aborted|cancelled -> cancelled`、`timed_out -> timed_out`、`interrupted -> interrupted` 保持现有 child-link 映射且不附带 final output；`waiting_for_human` 保持非终态。running/waiting 的 `background_output` 可显示明确标注为非最终的 live snapshot。
- 子 Agent 的普通最终文本是唯一交付结果；completed 空文本仍是合法输出，父 Agent 自行判断其是否有用。非完成状态只返回状态/错误，不伪造最终结果。

### Reviewer

Reviewer 使用普通最终回复，第一条非空行必须严格为以下之一：

```text
VERDICT: APPROVED
VERDICT: CHANGES_REQUESTED
```

其余内容是自由 Markdown 审核报告。格式缺失或错误不自动转换、不自动重试；Engineer 可 `resume_session` 要求同一 Reviewer 澄清。

### Goal

```ts
interface SessionGoal {
  instanceId: string;
  generation: number;
  objective: string;
  status: "active" | "paused" | "blocked" | "budget_limited" | "complete";
  tokenBudget?: number;
  usage: SessionGoalUsage;
  blockedReason?: string;
  createdAt: number;
  activatedAt: number;
  updatedAt: number;
  pausedAt?: number;
  completedAt?: number;
}
```

- 删除 evaluator、progress counters、retry fields、input/source epochs、review claim/receipt/attempt/phase 和 remediation 字段。
- `update_goal({ status: "complete", reason, review_session_id })` 仅在以下条件全部满足时写入 `complete`：调用者是当前 root Engineer；目标 Session 是其 direct Reviewer child；Reviewer 最新 Execution 为 `completed`；`finalOutputForExecution` 返回文本的第一条非空行严格等于 `VERDICT: APPROVED`。
- `review_session_id` 不写入 Goal，不生成 receipt。Review 与报告已由 Session parent-child 关系和消息持久化。
- `CHANGES_REQUESTED`、格式错误、running/failed Reviewer、非 Reviewer、间接 child、其他 root 的 child 或不存在的 Session 均确定性拒绝完成。
- `update_goal({ status: "blocked", reason })` 由 root Engineer 一次调用直接执行 `active -> blocked`；真实 blocker 是 Agent 行为契约，不保存三轮计数或其他证明状态。
- Engineer 在 APPROVED 后修改工作结果必须重新 Review；这是 Agent 行为契约，本轮不增加 filesystem watcher、fingerprint、mutation epoch 或隐藏 Review 状态。

### Continuation

- root Engineer Execution 以 `completed` 或 `max_steps` 结束，而 Goal 仍为 `active` 时：family 无运行 child、无 unresolved HITL/tool batch、无 queued user input 且预算允许，启动同一 root Engineer 的下一次 Execution。
- Reviewer 或其他 child 到达任一终态后，若 family 满足上述条件，恢复 Engineer，由 Engineer 读取 terminal reminder / `background_output` 并决定下一步。
- `paused | blocked | budget_limited | complete` 不自动续跑。root Execution 的 `failed | timed_out | aborted | cancelled` 不做 Goal 专属重试；保留原终态等待用户恢复。
- server 启动是显式恢复边界：无论重启前最后一个 root Execution 为何，只对满足 `active + idle + 无 HITL/tool batch/queue + 预算允许` 的 Goal 恢复一次；其他状态不恢复。不得建立第二套 scheduler、retry state 或定时轮询。

## Implementation Plan

1. **Protocol hard cut**：将 `DelegationContract` 收敛为 `DelegationRequest`；删除 ChildResult/Receipt、child-result event、Goal Review/Evaluator 类型和旧 strict-schema 字段。
2. **Generic child completion**：删除 `submit_child_result`、structured-result-correction 和 completion receipt guard；实现按 Execution 读取 final output 的唯一 helper，让同步 delegate、terminal reminder 与 `background_output` 使用同一结果来源和完整终态映射。
3. **Delegation/store cleanup**：删除 contract hash、result receipts、dependency receipt admission、`resume_session.new_evidence` 和相关 store/server/web projection；保留 parent-child identity、depth/target/Skill admission 与 Build owned-scope lease。
4. **Goal simplification**：删除 `review-gate.ts`、`review-source-monitor.ts`、`evaluator.ts` 和现有 Coordinator；将 `SessionGoalService` 收敛为 create/edit/pause/resume/clear/budget/usage/block/complete 的唯一状态 owner。
5. **Agent-owned review and continuation**：更新 Prompt compiler、Engineer 及全部五类 delegated role contracts/definitions/model-visible snapshots；实现 `review_session_id` 完成校验；在既有 Session family idle/terminal 边界接入无状态 active-Goal continuation，不引入新 workflow service。
6. **Surfaces and validation**：清理 Dashboard、Goal progress row、tool formatting、Prompt snapshots 和旧测试；重写子 Agent 普通输出、mandatory Review、Goal continuation/restart 的单元与集成测试，并完成全仓审计。

## Non-goals

- 不修改普通 Session、HITL、Automation、Project Todo、模型配置、权限语义或 Build ownership 的产品行为。
- 不引入新的 workflow engine、Review service、通用 result parser 层、事件总线、文件 watcher、兼容 schema、数据迁移、feature flag 或双写；verdict 首行判断保留为 Goal completion 内的局部机械校验。
- 不自动删除现有持久化 Session。旧 Session 因包含已删除字段或缺少新 strict schema 所需字段而加载失败是预期硬切行为。

## Acceptance Criteria

以下 AC-01 至 AC-07 必须全部满足；任一项缺少代码、测试或搜索/命令证据即为 `NOT_DONE`。

### AC-01：子 Agent 只有普通终态输出

- 所有五类 delegated Agent 无需提交工具即可以 `completed` 结束；同步 delegate 返回最终 assistant 文本，后台 child 的 terminal reminder + `background_output` 返回同一文本。
- completed 正常/空文本、max_steps、failed、aborted、cancelled、timed_out、interrupted、waiting_for_human 和 resumed child 均有测试；只有 completed 提供 canonical final output，waiting_for_human 不产生 terminal reminder，Execution 状态不得被文本覆盖。
- 测试证明 `finalOutputForExecution` 只读取匹配 Execution 的最后一条 assistant message：旧 Execution 为 APPROVED 而最新 Execution 为空、格式错误或 CHANGES_REQUESTED 时，delegate/background_output/completion 均不得回退旧文本。
- 生产源码和模型可见工具中不存在 `submit_child_result`、`ChildResult`、`ChildResultReceipt`、`childResultReceipts`、`child-result`、`structuredResultCorrection` 或等价 receipt/fallback 路径。

### AC-02：委派协议完成全局硬切

- `delegate` 只接受 Target Contracts 中六个字段；任一旧字段都被 strict schema 拒绝，不存在 alias、默认补全、union 或兼容解析。
- `resume_session` 只接受必填 `{ session_id, instruction, background }`；`new_evidence` 被 strict schema 拒绝，源码不存在 `newEvidence` 拼接或兼容路径。
- Build 空 owned scope、越界 scope、重叠 active Build scope、非法 target/depth/Skill 均在 child 启动前拒绝；普通合法委派、后台委派和 resume 成功。
- 持久化 Session、API/DTO、Web tool rendering 和 Prompt 只使用 `DelegationRequest`，不存在 contract hash 或 dependency receipt。

### AC-03：Goal 只保存目标与状态

- 持久化 `SessionGoal` 精确符合 Target Contracts；strict schema 拒绝所有旧 review/evaluator/remediation/source/retry 字段，不迁移、不忽略未知字段。
- Goal service 只提供 create/edit/pause/resume/clear/budget/usage/block/complete；生产代码不存在 Review、Evaluator、Remediation transition。
- root Engineer 一次合法 blocked 调用直接将 active Goal 写为 blocked；不存在 blockerCandidate、consecutiveTurns 或三轮 runtime 门禁。
- Goal UI 与 Dashboard 只从 objective、status、usage、budget、blockedReason 和时间字段投影，不读取旧审核或 Evaluator 理由。

### AC-04：mandatory Review 无法绕过

- 没有 `review_session_id`、非 direct Reviewer、running/非 completed Reviewer、`CHANGES_REQUESTED`、格式错误、其他 root child 和不存在的 Session 全部拒绝 `complete`。
- direct Reviewer 最新 Execution completed 且该 Execution 的 canonical final output 首个非空行严格为 `VERDICT: APPROVED` 时，Engineer 的同一次 `update_goal` 原子写入 `status=complete` 与 `completedAt`。
- 旧 Execution 为 APPROVED、最新 Execution 为空/格式错误/CHANGES_REQUESTED 的三种场景均拒绝 complete，不允许跨 Execution 文本回退。
- Reviewer 结果只存在于普通 Session 消息；Goal、Session 和 event 中不存在 Review receipt、claim、attempt、hash 或复制结果。

### AC-05：Engineer 控制完整 Goal 流程

- Engineer Prompt 明确要求“工作完成 -> delegate Reviewer -> 读取结果 -> 修复或 complete”；Reviewer Prompt 明确唯一 verdict 格式，且 Reviewer 无 Goal 状态修改能力。
- `CHANGES_REQUESTED` 后 Goal 保持 active，系统不自动创建 remediation Execution 或新 Reviewer；Engineer 下一次运行读取报告并自行决定修复与再次 Review。
- 不存在 Runtime-created Goal Reviewer、Goal review mode、Goal-specific tool projection 或 Reviewer 特殊 Session provenance。

### AC-06：active Goal 只由无状态条件续跑

- root `completed|max_steps`、任意 child 终态和 server startup 三个触发点都使用同一 continuation predicate；startup 明确忽略上次 root 终态并按当前 active 状态恢复，并发触发最多启动一个下一 Execution。
- active + idle + 无 HITL/tool batch/queue + 预算允许时续跑；五个反向条件逐一有测试。queued user input 必须先于 autonomous continuation 被消费。
- paused、blocked、budget_limited、complete 及 root failed/timed_out/aborted/cancelled 不自动续跑；生产代码不存在 Goal Evaluator、candidate_complete、Goal retry counter/timer 或第二套 scheduler。

### AC-07：硬切审计与全量验证通过

- 删除旧专用实现及其旧语义测试；新测试直接覆盖目标行为，不同时接受新旧两套结果。
- 下列命令全部退出码为 0：`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check`。
- 对 `apps/*/src`、`packages/*/src`（排除 `*.test.*`）和 `AGENTS.md` 的搜索证明以下生产词或等价旧路径为零：`submit_child_result`、`ChildResult`、`ChildResultReceipt`、`childResultReceipts`、`child-result`、`structuredResultCorrection`、`DelegationContract`、`new_evidence`、`newEvidence`、`SessionGoalReview`、`GoalReviewGate`、`goal_review`、`goal_remediation`、`review_running`、`remediation_required`、`remediation_running`、`candidate_complete`、`lastReviewReceipt`、`review-source-monitor`。测试可仅为 strict rejection 断言引用旧输入；历史 `docs/goals/*` 和本验收文件不计为生产残留。
- `AGENTS.md` 和当前模型可见 Prompt/Tool 文案与新架构一致；不存在任何 delegated role 仍要求 structured result 或 receipt。
- 人工验收一个完整任务：Engineer 工作 -> 后台 Reviewer 返回 CHANGES_REQUESTED -> Engineer 修复并再次 Review -> Reviewer 返回 APPROVED -> Engineer 完成 Goal；刷新页面后 Goal 保持 complete，浏览器 console 无错误。

## Completion Rule

只有 AC-01 至 AC-07 全部有可复查证据，且独立 Reviewer 对本计划约束的实现给出 `APPROVED`，本重构才算完成。
