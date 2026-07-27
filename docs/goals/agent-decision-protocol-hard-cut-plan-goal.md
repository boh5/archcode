# Agent Decision Protocol Hard-Cut Plan Goal

本计划收敛 Goal、Automation 与通用 `ask_user` 中由 Runtime 或固定文案替 Agent 判断自然语言语义的协议。实施完成后，Lead 负责理解用户是否同意，Goal Review 的 Analyst 负责给出普通证据报告，Runtime 只负责结构化数据、权限、Session 身份和原子一致性。

## Objective

彻底删除四类不必要协议：

1. Automation 创建时固定 `Create Automation` / `Revise proposal`、`custom: false` 和固定确认轮次。
2. Goal 完成时的 `review_session_id`、`goalReviewBinding`、精确 `VERDICT:*` 口令、单次 Review Session 和 ArchCode-known write freshness 扫描。
3. `create_goal` 从自然语言 objective 猜测 token budget 的中英文正则解析。
4. 通用 `ask_user` 为推荐项强制固定英文 `(Recommended)` 后缀，以及锁死该措辞的测试。

保留用户确认、独立 Review 和推荐意见本身，但它们都是 Agent 行为，不再成为 Runtime 解析的文本协议。旧持久化字段、旧输入、fallback、迁移和墓碑测试全部不保留。

## Locked Architecture

```text
Generic ask_user
  -> transport arbitrary question/options/free text
  -> apply existing bounds/redaction without semantic classification
  -> Lead interprets meaning in conversation

Automation
  -> Lead builds complete proposal
  -> ask_user
  -> Lead interprets accept / revise / decline
  -> automation_create receives typed Automation input

Goal creation
  -> ask_user
  -> Lead interprets agreement
  -> create_goal({ objective })
  -> budget remains unset until user changes it through API/UI

Goal completion
  -> Lead finishes work
  -> existing Session family lifecycle confirms no child is active
  -> fresh deep Analyst with goal-review returns an ordinary evidence report
  -> Lead interprets approved / changes required
  -> update_goal({ status: "complete", reason })
  -> SessionGoalService atomically fences current instance/generation
```

### Ownership boundaries

- `ask_user` 是通用 HITL transport：负责严格结构、长度限制、redaction、持久化、暂停/恢复和取消；边界处理后不做 Goal、Automation、推荐项或 yes/no 语义分类。
- `automation-create`、`orchestrate-work`、`run-goal` 和 `goal-review` Skills 只描述 Agent 应做什么，不规定固定语言、选项 label、回答字符串或机器可解析的输出口令。
- `automation_create` Runtime 只验证 typed Automation schema、普通 root Lead Session 身份和现有 project provenance。
- `create_goal` Runtime 只验证 typed objective、root Lead/Discussion 边界和当前 Goal 状态；不得读取或推断用户自然语言。
- `update_goal` 与 `SessionGoalService` 只验证当前 active Goal、允许的状态转换及原子 instance/generation；现有 Session family 生命周期继续阻止仍有 active child 时完成，但不得验证 Reviewer 文本、Review Session provenance 或工作区写入历史。
- `SessionExecutionManager` 和 Session store 不保存 Goal Review 专用 binding，不为 Review Session 增加专用 admission、终态或 resume 规则。

## Behavioral Contracts

### Generic Ask User

- AI 在有明确倾向时应把推荐项排在第一位，并简要说明理由。
- 推荐措辞由 AI 根据会话语言和语境决定，可以体现在 label、description 或问题正文中；不得要求固定后缀、固定英文或新增 `recommended` schema 字段。
- options 仍可为空；`custom: true` 时用户可自由输入。回答经过现有 bounds/redaction 后返回，由调用方 Agent 解释，不做语义归一化或分类。

### Automation confirmation

- Lead 只询问真正缺失的信息，并在创建前给出包含 name、trigger、action 及必要 location/target/message 的完整摘要。
- Lead 在收到并理解用户回答之前不得调用 `automation_create`。用户接受则创建，要求修改则更新摘要后再次确认，拒绝则不创建。
- 问法、语言、options、是否允许 custom 以及用户如何表达接受均由 Lead 决定；Skill、Tool description、Runtime 和测试不得固化具体 label 或 answer。
- Todo 激活 Automation 继续复用同一 `automation-create` Skill，不增加 Todo 专用确认协议。

### Goal budget

- `create_goal` 只接收 objective，不接收或解析 budget；objective 中即使出现 token、预算、上限、`k/m/万` 等文本，也只作为 objective 原文保存。
- 新 Goal 的 `tokenBudget` 必须为 unset。用户随后通过现有 Session Goal API/UI 设置、调整或清除预算。
- 现有预算 schema、usage accounting、budget-limited 状态和用户控制面不变。

### Goal completion review

- `run-goal` 在完成前仍要求 Lead 启动一个 fresh direct `analyst + deep + goal-review`，并在变更后重新 Review；这是 Agent 工作方法，不是 Runtime authorization。
- `goal-review` 输出普通自然语言结论、findings、证据、验证缺口和 residual risk。可以使用任意语言和表达，不要求首行口令。
- Lead 根据完整报告决定修复还是调用 `update_goal(status=complete)`；`update_goal` 不接收 Reviewer Session ID。
- Goal completion 继续通过 `SessionGoalService.complete()` 的 expected instance/generation 原子 fence 防止并发 Goal 替换；usage telemetry 不算 semantic generation。
- Runtime 不再证明 Lead 是否真的 Review、是否正确理解报告，或 Review 后是否发生文件写入。这些属于 Lead 的完成判断，不得用新的 receipt、token、fingerprint、文本 parser 或工作流状态补回。是否仍有 active child 继续使用现有 execution-family 状态判断，因为它是执行生命周期事实，不是 Review 语义。

## Implementation Plan

1. **收敛通用 Ask User contract**
   - 删除 `ask-user.ts` 中 `(Recommended)` 和推荐项固定措辞，保留推荐项排第一。
   - 保留“有明确倾向时把推荐项排第一并说明理由”的自然语言 guidance，不增加 schema 字段或 UI 特判。
   - 删除 model-visible contract 中锁定固定后缀/措辞的断言；保留推荐项排第一的语义断言，以及 schema bounds、free-text、redaction 和 suspend/resume 测试。

2. **简化 Automation confirmation**
   - 重写 `automation-create/SKILL.md` 和 `automation_create` description，只保留完整摘要、等待回答、Lead 语义判断和 typed create。
   - 更新 Todo Automation activation message，删除“固定 confirmation flow”措辞，仅激活同一个 Skill。
   - 将 Protocol 中 `createdFromSessionId` 的注释从“用户确认来源”改成纯创建来源，不把 Session 关联伪装成确认 provenance。
   - 删除固定 options、`custom: false`、固定答案或固定批次形状的测试，不用另一组文案替换。

3. **删除 Goal budget 自然语言 parser**
   - 从 `create_goal` 删除 `resolveCreateTokenBudget`、`extractExplicitTokenBudgets`、`hasBudgetRemovalIntent` 及全部正则和错误分支。
   - 从 `SessionGoalService.create()` 删除 `tokenBudget` 输入和创建分支；任何创建调用点都不能设置初始预算。
   - 保留并验证现有 API/UI budget control 和 budget enforcement；不增加兼容 parser。

4. **硬切 Goal Review Runtime protocol**
   - 将 `update_goal(complete)` 输入收敛为 `{ status: "complete", reason }`。
   - 删除 `GoalReviewBinding` 类型/schema/persistence、Session store manager plumbing、execution-manager binding 创建和 completed Review resume 禁令。
   - 删除 `assertApprovedGoalReview`、Review provenance/freshness 写入扫描、精确 verdict 解析和 `review-provenance.ts`；将 active-child 检查保留为不依赖 Reviewer 的最小 Session family lifecycle guard。
   - `update_goal` 从当前 active Goal 获取 instance/generation，并以 expected values 调用 `SessionGoalService.complete()`，保留并发替换 race test。
   - 重写 `run-goal`、`goal-review` 和相关 Prompt/tool descriptions，使 Analyst 正常报告、Lead 语义判断；删除 exact-output contract tests。

5. **彻底清理、文档和验证**
   - 删除或改写只服务于旧协议的 fixtures、helpers、integration flows 和 architecture assertions；测试当前正向行为，不保留“旧字段被拒绝”的专用墓碑测试。
   - 更新 `AGENTS.md`、`docs/agents/multi-agent-design.md`、当前 Goal 架构 plan/progress 和仍声称旧 Runtime gate 的活跃文档。
   - 不修改历史 progress 中仅作为当时 review 结果记录的普通 `VERDICT` 文本，除非它被描述为当前生产合同。
   - 按 `typecheck -> test -> build` 运行仓库标准验证，补充必要的定向测试、literal search、`git diff --check` 和最终独立只读 Review。

## Hard-Cut Rules

- 删除字段、函数、文件、imports、exports、tests 和文档消费者，不保留 deprecated alias、optional legacy field、migration、dual read/write、feature flag 或 fallback。
- 旧 Session 文件若含 `goalReviewBinding`，在 strict current schema 下不兼容；不迁移、不忽略未知字段。操作者按既定 hard-cut 策略清理旧 runtime state。
- 不新增 Goal review receipt、approval token、review state machine、Ask User preset、answer classifier、推荐项 schema 或 Automation confirmation service。
- 不增加专门验证旧字段/旧问法/旧 verdict 被拒绝的墓碑测试；只测试当前合法合同和真实边界。

## Risks And Deliberate Tradeoffs

- Runtime 不再能证明用户真的同意创建，或 Lead 正确理解了用户回答。这是刻意边界：LLM 语义由 Lead 负责，Runtime 只执行 typed tool call。
- Runtime 不再能证明 Goal completion 前确实完成独立 Review 或 Review 后没有写入。错误完成由 Lead 的行为质量承担；不得以不完整的“已知写入”扫描制造虚假保证。active child 仍由现有生命周期事实阻止完成。
- objective 中写“预算 5k”不再设置 hard cap。产品必须依赖现有 API/UI budget control；Skill/Tool description 应明确这一点，避免用户误以为文本已生效。
- 删除 persisted `goalReviewBinding` 会使旧 Session 数据不兼容。本计划明确接受数据清理，不提供迁移。
- Automation 先确认后创建依赖 Lead 遵守 Skill。若未来需要强事务授权，必须作为新的产品决策单独设计，不能在本次实现中暗中恢复协议。

## Non-goals

- 不删除通用 `ask_user`、HITL project queue、Tool Batch suspend/resume、redaction 或 durable answer。
- 不修改 Permission fingerprints、tool permission asks、`expectedRevision`、`expectedGeneration`、Goal Notice、Goal continuation 或 Session persistence。
- 不删除 Goal 独立 Review 这一工作方法，也不改变 Analyst、Build、Explore、Librarian 的一般委派能力。
- 不重做 Automation schema、scheduler、dispatcher、API/UI 或 Todo 产品流。
- 不增加通用 workflow engine、policy DSL、semantic classifier 或新的 Agent 类型。

## Acceptance Criteria

以下 AC-01 至 AC-06 必须全部有代码、测试、搜索或运行证据；任一缺失即为 `NOT_DONE`。

### AC-01：Ask User 推荐语义与呈现解耦

- `ask_user` schema 仍支持 1–3 个问题、0–3 个 options、custom free text、multiple、长度限制和严格边界；现有 suspend/resume、取消、redaction 测试通过。
- Tool/schema description 要求 AI 将推荐项排第一并说明理由，但不要求 `(Recommended)`、固定语言或固定 label，也没有新增推荐字段/UI 分支。
- `packages/agent-core/src` 中除本计划证据外不存在 `(Recommended)` 或测试它的 regex；model-visible contract 不再锁定推荐文案。
- 中英文 label 和任意 free-text 回答经现有 bounds/redaction 后返回给 Lead，generic HITL/Runtime 不做 yes/no、accept/revise 分类。

### AC-02：Automation 只保留 Lead 语义确认

- `automation-create` Skill 要求完整摘要、收到回答后再决定、接受后创建、修改后重确认、拒绝不创建；没有固定 option label、固定语言、`custom: false` 或固定回答比较。
- `automation_create` 只验证当前 typed schema、普通 root Lead 和 project provenance；不存在 Automation confirmation preset/token/receipt/parser。
- 现有 `ask_user` transport、`automation_create` typed boundary 和 Todo activation wiring 测试通过；不新增声称能证明 Lead 正确理解某句自然语言的测试。
- `createdFromSessionId` 只表示创建来源 Session；Protocol、Tool description 和活跃文档不得将它描述为用户确认凭证。
- `Revise proposal` 在生产 Skill/Tool contract 和对应测试中为零；不能用新的同义固定 label 取代。

### AC-03：Goal 创建不再解释预算文本

- `create_goal` 路径不存在 `resolveCreateTokenBudget`、`extractExplicitTokenBudgets`、`hasBudgetRemovalIntent` 或同类自然语言/正则 parser。
- `SessionGoalService.create()` 不接受 `tokenBudget`。创建包含英文或中文预算文字的 objective 时，objective 仍保存且新 Goal 的 `tokenBudget` 为 unset。
- 只有现有用户 API/UI budget control 能设置、调整和清除 token budget；usage enforcement 和 `budget_limited` 正负测试继续通过。
- 不新增 `create_goal` budget 字段、fallback parser 或从 Session 消息二次提取预算的路径。

### AC-04：Goal Review 专用 Runtime 协议完全删除

- 当前 production types/schema/store/execution/tool 中不存在 `GoalReviewBinding`、`goalReviewBinding`、`review_session_id`、Goal Review 专用 terminal/resume rule 或 `review-provenance` 模块。
- `update_goal` complete 当前合法输入只有 `status` 和 `reason`；Tool 读取 active Goal 的 instance/generation，并通过 `SessionGoalService.complete()` 原子拒绝并发替换。
- `goal-review` 可用中文、英文或其他普通报告格式；Runtime 不读取首行、不比较 `VERDICT:*`、不加载 Reviewer Session，也不扫描 family writes。active-child 拒绝只依赖现有 Session family 状态。
- 现有 full-runtime Goal wiring smoke 适配当前 Tool schema，并使用不含固定 verdict 的普通 Analyst 报告；该测试只证明调用链可运行，不声称证明 Lead 的语义理解。
- 删除旧 gate 测试或改写为当前正向行为；不存在专门证明旧 `review_session_id`、旧 binding 或旧 verdict 被拒绝的墓碑测试。

### AC-05：高内聚、低耦合与 hard cut

- 通用交互只在 `ask_user`/HITL 模块；Automation 行为只在 Automation Skill/tool；Goal 状态只在 `session-goal` service/tool；execution/store 不含 Goal Review 语义分支。active-child 检查复用普通 family 状态，不建立 Goal Review 状态。
- `expectedRevision`、`expectedGeneration`、权限和 HITL replay 等必要一致性/安全协议没有因本次清理被删除或复制。
- 活跃架构文档不再声称 Runtime 验证固定确认答案、Reviewer 文本、Review provenance 或 ArchCode-known write freshness；历史记录不被当作当前合同。
- 定向搜索确认没有 legacy adapter、unknown-field ignore、migration、feature flag、双写、死 export、新协议替代物或把 `createdFromSessionId` 描述成确认 provenance 的生产合同。

### AC-06：验证与最终验收

- 定向测试覆盖 `ask-user`、Automation create/activation、Session Goal tool/service、Session store strict schema、execution manager 和 full-runtime Lead flows。
- `bun run typecheck`、Agent Core unit/integration/arch、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 精确搜索及人工分类证明 AC-01 至 AC-05 的旧生产概念已删除，合法 UI 文案、历史 review 记录和必要一致性字段没有被误删。
- fresh independent deep Reviewer 按 AC-01 至 AC-06 检查最终 Diff；存在 blocking/high 即为 `NOT_DONE`，修复后必须重新 Review。
