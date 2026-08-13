# Signal Workbench UI Conformance Hard-Cut Plan Goal

## Objective

将当前 ArchCode Web 产品硬切到现行 **Signal Workbench**。本 Goal 覆盖共享 Shell、Global Home、Todos、Todo Detail、Automations、Sessions 和 Session Detail；Settings 只做现行规范回归，不主动重做视觉。视觉结构与数值以当前有效 HTML 原型为准，并同步回写 `design-system/MASTER.md` 与现行 page overrides；现有领域行为、状态语义和数据边界继续以产品实现为准。

这不是换色或照抄静态原型。实施必须保留现有领域对象、Route、API、Store、Execution、HITL、Todo lifecycle、Automation invocation 和 Session durability，只替换已经被现行设计系统否定的信息结构与呈现。旧 Board-only Todos、常驻 Todo capture、双 Model/Effort picker、附件重排、Inspector summary chrome 与旧 rail 呈现直接删除，不保留 feature flag、fallback、兼容 wrapper、双渲染路径或只证明旧代码已删除的墓碑测试。

## Authority And Research Evidence

权威按问题类型拆分，禁止用一套总排序掩盖冲突：

1. 视觉结构、间距、尺寸、颜色、排版、响应式几何和可见文案以当前有效的 `design-system/prototypes/*.html` 为准；
2. `design-system/MASTER.md` 与 `design-system/pages/<page>.md` 必须同步到原型，不得保留冲突的视觉数值；
3. 领域行为、状态语义、数据来源、Route、API、Store 与持久化边界以当前产品为准；
4. 原型中的 synthetic data 或演示动作不能覆盖真实产品语义；只有发生实质性功能冲突时才需要产品决策。

本 Goal 基于以下已完成核验：

- 产品代码最后一次相关改动之后，设计系统又变更了 14 个文件，约 `+8918 / -2043` 行；主要增量集中在项目 rail、Todo capture/preview/detail、Session model/attachment/inspector 与跨页 polish。
- 已逐页读取 Master、Dashboard、Todos、Automations、Sessions、Session、Settings 规范，并对照当前 React、API/Protocol 能力和现有测试。
- 已用真实 Runtime-ready Server 与 Chrome 对照当前产品和原型：1440px 的 Home/Todos/Automations/Sessions/Session，1024px 明亮主题，760px Session，390px Todos/Session/New Todo；产品 Console error 为 0。
- Home 已按当前有效原型完成视觉核对；宽屏两两配对、扁平 band、状态 orbit、行密度与微交互均以原型为准并同步到页面规范。原型中的 synthetic counts 或演示 rows 不进入产品数据层。
- UI/UX Pro Max 仅提供 accessibility、focus、reduced-motion 和响应式检查建议；其通用 landing-page 视觉建议不覆盖 ArchCode 设计系统。

## Locked Product Decisions

- Goal 范围为 Shell、Home、Todos、Todo Detail、Automations、Sessions、Session Detail；Settings 只验证现有规范和功能无回归。
- Todo `Result` 的唯一权威来源是最近成功完成的绑定 **Work Session** 最终 Assistant answer；Discussion 不参与。无可信 final answer 时不显示 Result。
- Result Session 选择顺序为 `latestExecution.endedAt` 降序、`session.updatedAt` 降序、`sessionId` 升序；只读取第一个 `latestExecution.status === "completed"` 的 Todo-work Session。
- Result 必须来自该 Execution 的 `finalOutputStepId` 对应、`outputPhase === "final_answer"` 的 Assistant message。Selector 按 message 原顺序返回 `text.trim().length > 0` 且非 interrupted/discarded 的 `assistant-output` parts；Renderer 保留每个 part 的原始 text 并逐块交给 `MarkdownContent`，不 trim、不拼接、不注入分隔符。缺 ID、缺 final message 或 Tool-only completion 均不得回退到 commentary 或任意最后一条文本。
- Todo 尚未 Done 时标题为 `Result for review`；Done 后标题为 `Accepted outcome`。不把 Result 复制进 Todo schema，不新增 accepted-result 状态。
- Todo preview 动作矩阵固定：Idea 的 primary 为已有 Discussion 时 `Continue Discussion`、否则 `New Discussion`，并有 `Open details`；Ready/In Progress 的 primary 为已有 Work Session 时 `Continue Work`、否则 `Start Work`，secondary 为已有 Discussion 时 `Continue Discussion`、否则 `New Discussion`，并有 `Open details`；Done 只有 `Open details`。`New Work Session`、`Create Automation`、Plan 和 lifecycle actions 只属于 Todo Detail，永不进入 preview。
- Home 宽屏继续按当前原型两两配对四个 section；所有视觉数值冲突均以当前原型为准并同步 page override。
- Project rail 顺序只认固定 registration order；切换项目只更新 active state，不调用 `touch`、不按 `lastOpenedAt` 重排，也不把 rail 外的当前项目注入前五项。
- New Todo 的 `Start discussion` 是单一领域命令：一个稳定 `clientRequestId` 只创建一个 Idea Todo、一个绑定 Discussion root Session，并只接受一次首条消息；并发、顺序重试、响应丢失和进程重启都返回同一 Todo/Session。任何无法确认的持久化结果必须返回带精确 Todo ID 与 Session ID 的 `PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED`，不得由 Web 继续两步创建或扫描 Session 猜测结果。

## Confirmed Gap Map

| Surface | Preserve | Hard-cut change |
|---|---|---|
| Shared shell | 单 rail、project toolbar、全局 Search/Needs you/Settings/theme | 固定注册顺序前五项 + More、唯一 monogram、indigo selection、rail tokens、skip link |
| Home | 四个权威 section 与现有 projection、宽屏 2×2 | 卡片感降为 flat bands、完整 operational rows、orbit/hover/密度；不加 metrics |
| Todos | canonical lifecycle、drag mutation、runtime projection、Rejected/Archived | Active List 默认、List/Board、New Todo dialog、desktop preview、命令栏和状态恢复 |
| Todo Detail | Markdown 编辑、References、Plan coordination、Work/Lifecycle actions、deep link | 连续 document + context rail、渐进披露、可信 Result、空 section 清场 |
| Automations | canonical trigger/action/invocation、New/Edit/Run now | 宽屏 list/detail、窄屏 list→detail、四组、Needs you 词汇和 flat rows |
| Sessions | inventory、source、直接创建 Session | 命令栏、1080px flat groups、状态词汇和 responsive placement |
| Session Detail | Execution projection、Tool/Reasoning/Delegation、Dock/HITL/Goal/Queue、Inspector ownership | header、Work wording、single model menu、draft chips、Inspector density/rows/tabs |
| Settings | 全部 recovery/runtime/control-plane 行为 | 无主动重构；只修明确违反现行 Settings 规范的回归 |

## Architecture Contract

### Shared presentation boundaries

- 继续以现有 semantic tokens、`StatusGlyph`、`ActivityArc`、`ProgressRing` 和 status presentation 为唯一状态视觉基础；补齐 `--rail-hover`、`--rail-active`、`--rail-border`，不得在各页面另建 status map。
- 只新增一个窄职责的 shared primary-action primitive，供 `New Todo / New Automation / New Session` 等单一主 CTA 使用。Filter 仍由页面本地拥有；禁止建立 `EntityFilter`、通用 inventory engine、通用 Drawer framework 或第二套 design-system runtime。
- `ProjectBar` 只拥有项目入口、monogram、attention badge、More picker 和底部全局工具；项目导航不写 registry recency，也不通过 route effect 触发 `touch`。
- `>760px` 时 Project marks 按 registration order 最多显示前五个；注册项目数 `>=5` 时显示 More。当前项目若不在前五项，只在 More picker 中显示 `Current`，不得注入 rail 并替换固定入口。`<=760px` 的项目页只显示 active mark + More + Add，Home 只显示 More + Add。可见 monogram 从 project name 派生，在同一注册集内唯一并在 reload 后稳定；More picker 可按 name/slug/path 搜索完整项目集，并显示 workspace path、current-project state 和 project-level Needs-you count。
- 全局 `Skip to work canvas` 进入唯一 `main#work-canvas`；focus、coarse pointer 44px、reduced motion 与 light/dark 全部由 shared shell 保证。

### Page-local ownership

- Home 继续消费现有 `/api/home` projection；不得为视觉稿伪造计数、状态或 demo rows。
- Todos route 拥有 `{ surface, activeLayout, query, selectedTodoId, focusedTodoId, scroll }` UI 状态和本地持久化；List 与 Board 消费同一 filtered/presentation projection，不复制 operational-state 算法。
- Todo preview 是 route-local transient overlay，不成为新 URL、Store 或领域对象；Todo detail 仍是唯一 canonical edit/lifecycle surface。
- Todo Result 通过现有 session inventory 先选中一个 Session，再复用现有 Session detail query 读取该 Session；只允许一个额外 Session 请求，禁止 N+1、Server aggregation、Todo schema 字段或猜测 fallback。最终输出提取做成纯函数并独立测试。
- Automations/Sessions 继续消费现有 inventory DTO；分类、filter、row copy 做纯 Web projection，mutation 和 exact Session links 不移动所有权。
- Session 继续使用现有 Session store、Execution workstream、Model selection mutation 和 attachment upload pipeline。重构只收敛展示与交互边界，不复制 Store 或改变 next-run selection、Queue/Send/Stop、upload/retry/remove 语义。
- Todo capture 的 `Start discussion` 由 `POST /todos/start-discussion` 单一领域命令拥有。Todo receipt 在创建任何 Session 前持久化稳定 request hash、Todo ID 与预分配 Session ID；Runtime 只以该 ID `ensure` 精确 Session，首条消息继续复用 Session input 的 durable `clientRequestId` receipt。只有确认 Session 未持久化，或确认首条消息未持久化且 Session 删除成功时才清理 Todo reservation；持久状态无法确认或补偿不完整时进入 `recovery_required`，Web 只展示精确 retained links。

## Plan

1. **收敛 shared shell 与 tokens**
   - 补齐 rail semantic tokens、skip link 和唯一 work canvas；将 rail active/hover/border 从 `rail-ink` opacity hack 硬切到专用 token。
   - 重构 `ProjectBar` 的 desktop 固定 registration-order 前五项、mobile active-only/Home 规则、稳定唯一 monogram、More picker、attention badge 与底部工具顺序。
   - 删除 route 切换时的 project touch/recency 更新；切换项目只改变 active state，固定入口的内容、顺序与坐标不变。
   - 抽出窄职责 primary-action primitive；不抽通用 filter/inventory/card 系统。

2. **校准 Global Home**
   - 保留宽屏两两配对与现有四 section projection，改成 flat operational bands、thin rules 和 full-width rows。
   - 使用统一 status glyph/orbit、project/entity context、action state/time 和 0.5px hover lift；失败保持 error，Needs you 保持 attention，Running 只在真实 live state 使用 lime。
   - 删除不符合规范的 raised-card 感，不增加 prototype 统计 chips、欢迎语、图表或第二套 Todo inventory。

3. **硬切 Todos inventory、capture 与 preview**
   - 将 route 状态拆为 `Active/Rejected/Archived` surface 与 `List/Board` layout；fresh entry 默认 `Active + List`，返回时恢复 query/layout/surface/focus/scroll。
   - Active List 使用 980px centered flat groups；Board 使用同一 filtered set，在 `>=1100 / 700–1099 / <700` 分别为 4/2/1 列，保留 pointer/touch/keyboard drag 与 canonical PATCH。
   - 删除 permanent capture composer；实现 560px New Todo dialog、`C`、Escape/close focus restore、pending/error 与明确 `Save / Start discussion / Run now`。Save 创建 Idea、关闭 dialog、留在 inventory；Start discussion 原子创建 Idea + bound Discussion 并进入该 Session；Run now 创建 In Progress Todo + bound Lead Session 并进入 Session。
   - Run now 与 Start discussion 都使用稳定的 content-bound `clientRequestId`。保留 `PROJECT_TODO_RUN_NOW_RECOVERY_REQUIRED` 与 `PROJECT_TODO_START_DISCUSSION_RECOVERY_REQUIRED` 的专用部分成功恢复：dialog 留在原位，显示 retained Todo 与 retained Session exact links；同一未修改 content 时三个提交动作都禁用且明确禁止盲重试，只有修改 content 才建立新的 request identity。
   - 实现最多 420px 的非编辑 preview overlay；打开时 inventory 的宽度/对齐不变，并严格使用 Locked Product Decisions 的动作矩阵。preview 不允许 edit、lifecycle、References、Plan mutation。
   - `j/k` 移动当前可见 Todo，Enter 进入 detail，Escape/scrim/close 恢复 origin focus；`<=720px` 直接进入 detail，不渲染窄 preview。
   - Filter 覆盖 ID、canonical content 与当前可见 runtime metadata；Rejected/Archived 保持 centered flat list 与现有 restore 语义。

4. **重构 Todo Detail 为连续工作面**
   - 主列硬切为一个连续 document surface：`Brief / PRD → References/compact starter → Plan/compact starter → Result`；右列硬切为一个连续 context rail：`Work → Sessions → Automations → Lifecycle`，内部只用 heading/rule/spacing。
   - 无 References/Plan 时只显示一个 `Add context when it helps` starter；Sessions/Automations/Result 无数据时完全隐藏，不保留空 card。
   - 保留 Markdown 单编辑器、References 上传安全语义、Plan coordination、Start/Continue/New Work、Discussion、Automation 与 Lifecycle mutation；只重排和重新加权，不删能力。
   - 按 Locked Product Decisions 实现纯 Result selection/extraction；只渲染可信 final answer 和 exact Session link。
   - 保持 direct deep link；从 preview/detail 返回时恢复来源 inventory 状态，直接访问 detail 后返回默认 Active/List。

5. **校准 Automations 与 Sessions inventories**
   - Automations 在 `>840px` 使用 list/detail split；`<=840px` 先 list，选中后同 canvas 显示 detail 并有 back。分组固定 `Needs you / Scheduled / Paused / Inactive`，failure/missed 优先且为 error，dispatched 永不伪装 completed。
   - Automation detail 保留 definition、schedule、action binding、workspace、linked Todo、recent exact Session links、Edit/Run now；New dialog 不暴露 Agent/Profile，`start_session` 只读显示 `Lead + principal`。
   - Sessions 使用 1080px centered flat list，命令栏固定 local filter + source select / far-right New Session，分组 `Needs you / Running / Recent`；Failed 在 Needs you 决策组内仍显示 error。
   - 保留 New Session 直接创建 untitled direct root Lead Session 并聚焦 composer；不制造 Todo、不增加 chooser 或状态 filter。

6. **收敛 Session header、Composer 与 Inspector**
   - Header 第一行保持 title + product status；第二行固定 `cwd · tools · tokens · source`。`<=760px` 隐藏 cwd、分隔符与 source，保留 tools/tokens；Todo live-reference note 仍属于 source。
   - Work suspended row 改为 `Paused · Worked for {duration}`，不在 Work row 重复 Needs you；header 与 Composer 继续拥有 Needs you。运行 pulse 位于 `Working` 之前，折叠/自动跟随逻辑不变。
   - Composer 始终渲染为底部输入 dock；删除 Composer 级收起/展开状态、触发器、Hide 动作和 HITL 专用 collapsed 分支。HITL、Goal、Queue 位于输入区上方，不能隐藏 textarea。
   - 将当前两个 model/variant popover 硬切为单一 `Model display name · effort` trigger 与一个 menu；Model 只显示 display name 和 Default badge，Effort 只显示 free-form key/Default，无营销文案。仅当当前 Session 是 explicit override 时保留现有 profile-default reset 能力。
   - ready/uploaded draft items 改为 file glyph + truncated name + remove-only chip，顺序固定为 attach order；删除 Move earlier/later 和 `moveAttachment`。uploading chip 只显示不可取消的上传状态，Remove 隐藏或禁用；failed chip 显示 error + Retry + Remove；成功后立即收敛为 remove-only。不得用隐藏本地 chip 冒充取消仍在进行的上传。
   - 删除 Inspector 顶部 `Context inspector / Session` summary strip；tabs 直接置顶并显示 Agents/Changes counts。宽屏保持 312px default、280–460 resize；`<=1180px` 为 overlay。
   - Agent rows 删除 L connector、role icon box、大面积 brand wash、skills 第三行和 `<11px` 关键文字；只显示 role/profile、单行 objective、右侧 status。Changes 显示 M/A/D、path、diffstat；Context 保留精确 bindings，不增加 CTA 或第四 tab。

7. **清场、测试与真实 QA**
   - 删除被替代 JSX、view enum、旧 class、dual picker、attachment reorder、summary strip 及对应旧行为测试；测试改写为当前正向合同，不保留 feature flag、alias、fallback、隐藏旧 DOM 或墓碑断言。
   - Settings 运行现有 recovery/runtime/control-plane 测试和窄屏检查；无明确规范偏差则不改。
   - 完成 focused unit/component/interaction tests、全仓验证和真实浏览器矩阵；视觉以当前有效原型为验收并确保 Master/page specs 已同步，不用 prototype synthetic data 代替真实产品状态。

## Non-goals

- 除 Start discussion 所需的窄 wire types、Todo receipt、单一 Server route 与 Runtime Session ensure 适配外，不修改 Todo/Session persisted entity schema、Automation lifecycle 或跨层依赖方向；不新增 Discussion 实体、通用 transaction framework 或 Session 扫描恢复。
- 不新增 Result API、Result persistence、accepted-result 状态、Todo title、Dashboard analytics、状态 filter、第二个 Search 或新 Settings prototype。
- 不重写 Execution projection、Tool renderer、HITL、Goal、Queue、attachment transport、Plan coordination 或 Todo mutation 语义。
- 不建立通用 design-system package、page builder、inventory engine、Drawer framework、Timeline、filter abstraction或可配置密度。
- 不保留旧 Board-first、capture composer、dual picker、attachment reorder、Inspector summary strip 的兼容路径；历史 Markdown Goal 文档不回写。
- 不以静态 prototype 的 synthetic data 或演示-only action 覆盖当前产品状态事实；但原型的视觉结构和数值必须被产品与规范一致采用。

## Risks And Controls

| Risk | Control |
|---|---|
| Todo Result 误取 commentary/失败输出 | 只认 completed work Execution + `finalOutputStepId` + `final_answer` + trusted assistant-output；否则隐藏 |
| Todo detail 为 Result 产生 N+1 | inventory 纯选择后只 fetch 一个 Session；禁止遍历 fetch |
| Start discussion 的两步 Web 创建在响应丢失/重启后重复 Todo 或 Session | 单一领域命令先持久化 request hash + Todo/Session IDs；Session ensure 与首消息 receipt 都复用稳定 ID；并发/顺序/restart/failure-window 测试证明 exactly-once |
| 项目切换造成 rail 跳位 | rail 只按 registration order 投影，切换不得写 recency；真实浏览器比较切换前后每个 mark 的位置 |
| preview 与 canonical route 状态漂移 | preview 只持有 todoId；内容、runtime、action availability 每次由当前 query projection 得出 |
| 视觉重构复制状态算法 | status 继续集中在现有 presentation/StatusGlyph；页面只消费 view model |
| 原型与规范视觉数值冲突 | 当前原型胜出并同步 Master/page；若冲突涉及领域行为、状态语义或数据边界，才暂停请求产品决策 |
| 无真实 Automation/Session 状态导致假验收 | QA 使用隔离注册项目和公开 UI/API 工作流准备完整状态，验收后清理该项目 Runtime 数据 |
| 大范围 CSS 造成 Settings 回归 | semantic token 变更配套 light/dark + Settings 回归；Settings 结构不主动重排 |

## Acceptance Criteria

以下 AC-01 至 AC-09 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01: Shared shell and project rail

- Desktop rail 计算宽度为 52px，`<=760px` 为 48px；底部顺序固定 Search、Needs you、Settings、theme，Home brand 始终可达。
- `<=760px` 的 inventory 与 Todo/Automation detail project toolbar 精确为 81px；Session detail 保留原型的 88px override。边界本身必须实测，不能只验证 759/761px。
- `>760px` 时直接显示 registration order 前五个以内的 project marks；`<5` 时显示全部，`>=5` 时显示前五个加 More。当前项目在前五项外时只在 picker 标记 `Current`，不得挤掉固定入口；`<=760px` 项目页只有 active mark + More + Add，Home 只有 More + Add。
- 同一项目集没有重复可见 monogram；刷新、theme 切换和 active project 改变后同一项目 monogram 与位置不变。当前项使用 indigo selection，不使用 lime；lime 只出现在权威 running cue。
- More picker 可搜索并到达所有项目；每行显示 project name、workspace path、current-project state 和 project-level Needs-you count。desktop/mobile/Home 四类组合均有 focused test。
- 连续切换不同 slug 时，rail 只改变 active state；固定 marks 的内容、顺序和几何位置完全不变，且不产生 project `touch` 请求。
- 所有主要页面提供可聚焦 Skip link，激活后 focus 位于唯一 `main#work-canvas`；生产样式使用 rail semantic tokens，不再以 `rail-ink` opacity 模拟 active/hover/border。

### AC-02: Global Home

- Home 只显示 `Needs you / Running / Ready to review / Upcoming` 四个现有 projection section；保留当前产品 `>=920px` 两两配对，窄屏按固定顺序单列。
- section 是 flat operational band，不是 KPI/Bento card；每行包含 status cue、title、project + entity context、time/action state，并打开 exact href。
- Failed 使用 error，Needs you 使用 attention，Running 使用 live signal，Ready to review 使用 review cue；无状态仅靠颜色。
- 无统计 chips、图表、问候语、New Todo/New Session、全局 filter 或伪造 demo rows。

### AC-03: Todos inventory, capture, and preview

- fresh project Todos entry 为 Active/List；return navigation 恢复 surface、layout、query、focused Todo 和 scroll。命令栏在 desktop 为两组，`<=760px` 为两行，所有控件保持 44px coarse target。
- `List / Board` 与 `Active / Rejected / Archived` 的所有 enabled 按钮都显示 pointer cursor；Board drag activator 在 precise pointer 为 36px、coarse/touch 为 44px。
- Active List 四组 centered `max-width:980px`；Board `max-width:1500px` 且在 `>=1100 / 700–1099 / <700` 为 4/2/1 列。两者 count/filter/operational state 来自同一 projection。
- Board pointer/touch/keyboard drag 继续产生现有 canonical mutation；lane 没有 persistent perimeter，drag activator 没有 permanent vertical-divider 外观。
- 页面不存在 permanent Todo textarea。New Todo dialog 在 desktop 约 560px，具备 C、Escape、visible close、focus restore、pending duplicate prevention 和 inline error。Save 只创建 Idea；Start discussion 通过一个请求创建 Idea + bound Discussion 并导航该 Session；Run now 创建 In Progress + bound Lead Session 并导航该 Session。
- Start discussion 的同一 `clientRequestId + content` 在并发、顺序重试、HTTP 响应丢失和 Runtime 重启后，Todo ID、Session ID 与首消息 receipt 均不变，持久对象数量始终为 1 Todo + 1 Discussion。相同 ID 配不同 content 返回 409 conflict；不存在 `create Todo → create Session` 客户端 fallback。
- Run now 或 Start discussion 部分成功时，dialog 显示 retained Todo 与 retained Session exact links；`recovery_required` 后未修改 content 时 Save/Start discussion/Run now 都不可再次提交并明确说明禁止盲重试，修改 content 后才允许新 request。focused test 覆盖 Session 未创建、Session 已持久化但响应丢失、消息未持久化、消息已持久化但唤醒失败、durability read 不确定、补偿失败与 accepted replay。
- `>720px` 选 row/card 打开 `<=420px` overlay preview；打开前后 inventory content box 的 width 与 left offset 误差各不超过 1px。preview 无 edit/lifecycle/References/Plan control，动作严格为：Idea=`Continue/New Discussion + Open details`；Ready/In Progress=`Start/Continue Work + Continue/New Discussion + Open details`；Done=`Open details`，其中每个斜杠按对应 linked Session 是否存在二选一。scrim/close/Escape 恢复 origin focus。
- `j/k` 在当前 filtered items 间移动，preview 同步；Enter 打开 detail。`<=720px` 点击 item 直接进入 detail，DOM 不挂载 preview。
- Rejected/Archived 保持各自 centered flat lists、reason/state 与现有 restore action；filter 无结果时命令栏仍在。

### AC-04: Todo Detail and Result

- Desktop 只有一个连续 main document 和一个连续 context rail；内部没有 Brief/Plan/Work/Sessions/Automations/Lifecycle card stack。窄屏按 main 后 rail 顺序堆叠且无横向滚动。
- Brief/PRD、Work、Lifecycle 始终可见；References、Plan、Sessions、Automations、Result 仅在有数据时完整显示。References/Plan 都缺失时只有一个 compact starter，只有缺失项动作。
- 顶部 trail 固定为可返回的 `Todos`、`Updated <relative time>` 与 Todo ID；刚更新时显示 `Updated now · <Todo ID>`。生命周期四段是 header 中唯一正常状态移动入口，四段均可点击；右侧 Lifecycle 只保留 Reject/Archive，Archived 只保留 Restore，不再出现 Move/Complete/Mark done 或 Rejected banner 的重复 Restore。
- Todo 展示 lead 只取首个 Markdown heading，否则使用 canonical content 的规范化 80 字符截断；References 固定 36px uppercase file-type tile，不渲染图片缩略图；Plan 是普通 Markdown，页面没有持久化 step state、进度条或交互 checkbox；嵌入 Markdown heading 从 h3 起并封顶 h6。
- Edit、Add/Remove/Open/Download Reference、Generate/Improve Plan、Discussion、Start/Continue/New Work、Create Automation、lifecycle movement/Reject/Archive/Restore 的现有条件、mutation、pending/error 和 exact navigation 全部可用。
- Result Session 选择、tie-break 和 final-parts extraction 与 Locked Product Decisions 完全一致，并有纯测试覆盖多 Work Sessions、Discussion、failed/latest、Tool-only completion、interrupted/discarded、多个 output parts 的 source order/原文逐块渲染和 Done/非 Done 标题。
- Result 只触发一个 Session detail request；不存在 Result Server endpoint、Todo persisted field、commentary fallback 或多 Session fetch。
- preview→detail→back 恢复原 inventory 状态；direct detail deep link 完整呈现并可返回 Active/List。

### AC-05: Automations

- `>840px` 为 list/detail split；`<=840px` 默认 list，选择后同 canvas 只显示 detail + visible back，不出现第二 rail 或 inspect modal。
- 未选择项且 viewport `>=841px` 时自动 replace 到第一个可见 Automation，顺序为 Needs you→Scheduled→Paused→Inactive，并保留 query；`<=840px` 永不自动选择。`841–1040px` 与 `>=1041px` 分别使用原型的窄/宽 split geometry。
- list 分组严格互斥并按 `Needs you / Scheduled / Paused / Inactive`；failed/missed 无论 definition 状态均进 Needs you 决策组且显示红色 error orbit，并保留精确机制文案 `Failed` / `Missed`。`dispatched` 从不显示 Completed。
- filter 覆盖 ID、name、instruction、schedule、linked Todo content 和 visible run state；flat row 打开正确 definition，recent run 只在有 Session 时打开 exact Session。
- New/Edit/Run now、canonical once/interval/cron、timezone、start_session/send_message 行为保持；New dialog 无 Agent/Profile editor，start_session 只读显示 `Lead + principal`。
- Detail title 只有 Edit/Run now；Pause/Resume/Delete 只在 Edit dialog 的 Definition controls 中，Delete 有确认且不删除 durable Sessions。enabled detail 状态显示 Scheduled、disabled 显示 Inactive；真实 next fire 使用 Today/Tomorrow/weekday compact time。scheduled definition 使用静态 neutral orbit，只有真实 running Invocation 使用绿色旋转；missed 使用红色 error orbit 和精确 `Missed`。

### AC-06: Sessions inventory

- 命令区只有 local search、source menu、far-right New Session；list centered `max-width:1080px` 并按 `Needs you / Running / Recent`。
- 每行显示统一 status cue、title、Todo/Automation/Direct source、state/time，并打开 exact Session。Failed 在 Needs you group 仍为 error；Running 使用权威 elapsed；Recent completed 使用 circle-check/Completed。
- filter 覆盖 title、Session ID、source、linked Todo content、Automation name；source menu 只有 All sources/Todo/Automation/Direct，无额外 state filter。它是原型的自定义 142×36px trigger、220px popover、至少 44px option，不允许浏览器原生 select chrome；pointer 打开焦点留在 trigger，键盘打开聚焦当前选项。
- New Session 直接创建 direct root Lead Session、进入 detail 并聚焦 composer；不弹 Todo/Session chooser，不自动创建 Todo。

### AC-07: Session Detail

- Header 顺序与 copy 符合规范；`<=760px` DOM 中不显示 cwd、source 或相邻 separator，tools/tokens 保留。390px 标题、status、tabs、Inspector control 和 Composer primary action 均可达。
- running/completed/paused Work 分别显示 `Working… / Worked… / Paused · Worked…`；paused Work row 不含 Needs you，Session header 与 Composer 在真实 HITL 时各显示一次 Needs you。Execution ordering、final response placement、fold/scroll behavior不变。
- Composer 只有一个 Model/Effort trigger 和一个 menu；display names、Default badge、Effort/Default、explicit-override reset 条件正确，DOM 不存在第二 model/variant trigger 或营销描述。
- Model/Effort pointer 打开时焦点留在 trigger，键盘打开时聚焦当前 model；选择 model 或 effort 后菜单保持打开，outside/Escape 关闭且 Escape 恢复 trigger。菜单视觉精确匹配原型的 308px 宽、12px radius、model row/effort row 密度。
- Composer 在 idle、running、HITL、failed 及 `<=760px` 下都渲染 textarea；不存在 Composer-level expand/collapse control、collapsed branch 或隐藏输入区的状态。
- ready/uploaded draft attachment 是 attach-order remove-only chip，DOM 无 reorder control；uploading 明确可见且无可用 Remove/Retry，failed 才提供 Retry + Remove，uploaded 收敛为 remove-only。focused test 证明移除 uploading chip 不可伪装成 upload cancellation。
- Inspector tab bar 顶部无 summary strip；Agents/Changes count 正确，keyboard roving 保持。Agent rows 无 L connector、role icon box、skills 第三行、大片 brand wash或 `<11px` 关键文本；Changes 行含 kind/path/diffstat。
- `>1180px` Inspector 为 312px default、280–460px resize；`<=1180px` 为 overlay，打开不压缩 document，关闭恢复 focus。Context、Diff route、root/Child focus 与 persisted width 保持。
- Composer outer rail/input column 分别为 900/848px desktop measure；`<=760px` 输入为 16px、dock gutter 为 0，并始终贴在 Session canvas 底部。inventory toolbar 为 81px，但 Session detail project toolbar 精确保持 88px。

### AC-08: Hard cut, boundaries, and Settings regression

- 生产代码不存在旧 Board-only view contract、permanent capture composer、dual picker、attachment reorder、Inspector summary strip、parallel legacy component、feature flag、compat wrapper 或 fallback render。
- 响应式合同使用 inclusive boundary：Todo preview `<=720` direct detail、Automation `<=840` list/detail replacement、Todo detail `<=1040` stack、Inspector `<=1180` overlay；必须分别实测边界值与 `+1px`，不依赖会遗漏边界的严格 Tailwind max variant。
- 对应测试验证新正向合同；不存在只搜索旧 string/class、只证明旧文件不存在或永远不走旧分支的墓碑测试。
- 跨层非 UI diff 仅限 AC-03 的 Start discussion wire contract、Todo receipt/service、单一 route 和 Runtime `ensureSessionFile` adapter；Web 仍只依赖 Protocol，ordinary Todo-bound `createSession` 继续允许用户主动创建多个 Discussion。不存在旧两步 capture fallback、客户端 Session 扫描、兼容 wrapper 或第二份恢复状态机。
- Settings 的 ready dialog、Runtime Data recovery、Config Recovery、MCP/Skills/Memory/Security/About & Updates、390/760/1024/1440 footer 可达性和 light/dark 全部通过现有及 focused tests；无规范偏差则 Settings production JSX 无结构性改动。
- 没有新增通用 EntityFilter、inventory engine、Drawer framework、design-system runtime、客户端状态机或第二 Session Store。

### AC-09: Automated and real-browser verification

- focused tests 覆盖 rail limit/fixed order/monogram、Home pairing/status、Todos state/filter/drag/dialog/preview/keyboard/mobile direct route、Start discussion 正向/并发/顺序 replay/restart/response-loss/message failure/recovery exact IDs、Todo Result、Automation split/groups、Sessions groups/create、Session header/model/attachments/always-visible Composer/Inspector。
- `bun run typecheck`、`bun run test`、`bun run web:build`、`git diff --check` 全部退出码 0。
- 真实 QA project 至少包含：5+ projects、四类 Todo lifecycle、Rejected、Archived、Needs you/Failed/Working/Ready-to-review Todo、completed Work final answer、Discussion、linked Automation、failed/missed/scheduled/paused/inactive Automation、Needs you/Running/Recent Session、active HITL、attachments、2+ Agents、M/A/D changes。
- Chrome 验收覆盖 1440、1024、760、390px，light/dark，以及 Home、Todos List/Board/preview/New Todo/detail、Automations list/detail/New、Sessions、Session root/Inspector tabs/Model menu/attachments、Settings。每个宽度 `scrollWidth <= clientWidth`，无不可达控制，产品 Console error 为 0。
- keyboard 验收覆盖 Skip、Cmd/Ctrl+K、C、j/k/Enter/Escape、Tab/focus restore、Board keyboard drag、Inspector arrows/Home/End；`prefers-reduced-motion: reduce` 下无非必要循环或位移动画。
- QA 记录必须逐项给出页面、状态、操作、可见结果和直接测试/截图证据；只打开 route、只通过 unit test 或只对照 prototype 均不算真实验收。
