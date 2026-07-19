# Agent Prompt Architecture V2 Hard-Cut Plan Goal

## Objective

彻底重构 ArchCode 八个 Agent 的模型可见 Prompt 与父子交接协议，让每次 Execution 都明确告诉模型“我是谁、处于什么状态、拥有什么能力、负责什么、怎样交付”，并让委派、并行、恢复和验收由可验证 contract 驱动，而不是固定 fan-out 文案或模型猜测。

本 Goal 保留八个 Agent 的职责和现有权限边界；不把主 Prompt 搬进 Skill，不重新扩写 Tool description，不以压低 token 为目标。

## Locked Decisions

- 保留 `engineer`、`goal_lead`、`plan`、`build`、`reviewer`、`explore`、`librarian`、`shaper` 八个角色。角色数量不是本轮问题。
- Prompt 负责稳定身份、行为协议、协作协议、运行时边界和完成权；Skill 只负责按需专业工作流；runtime 强制权限、状态机、并发、ownership 与结果 schema。
- 删除固定“非简单任务启动 2-4 个研究 child、至少一个 Explore”的规则。是否委派和并行只由关键路径、依赖、ownership、上下文隔离和运行时实际可见能力决定。
- `promptProfileId`、model-level Prompt capability 配置和 Model Overlay 全部删除；禁止按 provider/model 复制或分叉 Prompt。
- 父子交接硬切为结构化 delegation contract 与 child result contract。旧的自由文本 `task/context/persona/description` 交接和“取最后一条 assistant 文本作为结果”的路径直接删除，不保留 fallback、alias 或兼容解析。
- Goal Lead 只使用 runtime 已存在的 Goal transition；本轮不新增通用 Goal `blocked` 状态。Prompt 中删除无法执行的 `block` 承诺。
- 项目指令继续完整、可追溯地注入，不做不可靠的语义裁剪；本轮只明确其 authority 和来源。AGENTS.md 内容治理不扩成第二套规则系统。
- Tool schema/description 仍是工具调用事实的唯一来源；Prompt 只描述能力可见性和跨工具协作原则，不重复 Tool Contract。只允许同步修改本轮硬切涉及的 `delegate`、`resume_session`、`submit_child_result`、`goal_manage.finalize_review` 契约，其余 Tool Contract 改写全部 out of scope。
- 旧 persisted child Session 缺少 V2 delegation identity，硬切后直接拒绝加载，不迁移、不补默认值；对应旧 protocol/store/server/web 字段和 fixture 一并删除。
- 真实跨模型 live eval 不作为本 Goal 的 `DONE` 门槛；它是后续发布门槛。本 Goal 交付统一 Prompt 的确定性场景测试和可独立运行的 live-eval manifest/命令接口。

## Target Architecture

```text
AgentDefinition.roleContract ─┐
Session / Goal / Todo state ──┤
Resolved tools / MCP status ──┤
Skills / Memory / AGENTS.md ──┼─> PromptContractCompiler ─> final system/developer context
Environment facts ────────────┘

delegate(DelegationContract)
  └─> durable child identity + owned scope
       └─> child tools/model work
            └─> submit_child_result(ChildResult)
                 └─> delegate/background_output returns canonical result
```

`PromptContractCompiler` 只接收已解析的普通数据快照，不直接依赖 Goal、Todo、MCP 或 Session manager；各领域 owner 负责生成自己的 snapshot，避免 Prompt 层反向拥有运行时状态。`RoleContract` 的 `requiredCapabilities`、`forbiddenCapabilities`、`allowedTransitions`、`completionAuthority` 和 `delegateTargets` 是 typed refs；自然语言只解释，不作为 lint 的解析对象。

## Prompt Layers

最终拼装顺序固定为：

1. Shared Kernel：证据、用户改动保护、阻塞和完成原则、authority precedence。
2. Runtime Envelope：Agent/Session/父子/depth、可委派目标、Goal/Todo/review mode、owned scope、MCP readiness。
3. Role Contract：使命、输入、必须做、禁止做、输出和完成权。
4. Collaboration Contract：自己做、delegate、parallel、resume、消费 child result 的统一规则；只给有相关能力的角色注入对应部分。
5. Skills：可用 Skill 元数据与 active Skill 正文；明确 Skill 不扩大权限。
6. Tool Visibility：最终可见工具名和动态服务状态，不复制 description。
7. Current Context：Goal/Todo/review generation 等当前权威 snapshot。
8. Memory：带来源的历史线索，不得覆盖当前 runtime/file/user facts。
9. Project Instructions：来源标注后的 AGENTS.md；不得扩大 runtime 权限或完成权。
10. Environment：cwd、项目根、版本控制、时间等事实。

禁止继续用 `user` role 的 `<system-reminder>` 承载身份、权限、Goal phase、review mode 或 ownership。Hook 只提醒当前进度；权威状态必须进入 Runtime Envelope 或 Current Context。

每次 Execution 固定 AGENTS、Memory、active Skills、最终工具集和 MCP 可见性；每次 model call 重新读取 Goal/Todo/review/child 状态并重新编译 Runtime Envelope。领域 tool result 是本次 call 之后的最新事实。MCP 在 Execution 中途变为 ready 时只记录 trace，不扩大本次已固定工具集，下一次 Execution 才生效。

## Legal Execution Modes

| Agent | 合法模式 |
| --- | --- |
| Engineer | ordinary root |
| Goal Lead | Goal root：running、reviewing、not_done |
| Plan | Engineer child；Goal running child |
| Build | Engineer child；Goal running child |
| Reviewer | ordinary review child；Goal reviewing child |
| Explore | Engineer/Goal Lead/Plan/Build/Reviewer/Shaper child；Goal Lead/Plan/Build 只在 Goal running，Reviewer 研究 child 只在 reviewing |
| Librarian | Engineer/Goal Lead/Plan/Reviewer/Shaper child；Goal Lead/Plan 只在 Goal running，Reviewer 研究 child 只在 reviewing |
| Shaper | bound Todo root |

未列出的角色 × mode 组合必须在创建 Session 或编译 Prompt 前被 runtime 拒绝，并有负向测试；不得为不可达组合生成伪造 snapshot。

## Contracts

### DelegationContract

`delegate` 硬切为以下语义字段：

- `agent_type`、`title`、`objective` 必填。
- `owned_scope: ScopeRef[]`、`non_goals: string[]`、`acceptance_criteria: AcceptanceCriterion[]` 必填；Build 的 `owned_scope` 至少一项，其他角色可为空数组。
- `ScopeRef` 只允许规范化的 workspace-relative `{ kind: "file" | "tree", path }`。禁止 absolute path、`..`、glob、symbol、module；复用 workspace path guard 解析 symlink/不存在路径的最近已存在祖先。相同路径或任一 `tree` 是另一 scope 祖先即为重叠。
- `AcceptanceCriterion` 固定为 `{ id, condition, requiredEvidence }`；id 在单个 contract 内唯一。
- `evidence: { claim, ref }[]`、`verification: { command, expected }[]`、`depends_on: string[]`、`skills: string[]` 为明确数组，不从自然语言猜测。
- `background` 保留。
- 删除 `persona`、`description`、`task`、`context`。

`depends_on` 只接受同一 parent 已有 direct child Session ID，并且这些 child 必须已有 `status=completed` 的 canonical result；它只是 admission 前置条件，不引入等待调度器。Runtime 必须在 child 创建前校验 target、depth、Goal phase、Skill 和 dependency；每次 child Execution activation——新建、resume、进程重启后的冷恢复——都必须按 durable contract 原子获取 Build ownership lease，终态时释放。校验或 lease 获取失败不得创建/link 新 child，也不得启动已有 child。活动 Build child 的 owned scope 重叠时直接拒绝，不依赖 Prompt 自觉。

`resume_session` 只允许提交 `session_id`、`instruction`、`new_evidence`、`background`；不能改变 Agent 类型、title、Skill、owned scope 或原 acceptance criteria。需要改变 ownership 时必须创建新的 delegation contract。

### ChildResult

新增只对非 Goal-Reviewer direct child 可见的 `submit_child_result`：

- `status`: `completed | partial | blocked | failed`
- `summary`
- `deliverables[]`: 类型、引用、说明
- `evidence[]`: claim 与可定位 ref
- `verification[]`: 检查、状态、output ref
- `unresolved[]`: 问题、是否阻塞、下一责任方

Runtime 在提交时生成不可伪造的 `ChildResultReceipt { executionId, delegationContractHash, submittedAt, result }`。普通 child 以单一 `child-result` Session store event 持久化。`submit_child_result` 是 terminal execution-control action：提交成功后立即结束当前 Execution，不再允许工具调用或模型输出。每次 resume 产生新的 executionId，必须提交新 receipt，旧 receipt 不能满足新 Execution。

ChildResult 的 `status` 表示 delegated task 状态；Execution `completed` 只表示本次提交协议成功。合法 `completed/partial/blocked/failed` ChildResult 都对应 Execution `completed` 并在 UI 单独展示 task status；没有合法 receipt、timeout、abort 或 runtime failure 使用原 Execution 非完成终态。

Child Execution 没有成功提交合法结果时，不得以 `completed` 结束，统一以明确的 `CHILD_RESULT_REQUIRED` 失败。`delegate`、terminal reminder 和 `background_output` 只返回持久化 receipt；删除读取最后一条 assistant 文本的 fallback。通用 `AgentResult` 不承载 ChildResult；新增 `ChildExecutionOutcome { executionStatus, resultReceipt? }` 作为父子运行边界。

Goal Reviewer 只通过 `goal_manage.finalize_review` 做最终提交。扩展后的 Goal review receipt 是唯一 canonical receipt，直接包含 `executionId`、`delegationContractHash` 和同形 ChildResult，并在一次 Goal state commit 中写入；Session `child-result` 只是不参与 authority 的可恢复 UI/事件投影，丢失时从 Goal receipt 重建。该 action 是 terminal execution-control action；Goal Reviewer 不可见 `submit_child_result`，从根源上消除跨文件双写和新事务协调器。

## Implementation Plan

1. 建立 `PromptContractV2`、`RuntimePromptEnvelope`、结构化 `RoleContract` 和纯 `PromptContractCompiler`；删除旧 builder 的自由文本拼装入口和 `promptProfileId`。
2. 从 Session store、Agent factory、Goal/Todo context 和 MCP status 生成不可变 snapshot；固定 Execution 级来源，每次 model call 刷新生命周期状态，将身份与生命周期提醒从 user-message hook 移入权威 Prompt 层。
3. 重写 Shared Kernel、Collaboration Contract 和八个 Role Contract；删除重复规则、固定 fan-out、不可执行能力和由模型猜 review mode 的文案。
4. 将 `delegate`、`resume_session`、child identity 和 Build ownership 硬切到 DelegationContract；同步更新 protocol、store、server、Web projection 和 strict Session schema，在 child 分配/链接前完成全部 admission。
5. 增加 terminal `submit_child_result`、durable receipt 和 `ChildExecutionOutcome`；让同步/后台收集、terminal reminder 只消费 canonical receipt，并扩展 Goal review receipt 作为 Goal Reviewer 的单一结果 owner。
6. 所有模型使用同一套 Prompt contract；删除 model-level capability 配置和 Model Overlay。Provider/model 差异只进入 API call options，不改变 Prompt 或 child runtime 并发。
7. 明确 Skill、Memory、Project Instructions、Tool Visibility 的 authority 包装；修正 Goal memory 等接口注释与真实注入不一致，但不扩张各领域功能。
8. 增加 Prompt trace、合法模式快照、冲突 lint、统一 Prompt 的确定性场景测试，以及接收显式 model manifest 的 opt-in live-eval 命令；完成全仓验证和旧路径搜索审计。真实模型运行结果留给后续发布门槛。

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：八 Agent 最终 Prompt 可证明且状态权威

- 八个 Agent 按 `Legal Execution Modes` 的每个合法组合生成最终 Prompt snapshot；每个非法组合有 runtime 拒绝测试，不伪造不可达场景。
- snapshot 明确包含真实 agent/session/root/parent/depth、allowed targets、completion authority、review mode、Goal/Todo identity、owned scope、MCP readiness 和实际可见工具；不适用字段明确为 `none`，不得靠模型推断。
- 身份、权限、ownership、Goal phase 和 review mode 不再只存在于 user-role reminder。
- Prompt trace 能输出 section 来源、版本、hash、active Skills、Memory/AGENTS 来源和最终可见工具名。Skill/Memory/AGENTS 分别记录 `present | absent | error`；MCP 记录 `pending | ready | ready-zero | partial-warning | failed`。
- active Skill 缺失/不可读、已发现的 AGENTS.md 不可读时 fail closed，在 model call 前终止并持久化 error trace；Memory 是非权威历史线索，读取失败允许继续，但必须省略内容、持久化 warning trace 并在 Prompt 中标明 unavailable。MCP pending/failed/ready-zero 只影响实际可见工具和 trace，不阻止无 MCP 依赖的 Execution。
- 同一 Execution 中 Goal/review 状态变化会在下一次 model call 进入新 Runtime Envelope；MCP/tool set 保持 Execution 级冻结并在下一次 Execution 刷新。

### AC-02：Prompt 分层唯一且无矛盾

- 生产代码只有一个 `PromptContractCompiler` 生成最终 Prompt；旧 builder、旧 section 顺序和 `promptProfileId` 被删除，无 wrapper、双写或 feature flag。
- 静态 lint 只读取 RoleContract 的 typed capability/transition/authority refs，并拒绝：角色要求不可见能力、不可用 delegate target、无 runtime action 的状态迁移、Skill/Project 扩大权限、completion authority 与 session mode 冲突；禁止解析自然语言来猜规则。
- Shared Kernel、Role、Collaboration、Skill、Memory、Project 和 Tool Contract 各自只有一处责任来源；八个 role 不复制 shared delegation 文案。

### AC-03：委派决策不再由固定数量驱动

- Engineer 和 Goal Lead Prompt、测试及 Skill 中不存在“2-4 research children”“至少一个 Explore”或等价固定 fan-out。
- contract 明确：关键路径工作优先自己做；只有独立、可验收、ownership 可分离或需要专门能力时才 delegate；只有无依赖且无写入重叠时才 parallel；同一责任的补充/修复必须 resume。
- eval 中的小型直接任务不得创建 child；独立任务在 capability 允许时并行；有依赖任务必须串行。

### AC-04：DelegationContract 硬切完成

- `delegate` 只接受本 Goal 锁定的新字段；源码、schema、测试和模型可见定义中不存在旧 `persona/description/task/context` 输入或兼容解析。
- delegation contract 及其 hash 作为 child durable identity 的一部分持久化；冷加载、resume、重启后保持相同 ownership、acceptance criteria 和依赖。
- 所有 admission 在 child 创建/链接前完成；失败不留下 Session、link 或 ownership lease。
- ScopeRef 只接受本 Goal 定义的 file/tree 形式；规范化、symlink/逃逸拒绝、tree 祖先重叠和同 parent terminal dependency 均有正负测试。两个活动 Build child 的 owned scope 重叠会被 runtime 确定性拒绝。
- 新建、resume 和冷恢复都必须重新获取 durable contract 对应的 ownership lease；重叠 child 存活期间 resume 原 Build child 会在 model call 前被拒绝，所有终态均释放 lease。
- 缺少 V2 delegation identity 的旧 child Session fail closed；不存在迁移、默认值、兼容 schema、旧 link description 或旧 DTO 字段。

### AC-05：ChildResult 成为唯一交付接口

- 非 Goal-Reviewer direct child 只有成功调用 terminal `submit_child_result` 后才能以 `completed` 结束；Goal Reviewer 只有成功调用 terminal `finalize_review` 后才能完成。缺失或 schema 不合法时得到 `CHILD_RESULT_REQUIRED`，不能静默成功。
- 每个 receipt 绑定当前 executionId 和 delegationContractHash；resume 必须产生新 receipt，提交后不能继续调用工具或输出。
- `ChildExecutionOutcome`、delegate 同步结果、terminal reminder 和 `background_output` 返回同一 canonical receipt；通用 `AgentResult` 保持 execution result，不混入 task result。
- 普通 child 的 Session receipt 与 Goal Reviewer 的 Goal review receipt 各自只有一个 canonical owner；不存在跨文件事务、双写 authority 或 WAL。Goal Reviewer 的 Session 投影删除后可从 Goal receipt 确定性重建。
- 生产代码不存在 `getLastAssistantText`、`latest assistant text` 或自由文本 child-result fallback。
- 父 Agent Prompt 要求逐项检查 acceptance criteria 和 evidence；child `completed` 不自动等于父任务或 Goal 完成。
- ChildResult task status 与 Execution status 分开持久化、投影和展示；四种合法 task status 与 timeout/abort/runtime failure 的映射符合本 Goal 定义。

### AC-06：八个角色的完成权明确

- Engineer 只拥有 ordinary Session 用户级完成权；Goal Lead 只负责编排和已有 transition，不能宣布 DONE；Build/Plan/Explore/Librarian 只完成 delegated scope；Shaper 只更新 bound Todo。
- Reviewer 的 `ordinary | goal` 模式来自 runtime；ordinary Reviewer 不调用 Goal transition，Goal Reviewer 只处理匹配的 goalId/reviewGeneration。
- Goal Lead Prompt 不再声称可执行不存在的通用 `block` action；Goal runtime 状态机不因本 Goal 新增通用 blocked 状态。
- Role contract tests 同时包含正向能力和禁止能力，不能只做字符串存在检查。

### AC-07：所有模型共用统一 Prompt、无厂商分叉

- Model config 不接受 Prompt 行为 capability 或 instruction tier；用户只配置模型元数据和 API call options。
- 最终 Prompt 由 Shared Kernel、Runtime Envelope、Role Contract、Collaboration、Skills、Tools、Context、Memory、Project Instructions 和 Environment 统一组成，不包含 Model Overlay。
- 仓库不存在 `if provider === ...`、按模型名称选择整份 Prompt、八角色 × 厂商的 Prompt 副本。
- 后台 child 是否可重叠只由依赖、ownership 和 `childPolicy.maxConcurrent` 决定。
- 所有模型的 canonical structured result 都使用同一规则：允许一次明确纠错，第二次失败进入 `CHILD_RESULT_REQUIRED`，绝不回退自由文本完成。

### AC-08：验证与真实回归完整

- Prompt snapshot、contract/lint、delegation admission、ownership、resume、child result、Goal Reviewer、MCP readiness 和统一 Prompt 的确定性目标测试全部通过。
- 仓库提供唯一 opt-in live-eval 命令、显式 model manifest schema、固定场景 fixture 和机器可读结果路径；命令只运行 manifest 中的模型，不猜 provider/model。真实模型执行和通过率不属于本 Goal 的 `DONE` 条件，也不得在本 Goal 完成报告中宣称已经跨模型实测通过。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 最终 Reviewer 必须按 AC-01 至 AC-08 提供文件、测试、搜索和运行证据，不能用“Prompt 更清晰”或“测试通过”代替逐项验收。

## Hard-Cut Audit

完成前必须搜索并证明不存在：旧 Prompt builder、`promptProfileId`、固定 2-4/Explore fan-out、旧 delegate 字段、旧 child link/DTO/session fixture、自由文本 child result fallback、provider-name Prompt 分支、由模型猜测 review mode、Prompt 宣称但 runtime 不存在的 Goal action、缺少 delegation identity 的兼容读取或迁移代码。
