# Scoped Dashboard And HITL Notifications Plan Goal

## Objective

将 Home 与 Project Dashboard 收敛为同一个按 Scope 投影的工作台，并建立清晰的 HITL 提醒链路：全局与项目表面只负责发现、筛选和跳转，所有回答与权限决策只在所属 Session 中完成。Automation 继续只负责调度，仅派生展示其关联 Session 正在等待用户；不新增 Dashboard、Notification 或 Automation 自有状态源。

## Locked Decisions

- Home Dashboard 与 Project Dashboard 使用同一个 Dashboard 组件和同一信息架构；`global` 展示所有项目，`project` 只过滤当前项目。
- Dashboard 固定按 `Needs attention -> Running now -> Continue working -> Upcoming` 排列；四个 section 始终展示，空 section 使用轻量占位。Todos Board 保持独立，删除 Project 与 Sessions Dashboard placeholder。
- Bell 是 HITL 专属即时提醒入口；Dashboard `Needs attention` 是更广的工作恢复队列，二者不共用成员集合。Project Rail 的全局 Bell 固定放在 Settings 上方；Bell、Project 图标和 root Session 行 Badge 都只统计 attention-visible HITL，root Session 行聚合整棵 Session family。
- Bell 浮层最多预览 10 条 HITL，`requiresInspection` 在前，其后 pending 按 `createdAt` 从旧到新，identity 兜底；`View all` 进入 Home Dashboard 的 `Needs attention`，其中 HITL 仍排在其他异常之前。
- 铃铛浮层、Toast、系统通知、Home Dashboard 和 Project Dashboard 只展示脱敏摘要与 `Open`，不提供 Answer、Allow、Deny 或 Cancel。
- 唯一决策表面是所属 Session 的 Composer 上方：根 Session 直接打开；child HITL 打开根 Session 并聚焦 child。响应被服务端接受后立即从所有投影消失，不等待 Agent 后续执行结束。
- HITL 的权威 owner 仍是 Session，权威存储仍是项目级 HITL Queue；Bell、Dashboard、Automation 和 Badge 都只是现有领域状态的只读投影，不新增 unread 状态、Notification 数据库或第二套同步通道。
- Automation 不增加 HITL owner、`waiting_for_human` 状态或处理 UI。`start_session` 按 Invocation root Session family 派生 `Waiting for you`；`send_message` 只按 target root Session family 表述为 `Target Session needs attention`，不得声称该 HITL 一定由某次 Invocation 引起。
- 项目图标的主点击行为硬切为打开 `/projects/:slug` Project Dashboard；Badge 不是独立小点击目标。旧的默认 `/todos` 行为、placeholder、Dashboard 内完整 HITL 操作卡和兼容路径直接删除。

### Dashboard Section Contract

section 互斥，按 `Needs attention > Running now > Continue working > Upcoming` 去重；同一 owner 只出现在最高优先级 section。

- Session 系候选统一以 `session-family:projectSlug:rootSessionId` 作为 `sectionOwnerKey`；Automation failure/Upcoming 以 `automation:projectSlug:automationId` 作为 key。owner 命中高优先级 section 后，低优先级 owner row 必须移除。
- winning owner 在 `Needs attention` 内的多个 HITL、Goal 或 failure item 按各自 identity 全部保留；只抑制低 section 的 root Session/Automation row，不合并不同待处理事项。

| Section | 精确成员 | 排序 | CTA / 消失条件 |
|---|---|---|---|
| `Needs attention` | attention-visible HITL；root Goal `blocked`/`budget_limited`；Automation 最新 Invocation 为 `failed`；idle root Session 最新 Execution 为 `failed`/`timed_out` | `requiresInspection`、pending HITL、Goal、Automation/Session failure；同类按进入 attention 的时间从旧到新 | HITL/Goal/Session 打开 owner root Session；Automation 打开详情。权威状态离开成员谓词后自动消失 |
| `Running now` | family activity 为 `running` 或 `stopping` 的 root Session | `running` 在前，其后按 root Session `updatedAt` 降序 | 打开 root Session；family 不再 active 后移出 |
| `Continue working` | 其余 idle root Session，按 scope 取最近 10 个 | `updatedAt` 降序 | 打开 root Session；进入更高优先级 section 后移出 |
| `Upcoming` | status 为 `active` 且有 `nextFireAt` 的 Automation，按 scope 取时间最近的 10 个；已在 `Needs attention` 的 Automation 排除 | `nextFireAt` 升序 | 打开 Automation；暂停、禁用、无下次时间或进入更高优先级 section 后移出 |

- Todos 保持独立 Board，不进入四个 section。Goal 作为 root Session 状态显示在对应 Session row，不再形成独立 Dashboard section。
- `paused`/`complete` Goal 不是异常；`cancelled`/`aborted`/`interrupted`/`max_steps` Execution 也不进入 `Needs attention`。MCP/配置错误留在 Settings；表单 mutation 错误留在原操作表面。
- Automation failure 以 `projectSlug + automationId + latestInvocation.id` 标识；只看每个 Automation 的最新 Invocation，任意后续 Invocation 会取代旧 failure，避免历史失败永久堆积或引入 dismiss/unread 状态。
- Session failure 只看 root Session 最新 Execution；child failure 由 root Engineer 消化，旧 failure 在后续 Execution 开始后立即被取代，避免把历史失败变成永久通知。

## Target Architecture

```text
Project HITL Queues (authority, Session owner)
  -> Global SSE snapshot/event
  -> one scoped Web HITL store
       -> global Bell + Toast + desktop notification
       -> Project badges + Session badges
       -> Automation linked-Session attention
       -> SessionDecisionSurface (the only mutation UI)

Session / Goal / Automation projections
  -> DashboardProjectionService.read(global | project) (read-only, no store)
  -> DashboardProjection(global | project)
       -> Needs attention / Running now / Continue working / Upcoming
```

- `DashboardScope = { kind: "global" } | { kind: "project"; projectSlug: string }`。
- `DashboardProjectionService` 通过同一 scope contract 读取现有领域 owner，返回 root Session/Goal + latest root Execution、Automation + latest Invocation 的 presentation-safe read model；它不持久化、不复制领域状态。现有分裂的 Dashboard Session Goal/Automation aggregate API 硬切为这一条查询边界。
- global scope 逐项目隔离读取失败，返回成功项目 rows 与 project-scoped errors；单项目损坏不得阻断其他项目。project scope 自身读取失败则由 Project Dashboard 显示页面错误，不伪造空数据。
- `useDashboardProjection(scope)` 将上述 read model 与 Session family runtime、global HITL Store 组合为四个 section；不得持久化 Dashboard state。全局和项目数据获取差异留在 projection adapter，页面结构不得分叉。
- `DashboardAttentionItem` 是只读 discriminated union；projection boundary 将 ISO 时间统一解析为 `attentionSinceMs: number`。identity/时间固定为：HITL=`hitl:projectSlug:ownerSessionId:hitlId`/`createdAt`；Goal=`goal:projectSlug:rootSessionId:instanceId`/`updatedAt`；Automation=`automation:projectSlug:automationId:invocationId`/`completedAt ?? createdAt`；Session=`session:projectSlug:rootSessionId:executionId`/`endedAt ?? startedAt`。同类按 `attentionSinceMs` 升序、identity 升序兜底；无效 ISO 时间使该项目 read projection 失败，不静默猜值。
- Goal change、root `execution-start/end` 和 Automation `resource.changed` 必须失效对应 scoped Dashboard query；HITL 与 family activity 继续直接应用 global SSE Store。reconnect/reset/lagged 重新读取 read projection，不增加轮询。
- Global SSE/Web read projection 将 Session-owned `HitlView` 丰富为 `projectSlug + hitlId + ownerSessionId + rootSessionId + view`；`rootSessionId` 是只读派生字段，不写回 HITL Queue。所有列表 key、去重、family 计数、Automation 关联、深链和 mutation 回写使用该 scoped projection。
- HITL 精确深链固定为 `/projects/:slug/sessions/:rootSessionId?hitl=:hitlId`；child owner 额外携带 `focus=:ownerSessionId`。Session 在 HITL Store ready 后滚动并聚焦匹配的决策卡；同一 owner 有多个 HITL 时不得只打开列表顶部。
- Automation failure 深链固定为 `/projects/:slug/automations/:automationId?invocation=:invocationId`；详情页数据 ready 后滚动并聚焦该 Invocation。Goal 与最新 root Execution failure 进入 root Session，默认落在最新对话末尾。
- 将共享 UI 明确拆成两种职责：`HitlAttentionList` 只渲染摘要和深链，供 Bell/Dashboard 使用；`HitlDecisionCard` 只在 Session 中渲染完整问题与权限操作。不得通过 prop 组合重新形成可在 Dashboard 操作的万能组件。

## Implementation Plan

1. **收敛 Scope 投影**：建立 `DashboardScope` 与纯 `useDashboardProjection(scope)`；让 `/` 和 `/projects/:slug` 复用同一个 Dashboard 页面结构，并让 Project Rail 点击项目进入 Project Dashboard。
2. **重组 Dashboard**：按 Section Contract 实现四个固定 section、互斥优先级和空 section 占位；删除 Project/Sessions placeholder、独立 Session Goals 区和全局 Dashboard 旧分叉布局。
3. **拆分 HITL 展示职责**：从现有 `HitlInbox/HitlCard` 硬切出摘要列表和 Session 决策卡；统一 scoped identity、排序、计数和深链，删除 Dashboard 上的 mutation controls。
4. **实现持久入口**：在桌面 Project Rail 的 Settings 上方增加全局 Bell，在 Project 图标和 Session 行增加 count Badge；移动端 Compact Toolbar 在 Inspector 按钮前增加 Bell，并以 bottom sheet 展示同一摘要列表。
5. **实现导航与响应闭环**：所有摘要、Toast 和系统通知使用包含 `hitl` 的精确深链进入 owner root Session；child owner 同时携带 `focus`，Store ready 后定位到 Composer 上方匹配的决策卡。响应成功后由现有 mutation + SSE/Store 立即同步所有 count 和列表。
6. **实现实时提醒**：每次连接先用 authoritative `hitl.snapshot` 建立 baseline identity 集合；仅随后出现且不在 baseline/本连接 seen 集合中的 `hitl.event.payload.type === "hitl.request"` 触发提醒。当前 owner 真正处于前台时抑制 Toast；页面 hidden 且用户从 Bell footer 显式授权时发送脱敏浏览器通知。
7. **补异常派生状态**：按已有 Goal、Execution 和 Invocation 状态生成 Dashboard attention row；Automation 列表对多个 `start_session` Invocation 聚合显示 `N Sessions need attention`，详情按 Invocation 展示；`send_message` 只显示 target family 的通用提示。不得增加持久 attention 状态或建立未经证明的 Invocation-HITL 因果。
8. **硬切清理与验证**：删除被替代的 placeholder、默认 `/todos` 跳转、Dashboard 完整 HITL 操作面和旧测试；补齐 store/component/route/notification/Automation 测试，并完成宽屏、移动端和真实 HITL 浏览器验收。

## Non-goals

- 不建设独立 Notification Center、已读/未读历史、全局 HITL 持久化、副本 Inbox 或右侧 Context Inspector 通知面板。
- 不改变 HITL Queue、Tool Batch resume、权限策略、`ask_user` 协议或 Session 执行状态机。
- 不把 Goal blocked、Session failure 或 Automation dispatch failure 并入 HITL 协议，也不为它们触发 Bell、Toast 或系统通知；它们只以各自领域类型进入 Dashboard `Needs attention`。
- 不实现浏览器完全关闭后的 Service Worker Web Push、邮件、Slack、Webhook 或移动推送；本 Goal 的桌面通知只覆盖仍有打开客户端且用户已授权的浏览器。
- 不为旧 URL、旧 placeholder、旧 Dashboard 操作行为或旧组件 API 保留 redirect、deprecated export、feature flag、双写或兼容 wrapper。

## Acceptance Criteria

以下 AC-01 至 AC-09 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：Dashboard 只有一套结构和 Scope 语义

- `/` 与 `/projects/:slug` 渲染同一个 Dashboard 结构和四个同序 section；global 条目带项目身份，project 条目只来自当前 `projectSlug` 且不重复显示项目名。
- Project Rail 点击任一项目进入 `/projects/:slug`；Todos 仍可从项目侧栏进入，但不再是项目默认落点。
- 生产 UI、路由和测试中不存在 `Project Dashboard is not implemented`、`Sessions Dashboard placeholder` 或对应 placeholder 组件。

### AC-02：HITL 投影只有一个权威来源

- Bell、Project Badge、Session Badge、两个 Dashboard 的 HITL rows、Toast、Automation 派生 HITL 状态和 Session 决策卡都从同一个 global HITL Store 读取；不得另建持久化、轮询或局部副本状态源。
- scoped projection 在不同项目出现相同 Session/HITL ID 时仍不冲突；列表 key、去重、family 计数、Automation 关联、深链和 mutation 更新均覆盖此回归测试。
- 只有 `pending` 或 `requiresInspection` 条目属于 `attention-visible`；同一记录在多个表面出现时总数仍只计一次。不得用 `actionable` 指代包含 `requiresInspection` 的集合。

### AC-03：桌面和移动端入口位置确定

- 桌面全局 Bell 位于 Project Rail 的 Settings 正上方且在所有非 Focus Mode 页面可访问；无 attention 时保留 Bell 但不显示 Badge。
- Bell Badge 等于全部项目 attention-visible HITL 数量；Project Badge 等于该项目 HITL 数量；root Session Badge 聚合该 family 的 root/child owner HITL 数量。Goal/Execution/Automation 异常不得进入这些 Badge；三者在 SSE 更新后无需刷新同步变化。
- 移动端 Compact Toolbar 的 Bell 位于 Inspector 按钮之前，点击打开可键盘/触控关闭的 bottom sheet；320px 宽无裁切或横向滚动。

### AC-04：聚合表面只发现和跳转

- Bell 浮层、Home/Project Dashboard、Toast 和浏览器通知只含脱敏类型、标题、项目/Session、等待时间和 `Open`；DOM 中不存在回答输入、Allow、Always allow、Deny 或 Cancel 控件。
- Dashboard 严格执行 Section Contract：四个 section 成员互斥、排序和上限确定，并始终按固定顺序渲染；空栏显示该栏专属的轻量占位。Bell 始终只列 HITL，空时显示轻量空状态，`View all` 进入 Home Dashboard attention 位置。
- 非 HITL attention row 必须显示真实类型并使用所属对象 CTA：Goal/Session failure 进入 Session，Automation failure 进入 Automation Detail；不得伪装成通知或 HITL。
- 普通 pending 使用 warning 视觉；`requiresInspection` 使用 error 视觉，并明确显示需要人工检查而非仍可批准。

### AC-05：所有决策都回到正确 Session

- 根 Session HITL 的任意 `Open` 使用 `rootSessionId + hitlId` 进入对应根 Session，并滚动/聚焦精确决策卡；child HITL 额外设置正确 `focus=ownerSessionId`。同一 owner 同时存在两个 HITL 时，每个 `Open` 必须分别定位自己的记录。
- 只有 Session Composer 上方的 `HitlDecisionCard` 提供 question/permission/cancel 操作；单问题、多问题 Tabs + Confirm、permission 和 manual-inspection 现有语义全部保留。
- 用户响应被服务端接受后，卡片立即从 Session、两个 Dashboard、Bell 浮层和所有 Badge 消失；失败响应保留可操作卡并显示错误，`requiresInspection` 转换会重新出现在 attention 顶部。

### AC-06：实时提醒不重复、不泄密

- `hitl.snapshot` 先建立 baseline；其后首次出现且不在 baseline/seen 集合中的 live `hitl.event + hitl.request` 才产生提醒。snapshot 与 request 交界处重复同一 identity 时不得提醒两次。
- owner 前台谓词固定为：页面 `visible`、窗口 active、project/root route 匹配，并且 owner 是当前 root 或当前 focused child；child A 在前台不得抑制 child B。谓词成立时只出现内联卡，不弹 Toast；页面 hidden 时允许系统通知。
- reconnect snapshot、reload、duplicate live event 和已存在 pending 记录均不产生 Toast/系统通知；测试必须分别覆盖。用户只能通过 Bell footer 的明确按钮请求 Browser Notification 权限，拒绝授权不影响应用内流程。Toast/通知只使用 `redacted: true` display payload，点击精确深链。

### AC-07：Automation 只投影关联 Session attention

- Automation/Invocation 类型、持久化 schema 和状态集合不增加 HITL owner 或 `waiting_for_human`。
- `start_session` 仅在该 Invocation root family 有 attention-visible HITL 时显示 `Waiting for you`；Automation 列表聚合多个 Invocation family 的数量，详情逐 Invocation 展示。`send_message` 仅按 target root family 显示 `Target Session needs attention`，不把 pending HITL 归因为某次 Invocation。
- Automation HITL attention 点击进入关联 Session；Automation 页面不存在 HITL mutation controls。仅最新 Invocation 为 `failed` 时以 Automation 类型进入 Dashboard 并打开 Automation Detail；任意后续 Invocation 取代旧 failure，不新增已读/解决状态。

### AC-08：其他异常保持领域所有权

- Goal `blocked`/`budget_limited`、root Session 最新 `failed`/`timed_out` Execution，以及满足 `latestInvocation?.status === "failed"` 的 Automation 按 Section Contract 进入 `Needs attention`；每条 row 使用稳定的 scoped domain identity。任意更新的 Invocation 都会成为 latest 并取代旧 failure，无论新状态为何。
- 上述异常只从权威 Session/Goal/Invocation 状态派生，不写入 HITL Store、Notification Store 或 Dashboard 持久状态；恢复后无需手动标已读即自动消失。
- `paused`/`complete` Goal、child Execution failure、`cancelled`/`aborted`/`interrupted`/`max_steps` Execution、Automation `pending`/`missed`/`cancelled` Invocation、MCP/配置和局部 mutation error 均不得错误进入综合 attention。
- global scope 中一个项目读取失败时，其余项目 rows 仍正常渲染并显示该 project-scoped error；project scope 自身失败显示明确错误。测试覆盖隔离行为，禁止全局 fail-fast 或把失败降级成空列表。

### AC-09：硬切、自动化验证和浏览器验收完整

- 精确检查证明 Project Rail 项目点击和 active project 被关闭后的默认落点不再是 `/todos`；合法 Todos 路由/侧栏入口必须保留。搜索同时证明不存在 Dashboard HITL mutation controls、placeholder、旧万能 `HitlInbox/HitlCard` 兼容 API、Automation HITL owner/status、通知副本 store 或 fallback wrapper。
- 定向测试覆盖 Dashboard global/project scope、四 section 分类/互斥/排序/上限、scoped identity/count、Bell HITL-only、Badge、深链、Session-only controls、Toast dedupe、Notification permission、Goal/Execution/Automation attention 恢复条件和 320px bottom sheet。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 真实浏览器必须覆盖可由公开产品流程构造的核心闭环：global/project Dashboard scope 切换与四栏空占位；Bell 位于 Settings 上方且仅计 HITL；真实 Session `ask_user` 产生 Bell/Project/root Session Badge；摘要深链聚焦精确决策卡；回答后卡片、Badge、Bell 与 Dashboard 同步清零；owner 前台抑制、已有 pending 在 reload/reconnect 后不重复提醒；desktop 宽屏与 320px/390px 移动端；bottom sheet 内按 Escape 后焦点回到 Bell；console error 为 0。
- 无法由公开产品流程确定性制造，或依赖当前测试浏览器不具备的宿主 API 的组合态，必须由真实 React/JSDOM 交互 fixture 与纯投影测试机械覆盖：跨项目同 ID、同 owner 多 HITL、root/child focus 矩阵、失败响应、`requiresInspection`、Notification default/granted/denied/hidden/click、Goal blocked/budget、Session failure、Automation failure/recovery、多 Invocation/target family。不得为了人工 QA 在生产代码增加 debug route、seed API、mock 分支或测试状态入口。
