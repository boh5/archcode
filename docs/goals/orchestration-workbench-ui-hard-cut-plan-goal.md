# Orchestration Workbench UI Hard-Cut Plan Goal

## Objective

以 `docs/web/orchestration-workbench-demo.html` 为视觉与交互基准，把现有 Web UI 从“平铺聊天记录”重构为适合长期运行、多项目、多工作并行的编排工作台，同时只使用产品已经存在的 Dashboard、Session、Execution、Goal、Queue/Steer、HITL、Delegation、Tool、Diff 与 Context Inspector 能力。

本 Goal 只重构 Web 信息架构与呈现层，不新增产品功能，不改变现有主题色，不新增 Protocol/Server API，也不修改持久化契约。唯一跨出 Web 的改动是把 Agent Core 内部 Compression 状态在既有 Session 读取边界投影为已经存在的 `CompressionStateSnapshot`；它不改变写入结构或领域语义。被替代的平铺 transcript、Queue 气泡、Agent 头像/色条和旧布局直接删除，不保留 feature flag、fallback、兼容 wrapper 或双渲染路径。

## Locked Product Decisions

- Home Dashboard 继续负责跨项目分流；Project Dashboard 继续使用同一 scoped projection 与四个固定 section：`Needs attention`、`Running now`、`Continue working`、`Upcoming`。不新增 `All work`、Workflow、Review 或 Notification 数据模型。
- 进入 `/projects/:slug` 时，Project Bar 与 Project Sidebar 保持挂载和当前状态，只替换工作画布；Dashboard 占用原中心栏和 Inspector 所在空间，不整页刷新，也不另建 Dashboard Inspector。
- Session 主画布从平铺消息流硬切为 `Execution Workstream`。每个 Execution 卡片包含该次用户输入、Agent 输出、Tool calls、Delegation 和结果；历史 Execution 默认折叠，当前或最新 Execution 默认展开。
- Execution header 只显示编号、状态、耗时、标题以及真实的 Tool/Child 数量；不显示 `User message`、`Delegated prompt`、`Instruction`、`Lead output` 或其他重复内容类型标签。
- 用户消息位于右侧气泡；Agent 消息位于左侧，使用普通正文，不使用头像、气泡、彩色侧边线或常驻标题。正文下方仅保留轻量的 `Agent · Profile · 时间` 元信息。
- `delegate` 是一种特殊 Tool call。父 Session 只显示委派请求、Child 状态、必要元数据和打开 Child Session 的入口，不复制 Child transcript，也不把 Lead/Build/Analyst 渲染成独立流程节点。
- Tool call 继续支持逐项展开完整 input、output、error、process、Ask User result、Diff 和 artifact output；批量只读工具可先聚合，但展开后每个 Tool 仍可独立展开。
- Composer 是当前 root Session 的底部控制台，顺序固定为 `Goal -> Queued messages -> HITL -> Input`。Goal 为单行；每条 Queue 独占一行；HITL 直接显示可操作内容；三者都不得用折叠摘要增加一次打开步骤。
- Context Inspector 继续使用 `Agents / Changes / Context` 三个 Tab；Agent family 用文本、缩进和状态表达层级，不使用 L/B/A 方块或任何 Agent 头像。
- 沿用现有 CSS theme tokens、深色背景、语义状态色、字体与 Diff 配色；本 Goal 不重做品牌色或引入第二套主题。
- 历史 Session 数据在部署前直接移除；本 Goal 不读取、迁移、修复或兼容旧 Session。新版本运行时产生的合法无 ID activity 仍按下文 contract 展示，非法新数据仍显示 typed diagnostic。
- Workstream 首次进入时只展开当前 `running` 或最新 Execution，历史 Execution 默认折叠；用户手动开合状态只在当前 route mount 生命周期内保留，不持久化为 Session 数据。
- Composer Dock 总高度在桌面不超过 `min(60dvh, 640px)`，在 `<800px` 窄屏不超过 `min(70dvh, 620px)`；Goal 与 Input 始终完整可见，Queue 与 HITL 各自内部滚动且不聚合条目。
- Goal budget 保持现有产品权限：仅 `budget_limited` 状态可通过 Edit Dialog 调整或移除；本 Goal 不允许 active/paused/blocked Goal 提前改预算。
- 超长 Session 本次只解决 Web DOM 成本：折叠 Execution 的 body 不挂载，并加入大数据量 fixture 验证；不新增 Server 分页、归档、按需 projection 或持久化裁剪。

## Target Architecture

```text
RootLayout (persistent shell)
├── ProjectBar
├── ProjectSidebar
├── Work canvas
│   ├── Dashboard(scope)                         # existing scoped read model
│   └── SessionSurface
│       ├── SessionHeader
│       ├── ExecutionWorkstream
│       │   ├── buildExecutionWorkstream(...)   # pure Web projection
│       │   └── ExecutionCard
│       │       ├── user / agent messages
│       │       ├── ToolCard / GroupedToolCard
│       │       └── DelegationCard
│       └── SessionComposerDock
│           ├── SessionGoalRow
│           ├── ComposerQueueList
│           ├── HitlDecisionCard[]
│           └── ChatInput
└── ContextInspector
```

- `buildExecutionWorkstream` 是纯函数，输入为现有 `messages + executions + childSessionLinks + compression snapshot` 以及当前 Session 的 `{ agentName, profile }` 和 Agent descriptors；它只生成 UI view model，不订阅 Store、不写状态、不复制领域对象。root 与 focused Child 分别注入自己的真实 Session identity。
- `ExecutionWorkstream` 只拥有排序、折叠状态、近底部自动跟随、历史阅读位置和卡片渲染；Tool、Delegation、Goal、Queue 和 HITL 的 mutation 仍由现有业务组件/Hook 所有。
- 分组只允许使用权威 `executionId`，禁止用时间邻近或 DOM 顺序猜测归属。同一 Execution 内严格保持 `messages` 权威数组顺序和每条 message 的 `parts` 原顺序；只允许聚合同一 message 内原本连续且符合现有规则的只读 Tool，不得跨 message 或跨非 Tool part 重排。
- Dynamic Compression 从权威 `CompressionStateSnapshot.blocksByRef` 生成稳定 card，没有 `executionId`，必须作为 session-level activity 只出现一次，时间键为 `createdAt`。无 `executionId` 且 parts 全部是 System Notice/Hard Compaction 的合法合成 message 也作为 session-level activity 只出现一次；其时间键为所有 part 权威时间的最大值（System Notice=`createdAt`，Hard Compaction=`compactedAt`）。
- 上述 activity 与 Execution 按时间键升序合并；同时间固定为 `Execution -> System/Hard Compaction message -> Dynamic Compression`，同类再按稳定 message/block identity 升序。它们不触发 orphan diagnostic，也不塞入相邻 Execution。有合法 `executionId` 的 System Notice/Hard Compaction 仍随原 message 留在对应 Execution；非空但未知的 `executionId` 必须进入 `unknown_execution`，不得降级为 session-level activity。
- Projection 仅对缺失/无效关联且不满足上述合法 activity 条件的 user/assistant message 返回 `orphan_message | unknown_execution | duplicate_execution` diagnostic；UI 以可见的 session-level error block 展示诊断和受影响内容，禁止抛弃、重复或猜测归组。
- 现有 `Text / Reasoning / Tool / System Notice / Recovery Notice / Hard Compaction / Dynamic Compression` renderer 继续作为内容渲染边界；Execution card 只改变容器与分组，不复制这些 renderer，也不削减 interrupted、original-range、token/protected、加载失败与重试语义。
- Queue 的唯一显示所有者从 transcript 硬切为 `SessionComposerDock`；`ChatMessages` 的旧平铺投影和 pending/local user bubble 分支删除，不保留隐藏 DOM 或备用路径。
- Agent 身份色如仍用于角色文本，可由 `agent-constants.ts` 单一映射；只为头像、initial 或消息色条存在的 appearance 字段和测试必须删除。
- 不抽象通用 Card framework、Timeline engine 或新的客户端状态机；仅提取 Execution projection、Execution card 和 Composer queue 这三个有明确所有权的边界。

## Plan

1. **锁定 Shell 与 Dashboard**：保留 `RootLayout` 和现有 scoped Dashboard 数据链；调整 Project Sidebar 导航与 Dashboard 画布布局，确保项目切换只更新 Outlet，左侧导航状态不丢失。
2. **建立 Execution 投影**：新增纯 projection，按 Execution record 排序并关联消息、Tool、Child、Compression、Session identity 和状态；锁定原始内容顺序、标题、计数、session-level activity 与 typed diagnostic，并用纯单元测试固定。
3. **硬切 Session 主画布**：以 `ExecutionWorkstream` 替换 `ChatMessages` 平铺 transcript；实现历史折叠、当前展开、Dynamic Compression placement、近底部自动跟随、历史阅读位置、空状态、用户右气泡、Agent 左正文和统一内容栅格，删除旧头像、色条、Queue 气泡与重复标签。
4. **收敛 Tool 与 Delegation**：保留 `ToolCard` 完整 disclosure 能力；将 `DelegationCard` 重构为特殊 Tool call 卡，父层只展示编排关系与 Child 入口，完整 Child 消息继续留在 focused Child Session。
5. **重构 Composer 控制台**：把 Goal 压成一行并将 objective 编辑及当前合法的预算调整放入 Dialog；把全部 queued/steering/sending/retryable 状态移入逐行 Queue list；保持 HITL 直接操作和输入/停止/排队语义。
6. **精简 Inspector 与响应式**：移除 Session family 头像，以缩进、文本和状态保留身份；统一 Execution、Composer 和 Inspector 的间距、边界与窄屏策略，主题 token 不变。
7. **清场与验证**：删除被替代组件、样式、测试和 presentation mapping；补齐 projection、组件、交互、路由与浏览器验收，不保留旧 UI 的 feature flag、alias 或 fallback。

## Non-goals

- 不新增 Dashboard section、工作流状态、任务对象、消息类型、Execution 状态或服务器 API。
- 不改变 Goal 生命周期、Queue/Steer 提交语义、HITL 协议、权限策略、Delegation 生命周期、Tool output finalization 或 Diff 数据契约。
- 不改变 Todos、Automations、完整 Diff canvas、Settings、Project 管理和 Focus Mode 的功能。
- 不为旧 DOM、旧截图、旧 className、旧 Queue 位置或旧 Agent appearance API 保留兼容层；历史 Markdown 文档不属于运行时兼容层，不在本 Goal 中改写。
- 不实现历史 Session 数据迁移、旧 schema 读取或旧 message 到 Execution 的猜测映射；历史数据移除是部署前提，不是本 Goal 的运行时分支。
- 不建立通用 Design System、可配置密度、可拖拽 Execution、跨 Session 合并视图或新的在线/离线同步机制。
- 不解决 Session projection 随运行时间无限增长的网络、内存和持久化问题；若未来需要分页/归档，必须建立独立的数据加载架构 Goal。

## Risks And Mitigations

| 风险 | 影响 | 本 Goal 的控制方式 |
|---|---|---|
| 替换 `ChatMessages` 时遗漏现有 renderer | Reasoning、Recovery、Compression、Tool output 或 Diff 不可达 | 复用现有内容 renderer；AC-04/08 逐类验证，不建设简化副本 |
| 新版本数据关联损坏 | 消息被错误归组或重复显示 | 只认权威 ID；合法 activity 有确定排序，其他异常显示 typed diagnostic，禁止猜测 fallback |
| Queue 与多个 HITL 挤占工作区 | transcript 在桌面或窄屏不可用 | Dock 有确定高度上限；Goal/Input 固定，Queue/HITL 独立滚动且所有条目直接存在 |
| Execution 折叠弱化完整流程感知 | 用户首次进入看不到全部历史细节 | 当前/最新默认展开，每个历史 Execution 独立可展开，Tool 与 Child 入口不丢失 |
| 超长 Session 渲染成本持续增长 | 大量折叠内容拖慢 DOM 与交互 | 折叠 body 不挂载并做大 fixture 验证；Server payload 增长明确留给独立 Goal |
| Hard cut 影响旧 Session | 旧记录可能缺少当前 Execution 关联 | 部署前直接移除历史 Session；不增加迁移、兼容读取或旧数据 fallback |

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：Dashboard 保持现有领域语义且 Shell 不重载

- `/` 与 `/projects/:slug` 继续复用同一个 `Dashboard(scope)` 和现有四 section projection；成员、优先级、排序、CTA 与空状态契约不得改变。
- 从同一项目的 Session、Todos 或 Automations 进入 `/projects/:slug` 时，Project Bar、Project Sidebar DOM 节点保持同一实例，Sidebar 的宽度、折叠状态、当前 Tab 和搜索文本均不重置；只替换工作画布内容。
- Project Dashboard 不渲染 Context Inspector，Dashboard 画布实际占满 Shell 中除 Project Bar/Sidebar 外的可用宽度；不得发生 document reload 或跳到 `/` 再过滤。
- Sidebar 中 `Project Dashboard` 位于 `Todos` 之前；Todos 路由和入口仍可用。

### AC-02：Execution Workstream 分组确定且无伪造数据

- 每个有权威 `executionId` 的 user/assistant message 和 Tool part 只出现于对应 Execution 一次；Child 数量等于该 Execution 内可解析的 `delegate` Child link 数，Tool 数量等于 Tool part 数。
- 同一 Execution 严格按 `messages` 数组顺序渲染，每条 message 严格按 `parts` 顺序渲染；连续只读 Tool 聚合不得跨越另一条 message、Text、Reasoning、Notice、Compression、Recovery 或非只读 Tool。测试使用 `Agent text -> delegate -> text -> tool -> final text` 证明相对顺序完全不变。
- Execution 按 `startedAt` 升序、`id` 升序兜底；编号按当前投影顺序从 1 开始。当前 `running` Execution 默认展开；无 running 时最新 Execution 默认展开；其余默认折叠，用户可独立开合。
- 首次 mount 后，手动开合状态在 root/Child 各自 route mount 生命周期内保留，切离该 route 后不持久化；新出现的 running Execution 自动展开，不把折叠状态写入 Store、API 或 Session 文件。
- 状态、开始/结束时间和耗时只来自权威运行时事实，经统一产品投影显示：未回答的输入检查点显示 `Needs you`；回答后显示 `Input received`，并关联继续执行的 Execution；所有异常终止统一显示 `Stopped` 并保留具体原因，不从 Agent 文本猜测。
- 标题规则固定：`user_message` 使用该 Execution 首条用户文本的首个非空单行摘要；`goal_continuation` 为 `Continue active goal`；`tool_call` 为 `Continue after tool response`；`tool_batch` 为 `Continue after tool responses`。摘要视觉截断但 accessible name/title 保留全文。
- Dynamic Compression 使用权威 snapshot 的 `createdAt`；无 ID 的纯 System Notice/Hard Compaction message 使用其 part 时间最大值。二者与 Execution 合并时，同时间严格按 `Execution -> System/Hard Compaction -> Dynamic Compression` 排序，同类再按稳定 identity 升序；每项只出现一次且不触发 diagnostic。
- 有合法 `executionId` 的 System Notice/Hard Compaction 保持原 message/part 位置；非空但未知的 ID 返回 `unknown_execution`。其他普通 user/assistant message 的缺失 ID、未知 ID 和重复 Execution ID 分别返回 `orphan_message`、`unknown_execution`、`duplicate_execution`；受影响内容只出现一次并由可见 error block 承载，其他合法 Execution 继续显示。

### AC-03：消息视觉和对齐符合 Demo

- 所有用户消息保持右侧气泡；所有 Agent 消息保持左侧普通正文。Session 主画布、Child focus 和历史 Execution 中均不存在用户/Agent 头像、Agent 气泡、Agent 彩色侧边线或 L/B/A initials。
- Agent 元信息固定显示在正文下方，内容为实际 `displayName · profile · relative/absolute time`；不得增加 `Instruction`、`Output`、`User message`、`Delegated prompt` 或逐条 `Lead output` 标签。
- root 与 focused Child 的 displayName/profile 必须来自各自 Session snapshot 与 Agent descriptors，不得从 Tool 文本、模型 binding 或父 Session 猜测。canonical user 的 model invalidation 提示/Details 和每个 Execution 的真实 model binding 仍可查看。
- 桌面计算布局中，同一 Execution 的 Agent 正文、Delegation card、Grouped Tool card 左边界误差不超过 `1px`；用户气泡与全宽 Tool/Delegation card 右边界误差不超过 `1px`。
- Execution rail 与 Composer rail 左右边界误差不超过 `1px`；320px、390px、双侧栏展开和 Focus Mode 下均无 document/transcript 横向滚动。
- 用户距 workstream 底部不超过 `100px` 时，streaming part、Tool 状态或新 Execution 更新后自动保持底部可见；距离超过 `100px` 时，任何 live update 均不得改变当前 `scrollTop`。重新回到底部后恢复自动跟随。
- `executions`、`messages` 和 `compression.blocksByRef` 同时为空时只显示一个明确的 `No executions yet` 空状态，不生成占位 Execution card；空状态与 Composer 可同时使用。

### AC-04：内容、Tool 与 Delegation 信息完整

- Text Markdown、Reasoning disclosure、interrupted badge、System Notice、Recovery Notice、Hard Compaction 和 Dynamic Compression 均保留当前内容与交互语义；Dynamic Compression 的 token/protected 状态、original-range 加载成功、加载失败和 Retry 全部可达。
- 上述 part 必须留在原 message/part 顺序中；Execution 折叠只控制整个卡片内容可见性，展开后不得出现第二套简化 renderer。

- 单个 Tool 折叠行保留状态、工具名、主要目标和必要摘要；展开后现有 input、output preview、error、process、Ask User result、Diff、unknown result 与 artifact viewer 全部可达，不能因 Execution 折叠重构丢失。
- Grouped Tool 折叠时显示真实数量；展开后每个 Tool 仍有独立 disclosure，任一 Tool 展开不会强制展开其他 Tool。
- `delegate` 在父 Execution 中只渲染一张特殊 Tool card，包含真实 Agent、Profile、Skills、foreground/background、目标、Child 状态和 `Open child session`；这些字段缺失时省略对应行，不伪造默认值。
- Delegation card 不显示 Agent 头像，不复制 Child 消息/Tool 列表；打开 Child 后仍可查看该 Child 的完整 Execution Workstream，并可返回原 root Session 与原滚动位置。

### AC-05：Composer 是直接可操作的 Session 控制台

- Dock 顺序固定为 Goal、Queue、HITL、Input；不存在另一个 transcript Queue、浮动 Queue 面板或折叠后的 `N queued` 入口。
- Dock 计算高度在 `>=800px` 时不超过 `min(60dvh, 640px)`，在 `<800px` 时不超过 `min(70dvh, 620px)`；Goal 与 Input 使用 `flex-shrink: 0` 且始终完整可见。Queue 高度最多为桌面 `160px`、窄屏 `116px`，HITL 使用剩余空间；二者溢出时各自纵向滚动，禁止整个页面因 Dock 增高而失去 transcript。
- Goal 有且仅有一行摘要，按钮矩阵固定为：`active = Edit / Pause / Clear`；`paused = Edit / Resume / Clear`；`blocked = Edit / Resume / Clear`；`budget_limited = Edit / Clear`；`complete = Clear`。不得出现额外展开层或行内表单。
- 非 complete Goal 的 Edit 打开 Dialog 并可编辑 objective；只有 `budget_limited` 的 Edit Dialog 同时显示现有 token budget 调整/移除操作。所有 mutation loading/error、generation conflict 和保存后的状态转换由现有 API 语义决定。
- 每条 durable queued/steering message 独占一行并显示内容摘要、请求模型、状态和当前合法操作；queued 的 Steer/Edit/Delete 不经过额外展开。local sending/retryable 也逐条显示，retryable 可直接 Retry；任一状态只在一个表面出现一次。
- Queue 行不因数量合并或折叠；超出可用高度时只允许列表内部纵向滚动。Edit 后内容、revision 与 requested model 行为保持现状；Delete/Steer 成功后该行立即按权威 Store 更新。
- permission、单问题、多问题和 `requiresInspection` HITL 均直接显示完整当前操作，不需要先展开；同时有多个 HITL 时逐项显示。响应成功/失败、精确 `hitl` focus 和 child owner focus 行为保持现状。
- Input 在 idle 时发送、running 或等待 HITL 时排队、stopping 时禁用；现有 Model Picker、slash commands、Enter/Shift+Enter、Stop 和错误反馈全部保留。

### AC-06：Inspector 和 Header 不丢失现有能力

- Session Header 保留 title、Goal status、cwd/worktree、Execution/Model 信息、Todo progress 与 Inspector toggle；窄屏可隐藏次要元数据，但不得隐藏标题、运行/HITL 状态和必要入口。
- `Agents / Changes / Context` Tab、键盘左右/Home/End 导航、URL `inspector` 参数、Changes 到完整 Diff canvas 的入口和 Context 数据保持可用。
- Agent tree 用文本、缩进、role/profile/status 表达 root/child 层级；生产 DOM 中不存在 `.agent-avatar`、Agent initial 方块或只为头像服务的 appearance mapping。

### AC-07：Hard-cut 与架构边界完成

- `ChatMessages` 的旧平铺 renderer、pending/local message bubbles、Agent border renderer 和旧 Queue tests 被删除或由新组件完全替代；生产包中不存在两套 Session transcript、双 Queue 所有者或基于 flag 的切换。
- 生产代码不存在历史 Session migration、legacy schema reader、旧 message 归组 heuristic 或兼容 feature flag；部署前历史数据移除不通过产品代码实现。
- Execution view model 由纯函数生成并有独立单元测试；React 组件不得重新实现分组、计数、标题、顺序、diagnostic 或排序规则，不新增第二个 Session Store 或持久化 UI 状态源。
- Protocol、Server 路由和 `.archcode/runtime` schema 无变更；Agent Core 只允许在既有 Session 读取投影中把内部 Compression 状态转换为既有 Protocol 展示结构。除此之外若公开数据不足以满足任一 AC，必须停止并请求产品/架构决策，不能添加 heuristic、fallback 或伪造字段。
- 新组件只围绕 Execution projection、Execution card 和 Composer queue 三个业务边界；不得引入通用 Timeline/Card framework 或跨页面 UI engine。
- 折叠 Execution 的 body 不得挂载到 DOM；初始状态只有当前/最新一个 body。使用 `1,000 executions + 10,000 messages + 20,000 parts` fixture 时仍只挂载已展开 body，禁止用预渲染后 CSS 隐藏冒充折叠优化；本 Goal 不新增分页 API。

### AC-08：自动化与真实浏览器验收完整

- 单元/组件/交互测试覆盖四种 Execution origin、全部 Execution status、内容原序、三种 workstream diagnostic、历史折叠、Dynamic Compression placement/tie-break/唯一性、无 ID System Notice/Hard Compaction placement/唯一性/无 diagnostic、带合法及未知 ID 的 activity message、Reasoning/interrupted/Recovery/Hard Compact、Dynamic Compression original-range 成功/失败/Retry、100px 自动跟随边界、历史 scrollTop 保持、空 Session、Tool/Delegation disclosure、root/Child identity、Child 往返、Goal 五状态按钮矩阵与 Dialog、Queue 全状态与操作、permission/单问题/多问题 HITL、Inspector keyboard 和 Dashboard shell 保持挂载。
- 定向测试还必须覆盖 Dock 两档高度上限、Goal/Input 不收缩、Queue/HITL 独立滚动、历史开合只保留于 route mount，以及 `1,000/10,000/20,000` fixture 下折叠 body 不挂载。
- `bun run typecheck`、`bun run test`、`bun run web:build`、`git diff --check` 全部退出码为 0。
- 真实浏览器使用公开产品流程创建并验证：至少 3 个 Execution、1 次 delegate、可展开 Tool details、2 条 queued message、active Goal、permission HITL 和多问题 HITL；逐项证明消息归组正确、Child 可往返、Queue/HITL 直接操作且响应后同步消失，并验证近底部自动跟随、阅读历史时不抢滚动和空 Session 状态。
- 浏览器矩阵至少覆盖 1440px、1024px、390px、320px，以及 Project Dashboard、root Session、focused Child、Inspector 开/关和 Focus Mode；所有页面无横向溢出、无不可达操作、console error 为 0。
- 生产代码搜索证明不存在 `User message`/`Delegated prompt` header 标签、Agent 头像/initial、旧 Agent message 色条、transcript Queue bubble、旧 flat transcript fallback、deprecated alias 或兼容 wrapper。
