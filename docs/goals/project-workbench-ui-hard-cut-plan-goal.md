# Project Workbench UI Hard-Cut Plan Goal

## Goal

把 `design-system/MASTER.md`、五个页面规范和当前有效原型真正落到 ArchCode 产品中：全局 Home 只负责跨项目注意力与恢复；进入项目默认看到 Todos；项目内固定使用 `Todos / Automations / Sessions` 顶部导航；Todo 是 PRD、Plan、讨论与执行的长期锚点；Session 继续是可直接创建、可独立恢复、可深度检查的执行工作台。

本 Goal 是一次硬切。旧 Project Dashboard、持久 Project Sidebar、Sidebar 内 Sessions/Automations 列表、重复搜索入口和旧来源字段直接删除，不保留 feature flag、双渲染、兼容 wrapper、旧 API alias 或墓碑测试。除下文明确列出的必要领域契约外，不新增工作流层级、Todo 状态或通用框架。

## Locked Product Decisions

- `/` 是唯一全局 Home；不再存在 Project Dashboard。打开项目进入 Todos。
- Project Rail 始终保留；项目内用一个 48px `ProjectToolbar` 展示项目身份、`Todos / Automations / Sessions` 和项目操作，不再渲染第二列 Project Sidebar。
- Todo-driven 不等于 Todo-only：`Save` 只记录 Idea；`Run now` 创建最小 Todo 并立即启动绑定 Session；Sessions 页仍允许直接创建不依赖 Todo 的长期 Session。
- Plan 仍是 `.archcode/plans/<todo-id>.md` 普通 Markdown 文件，不新增 Plan ID、状态、数据库、页面或 Goal 外键；Todo Detail 只读取和展示它，编辑仍由 Discussion/Agent 完成。
- Session 的创建来源必须稳定且可验证：只有 `Direct`、`Todo`、`Automation` 三类。Automation 后续向已有 Session 发送消息不会改写该 Session 的创建来源。
- Automations 页的 `New Automation` 使用产品内表单直接创建 Automation；生产实现使用现有 once/interval/cron 结构化输入，不实现自然语言 Schedule 解析器。Automation definition 不新增 Agent/Profile 字段或选择器：`start_session` 固定创建 `Lead + principal` root Session，`send_message` 保持目标 Session 已有身份。现有两种 action 都保留。
- 历史 project runtime 数据由用户在首次运行硬切版本前自行删除，包括 Session、Automation 和 Todo state；本实施不读取、迁移、备份或清理历史数据，也不增加 fallback、双 schema 或墓碑测试。
- Session Detail 继续保留完整 Execution Workstream、Composer、HITL、Goal、Agent Tree、Changes、Context 和右侧 Inspector；本 Goal 只调整其外层导航、标题和来源信息，不重做执行内容模型。
- 设计权威顺序保持为 `MASTER.md -> pages/*.md -> 当前产品行为 -> prototypes/*.html`。原型中的演示计数、localStorage 数据和简化输入不进入生产产品。

## Target Architecture

```text
RootLayout
├── ProjectBar                         # Home / projects / global search / Needs you / settings / theme
├── Global Home                       # only at /
└── ProjectLayout                     # only under /projects/:slug
    ├── ProjectToolbar                # project identity + Todos / Automations / Sessions + actions
    └── Outlet
        ├── ProjectTodosRoute
        ├── ProjectAutomationsRoute   # list/detail workspace
        ├── ProjectSessionsRoute      # complete root execution inventory
        └── SessionRoute              # Execution workbench + Context Inspector
```

- `RootLayout` 只拥有全局 Rail、全局 overlay、HITL toast 和 Session Inspector placement。
- `ProjectLayout` 只拥有项目身份与项目级导航；各 inventory route 只拥有自己的 filter、selection 和实体操作。
- `GlobalWorkReadService` 是无持久状态的全局读取边界，提供互相独立的 `readHome()` 与 `search(query)`：两者共享按项目并行收集与领域判定，但使用不同 DTO，避免打开 Home 时传输 Todo body 或完整 inventory，也避免浏览器对每个项目发 N+1 请求。
- 项目级 Sessions/Automations inventory 分别由 Server 一次返回 root Session + latest Execution、Automation + latest Invocation；Web 只把这些 DTO 与现有 HITL/SSE live projection 合并，不逐行补请求。
- Home、全局搜索、Sessions 和 Automations 各自拥有页面内纯 projection 函数；只共享 `hasUnresolvedHitl`、Execution activity、latest record 等原子事实谓词，不新增通用 `WorkState`、`WorkItem` 或跨页面 classifier，也不把 UI 分组写回 Store/API。
- 共享组件只提取交互完全相同的 `ProjectToolbar`、`WorkSearchDialog` 和现有 control/status primitive；Todos、Sessions、Automations 的本地 filter 留在各自 route，不预建 `EntityFilter` 或通用 Card/Page/Workflow framework。

## Required Contract Hard-Cut

### Root Session source

以一个严格 union 取代 `projectTodo`：

```ts
type RootSessionSource =
  | { kind: "direct" }
  | { kind: "todo"; todoId: string; entry: "discussion" | "work" | "automation" }
  | { kind: "automation"; automationId: string; invocationId: string };
```

- 每个 root Session 必须有且只有一个 `source`；delegated child 不拥有第二份 source。
- 普通 `POST /sessions` 写入 `direct`；Todo Session 写入 `todo`；Automation `start_session` dispatch 写入 `automation`。
- `GET /sessions` 返回带必填 source 的 root snapshot；Session Detail 从 snapshot 读取来源，禁止通过标题、消息文本或当前 Automation 列表猜测。
- 删除 `ProjectTodoSessionSource`、Session `projectTodo` 字段及全部 producer/consumer；不读取旧 Session schema。

### Automation origin

以严格 union 取代 `createdFromSessionId + projectTodoId`：

```ts
type AutomationOrigin =
  | { kind: "direct" }
  | { kind: "session"; sessionId: string }
  | { kind: "todo"; todoId: string; sessionId: string };
```

- Automations 页直接创建写入 `direct`；普通 Session 中的 `automation_create` 写入 `session`；Todo-bound Automation Session 写入 `todo`。
- origin 创建后不可修改。Todo Detail 的关联 Automation 来自 `origin.kind === "todo"`。
- 删除旧 Automation 来源字段及其运行时分支；不读取旧 Automation schema。

### Inventory projections

- `ProjectSessionInventoryItem` 只包含 root `SessionSummary` 与 latest Execution 的 `{ id, status, startedAt, endedAt? }` 摘要；没有 Execution 时为 `null`。
- `ProjectAutomationInventoryItem` 包含 Automation definition 与完整 `latestInvocation | null`。Server 在一次项目级读取中组装两类 item，列表不允许按行请求 Session store 或 Invocation API。
- HITL、实时 running 和刚结束的状态继续来自现有 project SSE/query invalidation，并与 inventory item 合并；每个页面的纯 classifier 只消费同一事实结构，不依赖另一个页面 API，也不共享页面分组结果。

### New commands and reads

- `GET /api/home`：只返回 Home 四区所需的注意力摘要，不含 Todo body 或完整 inventories；删除 `/api/dashboard`、`/api/projects/:slug/dashboard`、`DashboardScope` 和 project-scope projection。
- `GET /api/search?q=...`：按需扫描注册项目，匹配 Project、Todo、Session、Automation，返回最多 100 个稳定 deep-link 结果及 `truncated`；trim 后 query 必须为 1–200 字符。
- `POST /api/projects/:slug/todos/run-now`：严格接收 `{ clientRequestId, title, body? }`，其中 `clientRequestId` 是 UUID；由 `ProjectTodoService` 完成 `create In Progress Todo -> create bound Lead root Session -> accept first implementation message`，成功后返回 `{ todo, session }`。
- `GET /api/projects/:slug/todos/:todoId/plan`：返回 `{ plan: null }` 或 `{ plan: { path, markdown, updatedAt } }`；只读固定 Plan 路径，不建立 Plan 服务。
- `POST /api/projects/:slug/automations`：严格接收现有 canonical `name + trigger + action`，不接受 Agent/Profile；Server 固定写入 `origin: direct`，客户端不能伪造 origin。
- 现有 Automation update/pause/resume/delete/run-now 与 Invocation API 保持；更新只改 definition，不改 origin。

## Implementation Plan

1. **同步设计契约并硬切 Protocol 与持久化身份**
   - 先把已确认的决定同步到 `design-system/pages/automations.md` 与 `design-system/prototypes/automations.html`：删除 Agent/Profile 选择器或可编辑暗示，显示 `start_session` 固定 `Lead + principal`；补充 `Inactive` 分组，并删除 Automation 层的 `Completed` 推导。再实现产品代码。
   - 增加 `RootSessionSource`、root summary 和 `AutomationOrigin` 契约；更新 Session/Automation schema、store hydration、Runtime 创建入口和 tool context。
   - 所有 root Session 创建路径显式写 source；Automation dispatcher 把 automationId/invocationId 传到 Session gateway。
   - 删除 `projectTodo`、`createdFromSessionId`、`projectTodoId` 及只为旧字段存在的 helper/fixture；不加数据迁移、兼容解析或旧字段拒绝测试。

2. **建立组合命令与读取投影**
   - 将 Todo `Run now` 收敛到一个 application service 方法和一个 HTTP command；Web 不允许串联 create/update/create-session 三次 mutation 冒充成功。
   - 在 Todo runtime state 保存成功 command receipt `{ clientRequestId, requestHash, todoId, sessionId }`，并用项目内 in-flight 去重覆盖并发请求；同 key/同 payload 返回原结果，同 key/不同 payload 返回 409，失败且补偿完成后允许同 key 重试。不建设通用幂等/事务框架，也不声称进程崩溃级原子性。
   - application-level 失败执行定向补偿：删除本次未成功启动的 Session 和新 Todo，并返回原始错误；不建立通用事务框架。
   - 增加只读 Todo Plan adapter、两个 project inventory DTO，以及全局 `GlobalWorkReadService.readHome/search`；每个项目读取失败隔离为 project error，不拖垮其他项目。
   - 增加 direct Automation create route，复用现有 Automation schema/scheduler，不复制 schedule 校验。

3. **重构 Router 与 Shell**
   - 改成 nested `ProjectLayout`；`/projects/:slug` 使用 replace navigation 到 `/projects/:slug/todos`，所有 ProjectBar/Add Project/Close Project 成功路径直接指向 Todos。
   - 删除 `Sidebar`、`SidebarToggleButton`、Sidebar resize/mobile drawer、Sidebar width/collapse preference 及对应测试；Workbench preference 只保留 Inspector width/collapse。
   - RootLayout 保留 52/48px Project Rail 和 Session Inspector；项目 inventory 不渲染 Inspector。
   - ProjectBar 使用明暗主题 rail token；底部顺序固定为 Search all work、Needs you、Settings、Theme。

4. **实现 Home 与全局搜索**
   - 把 Dashboard UI/命名硬切为 Home，固定四区：`Needs you / Running / Ready to review / Upcoming`，删除 `Continue working`。
   - `Ready to review` 的唯一判定：Todo 未归档、状态为 `in_progress`、至少有一个 Todo `work` Session、没有关联 family running/HITL，且最近更新的 work Session 最新 Execution 为 `completed`；Direct Session 不进入该区。
   - 注意力优先级为 HITL inspection、HITL、blocked/budget Goal、failed/timed-out Session、failed Automation；同一 owner 不得同时出现在 Needs you、Running 或 Ready to review。
   - Rail 搜索按钮与 `Cmd/Ctrl+K` 打开同一个 dialog；结果覆盖 Project、Todo、Session、Automation，显示项目与实体类型，并生成稳定实体 URL。不得在 toolbar 或页面右上角增加第二个全局搜索。

5. **实现 Todos 页面**
   - 用 `ProjectToolbar` 取代旧 Todos header；页面主体从 `Filter Todos + Board/Rejected/Archived` 开始。
   - Filter 匹配 ID、title、body 和可见关联元数据；Board 始终保留四 lane 并更新可见 count，Rejected/Archived 只过滤当前列表。`q`、`view` 与 `todo` 使用 URL search params，浏览器返回后恢复。
   - Quick Capture 提供 `Save` 与唯一主按钮 `Run now`：Save 只创建 Idea；Run now 只调用组合 command，成功后直接打开返回的 Session，失败时留在输入处并展示可恢复错误。
   - 保留 DnD、键盘移动、全部 lifecycle action、Discussion/Plan 协调、多个 Sessions/Automations 关联；Todo body 以 Markdown 阅读、textarea 编辑。
   - Drawer 展示 Plan Markdown/empty/loading/error、linked Discussions/work Sessions/Automations 和当前动作。Todo deep link 找不到实体时显示明确 Not Found，不回退到第一条 Todo。

6. **实现 Automations 工作区**
   - 合并 list/detail 为一个 route workspace：desktop 同时显示列表与选中详情；`<=840px` 选中详情替换列表并提供返回。URL 仍使用 `/automations/:automationId`。
   - 列表按 `Needs attention / Scheduled / Paused / Inactive` 互斥分组；latest Invocation 为 failed/missed 时无论 definition status 都优先进 Needs attention；其余 active 进 Scheduled、paused 进 Paused、disabled 进 Inactive。行内只显示 Automation status 与真实 latest Invocation 状态；`dispatched` 不等于工作完成，最终执行结果进入对应 Session 查看。
   - New/Edit dialog 使用结构化 trigger/action 字段、就地校验、pending/error 和 unsaved-close 防护；不显示 Agent/Profile 选择器，`start_session` 只读提示固定 `Lead + principal`。Create 调 direct POST，Edit 调现有 PATCH。
   - `start_session` 的每个 Invocation 打开其唯一 Automation-source Session；`send_message` Invocation 打开精确 target Session + invocation deep link，但不得改写 target Session 原 source。
   - Detail 保留 origin、definition、schedule、actions、attention 和 invocation history；删除 Automation 后其已产生 Session 仍通过持久 source 显示原 automationId，并明确标记 definition unavailable。

7. **实现 Sessions inventory 与 Session Detail 外壳**
   - 新增 `/projects/:slug/sessions`，只列 root Sessions，按 `Needs you / Running / Recent` 互斥分组；完整行可打开精确 Session。
   - `Filter Sessions` 匹配 title、ID、source kind、Todo/Automation 名称；source selector 只有 `All / Todo / Automation / Direct`。filter cluster 左对齐，New Session 独立靠右。
   - `New Session` 创建 `source: direct` 的 root Lead Session并打开详情、聚焦 Composer；Direct 不代表 quick/small。
   - Session Detail 始终激活 Sessions tab；breadcrumb/source 分别处理 Todo、Automation、Direct。Todo/Automation 已不存在时显示稳定 ID 与 unavailable，不伪装 Direct。
   - 移除 Session header 中所有 Sidebar toggle；Context Inspector、focus Child、Diff、Composer 和 Execution Workstream 行为不变。

8. **清场、测试与真实浏览器验收**
   - 删除 Project Dashboard route/component、Dashboard scope API、Sidebar 组件/状态/测试和重复搜索代码；更新仍有价值的行为测试到新 owner，不保留只证明旧路径死亡的墓碑测试。
   - 补齐 Protocol schema、Agent Core service/store、Server route/projection、Web pure projection、route、component、keyboard 和 interaction 测试。
   - 以真实 Server + Web、真实项目数据验证五类页面、创建链路、SSE live state、深浅主题与锁定 viewport；原型只用于视觉对照，不作为运行时 fixture。

## Non-goals

- 不新增 Work/Task/Review 实体、Todo lifecycle 状态、Plan entity、Goal 关系、Automation workflow state 或 Session 类型。
- 不重构 Execution、消息、Tool output、Delegation、Goal、HITL、Queue/Steer、Diff、LSP、权限或 Agent tool filtering。
- 不实现自然语言 schedule parser、持久搜索索引、跨项目写操作、批量 Todo/Session 操作、Session 虚拟列表或通用 transaction framework。
- 不自动给 Direct Session 创建 Todo，也不强制简单工作经过 Discussion/Plan。
- 不删除 Automation `send_message` 能力，不把后续 Automation message 错当成 Session 创建来源。
- 不提供 Plan 直接编辑 API；Plan 继续由 Agent 通过普通文件工具维护。
- 不迁移、备份、清理或兼容旧 project runtime 文件；用户负责在首次运行硬切版本前自行删除历史 `.archcode/runtime/` 数据，包括 Session、Todo state、Automation 及其关联记录。历史 `docs/` 记录不改写。

## Risks And Controls

| 风险 | 控制方式 |
|---|---|
| Source hard-cut 使旧 runtime 数据不可读 | 用户已选择自行删除历史 runtime；实施不提供迁移、清理、兼容 reader、双 schema 或静默 Direct fallback |
| Run now 跨 Todo/Session 两个持久化边界 | 单 application command + 定向补偿 + 故障注入测试；明确不声称进程崩溃级原子性 |
| 删除 Sidebar 后长 Session 不易恢复 | Sessions 成为完整 inventory；全局搜索与精确 deep link 均可恢复，Session Detail 保留 source breadcrumb |
| Home/Search 随项目数据增长 | 独立 Home/Search DTO、按需扫描、搜索结果上限 100、项目错误隔离；本 Goal 不引入持久索引 |
| Direct Automation 扩大 HTTP 写边界 | 复用唯一 Automation schema/scheduler，Server 固定 origin，严格 JSON 且未知字段失败 |
| UI 重排误伤 Session 工作台 | Session 内容组件不重写；route/Inspector/Composer/Workstream 回归测试与浏览器矩阵单独验收 |

## Acceptance Criteria

以下 AC-01 至 AC-09 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：来源契约完成硬切

- 每个新 root Session 的持久文件和 API snapshot 都有且只有一个合法 `source`；Direct、Todo discussion/work/automation、Automation start_session 五条创建路径均有 Agent Core 测试。
- delegated child 不持久化第二个 root source；focused Child 仍通过 root route 保留根来源语境。
- 每个 Automation 都有且只有一个 immutable origin；direct HTTP、ordinary Session tool、Todo-bound Session tool 三条创建路径均有测试。
- Automation definition/API/schema 不含 Agent/Profile；`start_session` dispatch 创建 `Lead + principal`，`send_message` 不改变目标 Session 的 Agent/Profile。
- 生产源码与 Protocol export 中不存在 Session `projectTodo`、Automation `createdFromSessionId/projectTodoId` 的剩余 producer/consumer，也不存在读取旧 schema 后猜成 Direct 的分支。

### AC-02：Shell 与路由只有一套信息架构

- `/` 只渲染 Home；ProjectBar 点击项目、Add Project 成功和 `/projects/:slug` 都最终位于 `/projects/:slug/todos`。
- 任一项目页面只有 Project Rail + ProjectToolbar + canvas；DOM 中不存在 Project Sidebar、Sidebar resize handle、Sidebar toggle 或移动 Sidebar drawer。
- `Todos / Automations / Sessions` 顺序和 active state 在 inventory/detail route 全部正确，tab 不显示普通总数；Session Detail 始终激活 Sessions。
- 只有 Session Detail 可以渲染 Context Inspector；其 280–460px resize、collapse、focus mode 和移动 overlay 行为保持通过。

### AC-03：Home 与全局搜索使用真实跨项目事实

- Home 四区名称、判定、互斥和排序与本计划一致；自动化/Session/Todo/HITL 状态变化后，经 SSE invalidation 或 query invalidation 可在一次刷新周期内移入正确 section。
- `/api/home` 不返回 Todo body 或完整 inventories；`/api/search` 才按 query 扫描四类实体，1/200/201 字符边界、100 条截断和单项目读取失败均有 Server 测试。
- 每一行显示 project + entity context，并打开精确 Todo、Automation、Invocation 或 Session URL；其他项目读取失败只生成该项目 error，不隐藏已成功项目。
- Rail 只有一个 `Search all work` 控件；鼠标与 `Cmd/Ctrl+K` 打开同一 dialog，Escape/关闭后焦点返回触发器。
- 搜索可用 title/name/ID/body/source 匹配四类实体；重复 owner 只出现一次，空结果明确，选择结果后 URL 与实体 ID 一致。

### AC-04：Todo 的记录、执行和 Plan 语义可验证

- Save 成功只产生一个 `idea` Todo，Session 数不变；Run now 成功只产生一个 `in_progress` Todo、一个 `source.kind=todo, entry=work` 的 Lead root Session和一条已接受首消息，并立即打开该 Session。
- 同一 `clientRequestId + payload` 的顺序重试、并发重复和成功响应丢失重试均返回同一 todoId/sessionId，实体数不增加；同 key 不同 payload 返回 409。补偿完成的失败请求可以使用同 key 重试。
- 对 Todo 写入、Session 创建、首消息接受分别做故障注入：HTTP 返回失败时 Web 不导航、不显示成功；补偿成功后没有本次新增的 orphan Todo/Session。补偿自身失败必须返回含 todoId/sessionId 的 typed recovery error，不得静默成功。
- Board/Rejected/Archived、DnD/键盘移动和所有既有 workflow/lifecycle action 均保留；过滤后四 lane 仍存在且 count 等于可见卡片数。
- Todo deep link、Markdown body、Plan exists/empty/error、Discussion/work Session/Automation 链接均来自稳定 ID；缺失目标显示 Not Found/Unavailable，绝不打开另一实体。

### AC-05：Automations list/detail 与创建链路完整

- Desktop list/detail、窄屏 list->detail->back、route history、selected row focus 和 filter state 均通过 interaction test。
- `Needs attention / Scheduled / Paused / Inactive` 覆盖所有 Automation status；latest Invocation 为 failed/missed 时包括 disabled definition 在内都优先进 Needs attention，其余 once 触发后的 disabled 进 Inactive。该页面内 pure classifier 与 interaction test 不得产生无分组行，也不得把 `dispatched` 推导为 `Completed`。
- Create/Edit 表单覆盖 once/interval/cron、timezone、start_session/send_message、Server validation error、pending disabled、保存成功和未保存关闭确认；没有 Agent/Profile 输入，start_session 明确固定 `Lead + principal`，且不得把原型的自然语言 schedule 文本直接写入 runtime。
- Automation inventory 一次返回 `latestInvocation | null`；列表渲染与分组期间不会按 Automation 数量追加 Invocation 请求。
- direct Create 返回 `origin.kind=direct`；Todo/Session tool 创建返回对应 origin；Edit、pause/resume/run-now 均不改变 origin。
- start_session Invocation 有唯一 Session/source/deep link；send_message Invocation 仍指向 target Session 且 source 保持原值。删除 definition 后已创建 Session 显示 Automation ID + unavailable，不显示 Direct。

### AC-06：Sessions 是完整且可直接进入的执行目录

- Sessions 页覆盖项目内全部 root Session且不显示 child；Needs you、Running、Recent 互斥，HITL 优先于 running，Recent 按 `updatedAt` 降序。
- Session inventory 一次返回每个 root 的 `latestExecution | null`；分组期间不会按 Session 数量追加 store/API 请求，SSE 更新后 classifier 使用同一 DTO 结构重算。
- title/ID/source/parent-name filter 与四项 source selector 结果正确；搜索框在左、source 紧邻、New Session 靠右，390px 下搜索独占首行且其余控件仍至少 44px。
- New Session 只创建一个 Direct root Lead Session并聚焦 Composer，不创建 Todo、不发送占位 prompt、不使用 Quick/Small/Legacy 文案。
- Todo、Automation、Direct 三类 Session Detail 的 breadcrumb、source label、Sessions active tab 和返回路径全部正确；现有 Workstream/Composer/Inspector 行为测试无回归。

### AC-07：主题、响应式与无障碍达到设计规范

- light rail 使用 warm-neutral tokens，dark rail 使用 graphite tokens；hover/active/border/icon 在两种主题可辨，页面无 raw rail 颜色分叉。
- 在 390、760、1024、1440px 上验证 Home、Todos、Automations list/detail、Sessions、三类 Session Detail：document 水平 overflow 为 0，fixed/sticky 元素不遮挡主内容。
- 所有 icon-only action 有 accessible name；状态不只靠颜色；页面有唯一正确 h1；dialog/drawer 有 title、close、Escape、focus trap 和 return focus。
- 精确指针 control 至少 32/36px，coarse pointer 主要 control 至少 44px；Tab 顺序与视觉顺序一致，所有 filter、tab、row、dialog action 可仅键盘完成。
- `prefers-reduced-motion` 下无非必要循环/位移动效；现有真正 running/streaming 状态仍通过文字或图标可理解。

### AC-08：旧结构已删除且没有伪兼容

- 删除 Sidebar 生产组件及其专属测试、Project Dashboard route/scope/API、Continue working section、Sidebar layout preference 和重复全局搜索入口。
- 不存在 feature flag、legacy prop、deprecated alias、隐藏旧 DOM、旧 route fallback、双 schema reader 或“缺来源即 Direct”的兼容逻辑。
- 不新增只断言旧字段、旧组件或旧 endpoint 已失败的墓碑测试；使用生产源码搜索与新行为测试证明硬切完成。
- 不存在历史 runtime 迁移器、自动清理脚本或备份逻辑；测试 fixtures 只构造新 schema，不保留旧 schema fixture。
- `design-system/MASTER.md` 与五个 page spec 若实施中出现获批偏差，先更新规范再同步产品；prototype 不承担运行时契约。

### AC-09：自动化验证与交付证据完整

- Protocol/Agent Core/Server 测试覆盖 source/origin schema、Todo Run now 幂等与补偿、Automation dispatch、两个 inventory DTO、独立 Home/Search reads、Plan read 和 direct Automation create。
- Web 单元/交互测试覆盖 Home classification/search、ProjectToolbar、三个 inventory filter、Todo capture/drawer、Automation workspace、Sessions grouping/new session 和 Session source header。
- 真实浏览器使用非 mock Server 数据完成：Save Todo、Run now、Direct Session、direct Automation create、Run now Invocation、HITL Needs you、Todo Plan 展示和三个来源 Session deep link。
- `bun run typecheck`、`bun run test`、`bun run web:build`、`git diff --check` 全部退出码为 0；浏览器验收 console error 为 0。
- 交付报告逐项列出 AC-01 至 AC-09 的代码、测试、浏览器截图/selector 和命令证据；未执行的项不得写成完成。

## Deployment Precondition

这是持久化 schema 硬切。用户负责在首次运行实施版本前自行删除各项目旧的 `.archcode/runtime/` 数据（包括 `sessions/`、`todos/state.json`、`automations/state.json` 及其他与旧 Session 关联的运行时记录）；实施代码、脚本和测试均不负责探测、备份、迁移或清理。代码只接受新 schema，遇到残留旧数据直接按无效数据报错，不加入 fallback 或兼容读取。
