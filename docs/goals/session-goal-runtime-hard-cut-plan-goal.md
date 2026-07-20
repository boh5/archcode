# Session Goal Runtime Hard-Cut Plan Goal

本计划是 Goal 重构的唯一实施与验收契约，并取代 `conversation-driven-goal-automation-creation-goal.md` 中 Goal Create Skill、独立 Goal 资源和 Goal Lead 的既有结论；该旧文档的 Automation 结论不受影响。

## Objective

将 Goal 从独立产品资源彻底重构为普通根 Engineer Session 上的可选持久执行协议：Engineer 从自然语言识别持续完成意图并即时激活，Runtime 在每轮结束后自动续跑，只有独立 Reviewer 对当前目标和当前工作结果验收通过后才能完成。删除 Goal 创建仪式、Goal Lead、独立 Goal 状态机与 UI，不保留旧路径、fallback、双写或 Goal 数据兼容。

## Locked Architecture

```text
User conversation
  -> root Engineer Session + optional SessionGoal
  -> Engineer / Plan / Build / Explore / Librarian
  -> family idle -> tool-less Goal Evaluator
       -> continue -> same Engineer Session next Execution
       -> candidate complete -> runtime-launched Reviewer
            -> rejected -> same Engineer Session continues
            -> accepted -> Runtime commits complete
```

- Goal 是根 Engineer Session 的字段，不再有独立 Goal ID、目录、Route、详情页、Goal Lead Session、Worktree 或 HITL owner。
- 每个根 Session 同时最多一个当前 Goal；新 Goal 只能替换 `complete` 的旧 Goal。开始、修改、审核、完成和清除写入 Session timeline，另建 Goal history/revision 资源不在本轮范围。
- Goal 的唯一用户契约是一段 trim 后 1–4,000 字符的 `objective`，其中应同时包含 outcome、constraints 和 verification；不保留独立 `acceptanceCriteria`、来源账本或修订历史。创建时 Runtime 直接以触发本次 model boundary 的 fresh 用户原话作为 objective，模型不能重写；自然语言编辑只有机械追加 amendment 或以 fresh 用户原话完整 replace 两种语义。Engineer 可提出细分 criteria，但 Review Gate 必须始终保留覆盖完整 objective 的 Runtime criterion，细分结果不能删除或改写原文要求。
- `SessionGoal` 严格包含：内部 `instanceId`、从 1 开始且编辑时递增的 `generation`、`objective`、`status`、可选正整数 token budget、整棵 Session family 的累计用量/Execution 时间、Evaluator 计数与最近理由、no-progress 计数、当前 review claim/receipt/next-action、时间戳。未设置 token budget 表示没有 token hard cap；状态只有 `active | paused | blocked | budget_limited | complete`；HITL 和 reviewing 是派生运行态，clear 表示字段不存在。
- Goal 激活不创建或切换 Worktree；它继承当前 Session 的 `cwd`。并行写任务通过不同根 Session/Worktree 隔离，不由 Goal 再拥有一套 Worktree。
- `SessionGoalService` 是状态变更唯一 owner；Tool、HTTP、Evaluator、Reviewer 和恢复逻辑都调用它，不直接写 Session JSON。Session store/SSE 继续是持久化与可见事件边界。

## Conversational Control Contract

- 只有根 Engineer 在当前 model boundary 收到尚未消费的 direct、queue 或 steer 用户消息时可以创建 Goal 或修改 objective。Runtime 为这些 canonical message IDs 铸造一次性 `fresh-user-input` capability，并在 ToolExecutionContext 中消费；模型不能填写 provenance，旧 continuation、重复 Tool call 或只含 automation input 的边界没有该能力。
- 同时满足“执行型请求、预计需要多轮或委派、具有可验证终点、用户语义明确要求推进到结果”时，Engineer 直接激活并告知用户，不再加载 Skill 或二次确认。
- 简单一次性修改、问答、状态查询、诊断或只要求一次调研汇报的请求不自动激活；缺少可验证终点时先在普通对话中澄清。不得仅因 Prompt 很长或任务看起来复杂就激活。
- `create_goal`、`get_goal`、`update_goal` 是唯一模型工具。`create_goal` 不接收模型生成的 objective，只可带用户明确要求的 token budget；`update_goal.edit` 必须选择 `amend | replace`，前者把 fresh 原话机械追加到单一 objective 并声明后文只覆盖直接冲突，后者以 fresh 原话完整替换。所有用户控制动作（edit/pause/resume/clear/budget）必须消费上述 fresh-user-input capability；Agent 自主动作只允许提交 `complete` claim 或在同一阻塞原因连续三轮成立后提交 `blocked`。Edit 只允许 non-terminal Goal；complete 后的新工作创建新 `instanceId`。
- `complete` 只是申请验收，不能写 `status=complete`；只有 Review Gate 可以完成。Goal 模式不扩大 sandbox、权限或 HITL policy。
- UI 与 HTTP 是独立用户控制面，直接调用同一个 `SessionGoalService` 实现 Edit/Pause/Resume/Clear，不伪装成 Engineer Tool 权限。Pause 只阻止下一轮；Stop 在 active Goal 中同时 abort 当前 Execution 并持久化 Pause，避免立即自动重启。Clear 取消/失效当前 review claim、停止未来续跑但保留 Session、消息和工作区修改。

## Continuation And Review Contract

- 根 Session family 变为 idle 后，顺序固定为：先 reconcile 已回答或可继续的 durable Tool Batch；仍有 unresolved HITL/active Tool Batch 或 control blocker 时等待；随后派发 queued user messages；再消费持久 Goal next-action；只有不存在 requested review 或 required remediation 时才运行 Evaluator。Stop 必须先取消当前 batch/HITL，再允许后续 Queue。
- `SessionGoalEvaluator` 使用现有 Reviewer 模型绑定执行一次 `runLlmObject`，无工具、短结构化输出，只返回 `continue | candidate_complete` 和理由；它是内部服务，不是 Agent、Session 或可配置角色。
- `continue` 将理由作为下一次 Goal continuation 输入，在同一根 Engineer Session 创建唯一新 Execution；Evaluator 判断完成或 Engineer 提交 complete claim 都持久化 `review.phase=requested`，其优先级高于下一次 Evaluator。
- `GoalReviewGate` 必须在所有写入子 Session idle 后，通过受限的 `SessionExecutionManager.startRuntimeReviewChild()` 启动一个全新 Reviewer child。该入口复用 child admission、DelegationContract 和 canonical receipt 内核，但 child provenance 是严格 union：普通 `delegate(toolCallId)` 或 Runtime-only `goal_review(reviewClaimId)`；不得伪造已不存在的 delegate Tool Call，也不得允许非 Reviewer 或失效 claim 使用该入口。
- Review Gate 而非 Engineer 构造并持有不可变 Review DelegationContract：必须包含一个 Runtime criterion，要求完整原始 objective 的每项 outcome/constraint/verification 均满足且无遗漏；Engineer 提出的细项只可追加。Review claim 绑定该 contract hash。
- Goal completion Reviewer 使用 source-immutable 的受限 Tool projection：保留源码读取、Diff/LSP 和必要的 guarded Bash 验证，删除 Todo、Goal transition 及其他非验收工具。Reviewer 只通过 canonical `submit_child_result` 交付；所有 Runtime/追加 criterion 都 passed、必需 verification 均通过、无 blocking unresolved 且有可定位 evidence 时才接受。
- Review next-action phase 严格为 `requested | review_running | remediation_required | remediation_running`。requested 只启动一次 Reviewer；rejected 原子写 `remediation_required + reason`；该 phase 只启动一次同一根 Engineer remediation Execution 并记录 executionId；remediation 终态后清除 next-action，之后才允许 Evaluator。启动与 phase/executionId claim 必须可崩溃恢复，不能重复启动。
- Review claim/receipt 绑定 `instanceId + generation + reviewContractHash + userInputCursor + root family sourceMutationEpoch + source fingerprint`。`sourceMutationEpoch` 只由可能改变受审 workspace/source 的 ArchCode file/edit/command effect 增加；Goal 状态、usage、timeline、Evaluator bookkeeping、review claim 和 `submit_child_result` receipt 等控制面持久化不得增加。direct/queue/steer 用户输入通过独立 `userInputCursor` fence 失效 Review。
- Git fingerprint 覆盖 HEAD/index/非忽略工作区内容；非 Git 使用现有 workspace ignore 规则对 cwd 下非忽略文件做内容 hash。验证命令产生的 ignored cache 不改变 fingerprint，Reviewer Bash 或任何其他路径修改受审源码则本次审核失败。Goal 编辑、userInputCursor/sourceMutationEpoch/fingerprint/generation 任一不匹配都会使旧 Review 失效。
- Review accepted 时只有 Runtime 原子写入 complete。Reviewer execution interrupted/crashed 后保留同一 immutable claim/basis，废弃旧 Reviewer child/attempt 并原子递增 attempt，为该 claim 创建且只创建一个全新 Reviewer child Execution；receipt 必须匹配当前 attempt，所有旧或迟到 receipt 永久拒绝。
- 服务启动扫描含 active Goal 的根 Engineer Session；在 family idle、无 HITL/Queue/限制时恢复一次 continuation。Execution failed/timed_out 使用有界退避；连续三次 Evaluator 判定没有进展即转 blocked，理由措辞变化不得重置计数，禁止无限空转。

## Agent And Ownership Hard Cut

- 删除 `goal-create` Skill、保留名、manifest/Engineer allowlist、Sidebar/Todo `/skill use goal-create` 入口；原子 Tool 重写为上述三个 Session Goal 工具。
- 删除 `goal_lead` Agent definition、RoleContract、模型配置、Prompt、颜色/UI、Session 创建、continuation 和 phase policy。正式 Agent 固定为 Engineer、Plan、Build、Reviewer、Explore、Librarian、Shaper 七个。
- Goal Lead 中有价值的分解、非重叠委派、证据聚合和申请 Review 行为进入 Engineer 的 active-Goal Prompt overlay；Engineer 仍可直接完成关键路径，不强制所有写入经过 Build。
- Plan、Build、Explore、Librarian 继续是通用专家；移除 `parent=goal_lead`、Goal phase 和 Goal ID 特判，当前 objective/criteria 只通过普通 DelegationContract 传播。
- Reviewer 保留正式 Agent 和 source-immutable 验证能力；删除 `goal_manage.finalize_review` 与 Reviewer 的 Goal 生命周期权限。`goal_manage` 的 begin/finalize/retry/cancel 全部删除，分别由 continuation、Review Gate 和用户控制面接管。
- Worktree/cwd、HITL、权限、Queue/Steer、child tree 和预算归根 Session。`HitlOwner` 硬切为 session-only；Goal budget HITL 改为 session-owned source。Token/time 统计覆盖该 root family，维护型后台调用按现有规则排除。
- Project Todo 删除 `activation.kind=goal` 和 Goal resource ID；Ready Todo 只启动普通 Engineer Session 并发送其不可变 snapshot，Engineer 按同一对话策略决定是否激活 Session Goal。Automation 不新增 Goal action。

## Product Surface Hard Cut

- 删除 Goal list/detail/Inspector、`/projects/:slug/goals*` API/Route、Sidebar Goals tab、Goal query/mutation 和 Goal resource events。
- Session API/DTO/Summary 直接投影可见的 SessionGoal 状态；Project Dashboard 通过 Session 查询聚合 active/paused/blocked/budget-limited Goal，不建立第二份索引或资源 store。
- Session composer 上方增加紧凑 Goal progress row：objective、状态、turn/token/time、最近 Evaluator/Reviewer 理由，以及 Edit/Pause/Resume/Clear。Session list 显示 Goal 状态徽标；HITL 卡始终跳回所属 Session。
- 对话激活、自然语言修改、Pause/Resume、Reviewer rejected 后继续、Review passed、HITL 等待/回答、预算受限和重启恢复必须通过现有 SSE 实时刷新；不新增轮询或 Goal 专属事件通道。

## Implementation Plan

1. 在 protocol、Session strict schema、store reducer/events 和 DTO 中加入 `SessionGoal`；删除独立 Goal types/store 以及 Session `goalId` 的资源引用。
2. 建立高内聚 `session-goal/` 模块：纯 schema、`SessionGoalService`、usage/budget、Evaluator、Continuation、Review Gate；Runtime 只负责装配和触发。
3. 重写模型工具与 Engineer Prompt contract，删除 Goal Create Skill、Goal Lead 和 `goal_manage`；收敛七 Agent 配置、Prompt legal modes 与 delegation admission。
4. 将 Tool Batch/HITL reconcile、Queue、bounded retry、startup reconciliation 和 no-progress block 接到 `SessionExecutionManager` 的既有终态通知，不建立第二套 scheduler/execution owner。
5. 实现 runtime-owned review claim/next-action、`startRuntimeReviewChild`、source-immutable Reviewer projection、canonical ChildResult 判定、objective/contract/input/source-mutation/fingerprint fencing 和确定性 replacement-attempt 恢复。
6. 将 Goal Worktree、HITL、Budget、Project Todo、Dashboard、title/context 投影迁回 Session owner；删除 Goal context resolver/lifecycle/cancellation/workspace/budget handler 路径。
7. 删除 Goal API/Web 产品面，完成 composer progress row、Session badge、Dashboard projection 和所有对话/控制交互。
8. 更新 AGENTS.md 与活跃产品文档，建立 `session-goal-runtime-hard-cut-progress.md` 逐项记录证据；最后做遗留搜索、全仓验证、真实浏览器用户故事和独立 Reviewer 验收。

## Non-goals

- 不修改 Automation 调度语义、普通 Session 的委派协议、Reviewer 的普通代码审查语义或 Project Todo 的 Shaper 讨论流程。
- 不建设通用 workflow engine、Goal revision/history 服务、跨资源关系图、全 workspace 锁或新的 Agent 类型。
- 不建设常驻全 workspace watcher；只在 active review claim 生命周期内建立临时 source monitor，并在 claim 失效或审核终态立即释放。claim/finalization fingerprint 仍是最终一致性门禁。
- 不以兼容旧 Goal 数据、旧 Goal Lead Session 或旧 URL 为目标。

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部有代码、测试、搜索、运行或浏览器证据；任一缺失即为 `NOT_DONE`。

### AC-01：Goal 领域完成 Session 化硬切

- 生产类型和持久化只有 `Session.goal?: SessionGoal`；不存在独立 Goal ID、GoalState、Goal 目录、Goal resource owner、Goal route/store/index 或 `Session.goalId`。
- 状态、generation、usage、review claim/receipt 和时间字段符合 Locked Architecture；旧 Goal 文件、Goal Lead Session 和旧 Goal schema 不迁移、不读取、不补默认值。
- 普通既有 Session 结构不因删除 Goal 资源而引入无关迁移；旧 Goal 专属数据严格失败或由明确清理步骤删除，不存在兼容 parser。

### AC-02：自然语言激活与控制确定

- 自动激活正向测试至少覆盖“持续做到测试通过”和“完成完整迁移”；负向测试至少覆盖简单修改、问答、诊断、一次调研汇报和仅复杂但无持续意图；模糊终点会澄清且不创建。
- 激活/编辑只能消费根 Engineer 当前 model boundary 的一次性 fresh-user-input capability；direct、queue、steer 均有正向测试，stale continuation、重复消费、automation input、子 Agent 和 Reviewer 均被拒绝。HTTP/UI 控制面另有独立授权测试，不依赖 Engineer Execution origin。
- 创建无需 Skill/二次确认且立即可见；Edit generation +1 并使旧 Evaluator/Review 失效。Pause、Resume、Clear、Stop+Pause 和 terminal Goal 后新建的语义均有正负测试。

### AC-03：自动续跑、恢复和停止边界正确

- family idle 时严格执行 runnable/answered Tool Batch reconcile -> unresolved HITL/control gate -> Queue -> requested review -> required remediation -> Evaluator -> continuation 顺序；answered HITL 与 Queue 同时存在、complete claim 与 idle、rejected 与 idle、Stop 取消 batch 后再派发 Queue、并发 idle 通知、启动 reconcile 和重试均只能接受一个合法下一 Execution。
- 未完成 Goal 在同一根 Engineer Session 自动继续；active Goal 跨真实 server restart 恢复一次。Pause、blocked、budget_limited、complete、pending HITL 和用户 Stop 后均不自动启动。
- failed/timed_out 有界退避，同一无进展原因连续三轮转 blocked；不得通过无限定时器、普通 Loop/Automation 或模型自我 Prompt 实现续跑。

### AC-04：独立 Reviewer 是不可绕过的完成门禁

- Engineer 和 Evaluator 均不能写 complete；complete claim/candidate 必须通过 `startRuntimeReviewChild()` 启动全新 Reviewer child，且所有 Build/写入 child 已终态。普通 delegate 与 goal_review provenance、重复 claim 幂等、非 Reviewer/失效 claim 拒绝均有测试。
- Review Gate 的 immutable contract 必含完整原始 objective Runtime criterion；测试必须证明模型无法在创建时遗漏或弱化 fresh 用户原话，amend 机械保留非冲突旧要求，而 replace 能明确删除旧约束。Reviewer 检查实际 Diff/文件和可重复验证，使用 canonical ChildResult 逐项映射全部 criteria/evidence。
- Goal Review projection 不含 file write/edit、Todo 或 Goal transition；guarded Bash 修改受审源码时 fingerprint 改变，本次审核必须失败。普通 Reviewer 工具和 ordinary review 行为不变。
- accepted/rejected 判定、generation/input/source-mutation/contract/fingerprint 失效、direct/queue/steer 用户消息打断均有测试；receipt/timeline/control writes 不增加 sourceMutationEpoch，源码写入必须增加或改变 fingerprint。
- Reviewer interrupted/crash 后必须保留同一 immutable claim、废弃旧 child/attempt、原子增加 attempt 并只启动一个全新 Reviewer child Execution；旧/迟到/重复 receipt 均拒绝。只有当前 attempt 的有效 accepted receipt 能原子完成 Goal。
- 浏览器用户故事必须展示至少一次 Reviewer rejected -> Engineer 自动修复 -> 新 Reviewer accepted -> complete。

### AC-05：Agent 与 Prompt 边界完成收敛

- Agent catalog、配置、Settings、Prompt snapshots 和测试只包含七个正式 Agent；不存在 `goal_lead`、Goal Lead fallback 或把 Evaluator伪装成 Agent 的路径。
- Engineer active-Goal overlay 明确激活策略、当前 objective/generation、编排责任、complete claim 和不可自审；普通 Engineer Prompt 不被整份 Goal 编排文案污染。
- Plan/Build/Explore/Librarian 只消费普通 DelegationContract；Reviewer ordinary review 保持，Goal completion review 由 Runtime claim 决定。生产代码不存在 Goal phase/parent 特判和 `goal_manage`。

### AC-06：所有权与跨域联动唯一

- Worktree/cwd、HITL、权限、Queue、child tree 和预算只有 Session owner；HITL boundary 不接受 goal owner，卡片/API/Dashboard 均以 root Session 聚合。
- Goal family usage 含 Engineer、普通 delegated children、Evaluator 和 Goal Reviewer，排除现有维护任务；达到预算确定性进入 budget_limited，用户调整后才可恢复。
- Project Todo schema/UI/API 不存在 Goal activation/resourceId；启动 Todo 创建普通 Engineer Session 且不绕过相同激活策略。Automation 行为无回归。

### AC-07：用户产品面只剩 Session Goal

- Goal list/detail/Inspector、Sidebar tab、独立 API/queries/mutations 和 URL 全部删除；不存在 redirect、隐藏页面、deprecated alias 或兼容响应。
- composer progress row、Session list badge 和 Project Dashboard projection 正确展示五种状态、用量、最近理由和控制动作；空 Goal Session 不显示 Goal UI。
- 桌面与 390px 浏览器验收覆盖：对话自动激活、自然语言编辑、Queue/Steer、Pause/Resume、Stop、Clear、HITL、预算限制、Review 循环、完成和 reload/server restart，console 0 error。

### AC-08：彻底删除、文档和全量验证完成

- 生产源码与活跃文档搜索证明不存在：`goal-create` Skill、`goal_lead`、`GoalStateManager`、`GoalLifecycleService`、`GoalLeadContinuationService`、`goal_manage`、`reviewGeneration`、Goal owner、Goal routes/UI、Todo Goal activation、独立 Goal worktree/budget/cancellation。
- 删除旧 exports、fixtures、styles、tests 和配置字段；没有 feature flag、adapter、双写、legacy parser、迁移器、旧 URL redirect 或注释掉的旧实现。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；编译后二进制和上述真实浏览器场景通过。
- 独立 Reviewer 必须按 AC-01 至 AC-08 给出具体文件、测试、搜索和运行证据，不能以“测试全绿”或“架构已简化”代替验收。
