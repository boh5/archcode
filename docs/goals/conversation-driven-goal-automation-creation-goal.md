# Conversation-Driven Goal and Automation Creation Goal

## Objective

将 Goal 和 Automation 的创建流程彻底硬切为普通 Engineer Session 驱动：用户在对话中澄清需求，Agent 读取对应创建 Skill，给出简洁且完整的最终摘要，并在用户明确确认后提交。Session 是唯一的未确认意图空间；Goal 一旦存在即是已承诺持续推进的目标，Automation 一旦存在即是已承诺的触发规则。删除 Goal Draft、Goal/Automation 创建表单、直接创建 API 及全部旧兼容路径，并在来源 Session 的 Context 中提供可点击的双向关联。

## Locked Architecture

```text
Goal/Automation 列表入口或普通对话
  -> ordinary root Engineer Session
  -> goal-create | automation-create Skill
  -> 用户明确确认
  -> goal_create -> GoalRunner -> committed Goal -> independent Goal Lead root Session
  -> automation_create -> existing Runtime/AutomationScheduler -> committed Automation

Session Context <- derived from Goal/Automation.createdFromSessionId
```

- Agent 只识别意图和执行 Skill；Skill 只负责澄清、规范化和确认，不拥有权限、持久化或生命周期正确性。
- 用户确认属于 Engineer prompt 与创建 Skill 的对话契约；Runtime 不解析自然语言确认，也不新增 consent token、确认状态机或第二层 approval。
- `goal_create` 和 `automation_create` 只提交已经确认的结构化输入；来源 Session 从 ToolExecutionContext 的当前 store 身份导出，模型不能填写或伪造。
- Goal 创建在产品上是一步，运行时分为可恢复的 commit 和 activate：先持久化承诺，再幂等准备 worktree、Goal Lead Session 和执行。
- Goal Lead 是 Goal 拥有的独立根 Session；它不是来源 Engineer Session 的 child，停止或删除来源 Session 不得停止 Goal。
- Context 是派生查询，不保存第二份关系；Session 不增加 `createdGoalIds`、`createdAutomationIds` 或通用 relation graph。

目标领域关系必须等价于：

```ts
interface CreationProvenance {
  createdFromSessionId: string; // immutable, same-project ordinary Engineer Session
}

// Provenance is separate from execution ownership:
// Goal.mainSessionId -> Goal Lead execution Session
// AutomationInvocation.sessionId -> dispatched execution Session
```

## Non-goals

- 不新增 Goal/Automation Draft 卡片、创建向导、特殊 Setup Session 类型、Plan/Goal/Automation 模式或新的 Context Tab。
- 不建设通用 intent classifier、关系图谱、workflow engine、Saga framework 或跨资源数据库；可靠创建只使用现有文件持久化边界上的最小幂等协调。
- 不新增 Automation update/pause/resume/delete Agent 工具；现有详情页管理能力不因本 Goal 扩大。
- 不新增领域执行 Skill、Skill 提炼、Skill 版本绑定、Skill marketplace 或 Goal/Automation 与执行 Skill 的持久关联。
- 不修改 Automation trigger/action、Invocation 派发、overlap、HITL 或调度语义。
- 不修改 Goal review、Reviewer verdict、Budget、HITL、retry 或完成判定；只重构创建、初次激活和来源关系。
- 不迁移旧 Goal/Automation 数据，也不保留旧 schema、API、UI、别名、fallback 或双写。

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部有代码、测试或审计证据；任一条件缺失即为 `NOT_DONE`。

### AC-01：对象边界与来源关系唯一

- 每个新 Goal 和 Automation 都持久化必填、不可修改的 `createdFromSessionId`；创建工具输入和剩余 HTTP update payload 均不能接受该字段作为模型/客户端可控值。
- GoalRunner 和 Automation 的 Runtime 创建路径校验来源 Session 存在、属于同一项目，且满足 `sessionId === rootSessionId`、`parentSessionId === undefined`、`goalId === undefined`、`agentName === "engineer"`、`sessionRole === undefined || sessionRole === "standalone"`；其他 Agent/Session 创建被拒绝。
- 一个来源 Session 可以创建零到多个 Goal/Automation；反向查询以资源上的 `createdFromSessionId` 为唯一事实来源，Session 文件不缓存资源 ID。
- 来源关系是非 owning weak reference：删除来源 Session 不级联取消、暂停或删除 Goal/Automation；详情页对已删除来源显示 unavailable，而不是崩溃或改写 provenance。
- `mainSessionId`、Invocation `sessionId` 和 `createdFromSessionId` 在类型、服务命名、测试和 UI 文案中保持不同语义，不得互相推导或复用。

### AC-02：普通对话与创建 Skill

- 只新增两个内建创建 Skill：`goal-create` 和 `automation-create`，并只加入 Engineer 的显式 Skill allowlist；不得借本 Goal 增加其他 Skill。
- `goal-create` 和 `automation-create` 是保留的内建创建契约，不得被 project/user 同名 Skill 覆盖；其他 Skill 的既有解析优先级保持不变。
- Engineer 的最小提示契约允许在普通对话中建议 Goal/Automation：需要脱离当前对话持续推进且具有可验收终点的工作才建议 Goal；只有用户表达明确的一次性/周期性时间触发意图时才建议 Automation。建议必须是一句非阻塞选择，忽略或拒绝后继续当前 Session，同一意图不得反复建议。
- 用户直接提出创建请求时立即读取相应 Skill；Agent 主动建议时，用户接受建议后读取相应 Skill。Skill 必须只在必要信息不清楚时提问，避免固定问卷和冗长流程。
- `goal-create` Skill 在最终确认前明确呈现 objective、acceptance criteria 和 worktree 选择；`automation-create` Skill 明确呈现 name、trigger、action 及所需 location/target Session。缺少任何必填信息时不得调用创建工具。
- 最终创建只发生在用户明确确认最终摘要后的后续 Agent 动作；摘要发生实质变化必须重新确认。这是 prompt/Skill 契约而非 Runtime 自然语言判定。契约测试必须包含“未确认不得创建”“拒绝后继续普通 Session”和“拒绝后不重复建议”三条负面约束。

### AC-03：Goal Draft 与初次 Run 完全硬切

- 从 protocol、Zod schema、state machine、routes、tools、prompts、dashboard、Web、测试和用户文案中删除 Goal `draft` 状态，不得保留隐藏 Draft、内部 Draft 或同义 fallback 状态。
- 删除 `patchDraft`、Draft-only patch 类型、`PATCH /goals/:goalId`、初次 `POST /goals/:goalId/run`、`CreateGoalDialog`、`useCreateGoal` 及所有 `Create Draft` / `Run Goal` 创建流程。
- `goal_create` 改为提交并激活已确认 Goal 的高层工具；Goal 创建后首次可见状态为 `running`，并已持久化稳定的 `mainSessionId`、`startedAt` 和来源关系。
- 用户表示“先不运行”或尚未确认时只保留 Session 对话，不创建 Goal；不存在“只创建 Goal 但稍后手动 Run”的产品/API 路径。
- retry 仍只处理既有 `failed` / `not_done` Goal，不得被复用为旧 Draft 的启动兼容入口。

### AC-04：Goal 创建高内聚、幂等且可恢复

- GoalRunner 是 Goal 初次创建和激活的唯一 production owner；`goal_create` 必须调用 GoalRunner，route/tool 不得分别复制 worktree、Session reservation、状态提交或执行启动顺序。
- GoalRunner 将现有分离的 Draft `create` / `patchDraft` / 初次 `start` 硬切为一个从来源 Session 提交并激活 Goal 的入口；GoalStateManager 只负责领域状态校验和原子持久化。
- commit 原子写入已确认 Goal，并预分配 `goalId` 与 `mainSessionId`；activate 将该稳定 ID 传给 Session 持久化适配器，幂等准备 Goal worktree、创建 `goal_lead` 根 Session 并交给既有执行/continuation 入口，不依赖 Session 层再次随机生成 ID。
- Goal Lead Session 必须满足 `sessionId === rootSessionId === goal.mainSessionId`、`parentSessionId === undefined`、`agentName === "goal_lead"`、`sessionRole === "main"`、`goalId === goal.id`。
- activate 以已提交的 `goalId`、稳定 `mainSessionId` 和现有 execution claim 为幂等边界；同一 Goal 的恢复不能创建第二个 worktree、main Session 或首轮 execution。
- 保留现有效果工具 attempt-before-effect 和 unknown-result 不重放语义；不得为本 Goal 新增通用幂等请求表、creation journal 或 dedupe framework。
- 同一 GoalRunner activate 路径同时用于即时创建和项目启动恢复，并先于 Goal Lead continuation 检查；恢复条件从 Goal、worktree、Session 和 execution 现有事实派生，不新增 creation phase 状态。
- 测试覆盖 commit 后、worktree 后、Session 持久化后发生失败/重启的窗口；恢复必须收敛到一个有效 Goal Lead Session 和至多一个已接受首轮 execution，永久失败则留下可诊断的 `failed` Goal，不得回退为 Draft。

### AC-05：Automation 对话创建保持窄边界

- 新增 Engineer-only `automation_create` 工具；工具只接受现有 Automation 的 name、trigger、action 字段，来源从 ToolExecutionContext 的当前 store 身份导出，并复用现有 Runtime -> AutomationScheduler -> AutomationStateManager 创建路径。
- Automation 及来源关系在同一次 Automation state 原子写入中提交；创建成功后使用现有 Scheduler arm/recovery，不新增 Automation Runner、Agent loop 或创建状态机。
- `createdFromSessionId` 不得被 update API 修改；现有 pause/resume/update/delete/Run now 仍是 UI/API 管理能力，不授予 Agent。
- Automation 创建继续依赖现有效果工具 unknown-result 不重放和 StateManager 单文件原子写入；不得增加 request-level dedupe、创建状态机或新的恢复存储。
- 删除 project-scoped 直接创建 Automation 的旧 POST API 和 Web create mutation；不存在绕过 Session provenance 的生产创建路径。

### AC-06：列表创建入口全部进入 Session

- Goals 页面、Automations 页面、Sidebar 及所有空状态中的 `New Goal` / `New Automation` 都创建普通 Engineer Session、导航到该 Session，并将 `/skill use ...` 作为普通 Session message 启动执行，由 Query Loop 的既有 command 解析生成强制首个 `skill_read` continuation；不得调用只面向 active Agent 的 command endpoint。
- 创建入口不提交 Goal/Automation 资源，不打开 modal/form，也不创建特殊 Session 类型；若启动消息失败，最多留下可继续使用或删除的普通空 Session，不得留下半成品 Goal/Automation。
- 删除 `CreateGoalDialog` 及其测试/样式/引用；Automation 创建表单分支彻底删除，现有编辑能力如保留必须成为明确的 edit-only 组件，不保留 `automation ? edit : create` 双模式 fallback。
- Goal 和 Automation 列表、详情页及既有管理入口继续存在；本 Goal 只替换创建交互，不删除资源导航。
- 浏览器验收覆盖从列表入口进入 Session、完成澄清、确认创建、看到资源出现并点击跳转的完整 Goal 与 Automation 两条用户路径。

### AC-07：Session Context 与双向导航

- 现有 Session Inspector 的 `Context` Tab 增加紧凑 `Related work` 区域，展示 focused Session 创建的全部 Goal 和 Automation；为空时整个区域不渲染，不新增 Tab 或 Draft 卡片。
- 每行展示资源名称、类型和当前状态；Automation 可附带 `nextFireAt`。整行支持鼠标和键盘点击并跳转到对应 Goal/Automation 详情页。
- Goal/Automation 详情页展示 `Created from` 来源 Session 链接；来源已删除时显示 unavailable，资源本身仍可读取、运行或管理。
- 现有执行 Goal 链接与新 provenance 列表分区并明确标为 `Executing Goal` 和 `Created here`，不得把 Goal Lead/Invocation Session 误显示为创建来源。
- Context 数据从现有 Goal/Automation authoritative store 派生，并随现有 `resource.changed` 失效刷新；不得向 Session 持久化反向 ID、增加双写或引入通用关系存储。

### AC-08：无兼容重构、TDD 与最终审计

- Goal 和 Automation 持久化 schema 均提升版本并要求新的 provenance 字段；旧 Goal、旧 Automation state、Draft 数据不读取、不迁移、不补默认值，测试 fixture 全部切到新契约。
- 删除旧 Goal create/start、Automation form create 的 routes、mutations、components、types、exports、tests、文案和死代码；不得保留 deprecated alias、条件 fallback、双写或“临时兼容”分支。
- 核心 provenance、授权、幂等、失败恢复和负面角色边界先有失败测试，再实现生产代码；架构测试证明 Web 仍只依赖 protocol，StateManager 不反向依赖 Web/Server/Agent prompt。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；Goal/Automation 两条浏览器用户路径均完成可视化验收。
- Reviewer 逐项给出 AC-01 至 AC-08 的代码、测试和浏览器证据，并审计 `draft`、`patchDraft`、`CreateGoalDialog`、Goal 初次 `/run`、Automation create form/API、旧 schema fallback 和 Session 反向 ID 缓存；不能只以测试全绿代替验收。
