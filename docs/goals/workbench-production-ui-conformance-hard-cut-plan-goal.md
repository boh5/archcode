# Workbench Production UI Conformance Hard-Cut Plan Goal

## Objective

把已批准并提交的工作台设计完整落实到生产 Web UI。设计基线固定为提交
`df7613c85bc614c6a36e0ebe5f702c3b6de4ff6e` 中的 `design-system/MASTER.md`、
页面规范和当前有效 HTML 原型。本 Goal 是同步生产实现，不是再做一轮设计，
也不允许实施者按个人偏好重新解释原型。

这次工作覆盖 Root、Todos、Todo detail、Runs、Schedules、Session detail 和
Settings recovery 的共享视觉与相关交互。其中 Todos、Runs 和 Session 是主要改造面；
Root 与 Settings 只做共享视觉同步和回归校准。实施采用一次性硬切：删除被替代的
旧 UI、状态分支和专属依赖，不保留 fallback、兼容 wrapper、双渲染、隐藏旧 DOM
或墓碑测试。

## Authority And Baseline

按以下顺序判断，不得互相替代：

1. 对有当前有效原型的页面，原型在真实浏览器中的实际渲染是视觉交付和视觉验收
   权威。布局、密度、颜色、层级、交互呈现、动效和响应式不能只靠读 CSS、DOM
   或规范来判断；
2. `design-system/MASTER.md` 和对应 `design-system/pages/*.md` 定义产品与交互规则，
   页面规范只在明确写出的地方覆盖 Master；
3. 现有产品、API、Store 和持久化是领域事实与真实能力权威。原型中的示例数据、
   数量、文案和 fixture 不得被当成新的产品事实；
4. UI/UX Pro Max 只用于检查可访问性、焦点、密度、响应式和 reduced motion，
   不得覆盖 ArchCode 现有的安静、高密度工程工作台方向。

实施开始前记录设计基线 commit 和工作区状态，并在真实浏览器中重新打开以下原型：

- `design-system/prototypes/index.html`
- `design-system/prototypes/todos.html`
- `design-system/prototypes/sessions.html`
- `design-system/prototypes/automations.html`
- `design-system/prototypes/session.html`（`view=todo`、`view=work`、`view=detail`
  分别覆盖 Todo detail、Work 和具体 Session）
- `design-system/prototypes/settings.html`（ready dialog 及其中直接展示的 section 视觉）

验收证据分为两类：上述原型直接覆盖的 surface/state 必须做同状态 product/reference
对照；Root redirect/loading/registry error、Config Recovery 全页、Runtime activation failed
后的 Runtime Data recovery 及其他没有直接原型的既有状态，只能依据 Master、页面规范、
最近的共享原型语言和真实产品行为验收，并明确写“无直接原型 reference”，不能伪造
同态截图。

已核对的生产差距包括：Todos 仍有 List/Board 双视图和 `Todo workspace` 备注；
Todo Preview 仍是只读阶段；Runs 的 Sources 仍是浏览器原生选择器；生命周期状态、
运行信号、选中态、空态和 Session 工作流呈现尚未同步到最新规则。因此这不是单纯
换色或补几个 class，必须同时收口视觉、交互和状态投影。

## Locked Decisions

- Todos 只保留一个按 `Ideas / Ready / In progress / Done` 分组的 List。Board、
  List/Board 切换、拖拽、URL 状态和 Board 专属样式/依赖/测试全部删除。
- 删除 Todo navigator 底部 `Todo workspace`、`Operational history` 等备注性 footer
  实例；它们不是产品标签，也不需要寻找替代文案。不要误删导航的可访问名称或正文中
  具有真实语义的同词文案。
- Todo Preview 保持轻量且大部分内容只读，但增加一个自定义
  `Stage: {label} ▾` 菜单，允许普通 `Idea / Ready / In progress / Done` 移动。
  Reject、Archive、内容、References 和 Plan 仍只在完整 Todo detail 中管理。
- Todo lifecycle 与 linked Work 状态彼此独立。纯 `In progress` 使用中性活动表达，
  只有权威的真实 `Running` 才使用 lime。移动 lifecycle 不得启动、停止或解决 Session。
- 仅当 Todo 移到 Done 且 linked Work 当前为 `Running` 或 `Needs you` 时确认；
  其他普通阶段移动直接执行。确认后 Work 继续保持自己的真实状态。
- Runs 的 Sources 从原生 select 硬切到原型中的 ArchCode 单选 listbox；不要保留隐藏
  native fallback，也不要借机把全站所有选择器抽象成一个万能组件。
- `Needs you`、`Failed`、`Running`、`Ready to review`、`Scheduled` 和生命周期必须
  使用真实数据与规范中的优先级；不能根据颜色、当前分组或 DOM 文案反推状态。
- Root 无 Dashboard；Settings 不做新的结构设计，只同步共享规则并保护现有能力。
- 任何未写在本节中的既有产品能力都默认保留。原型未展示不等于可以删除。

## Architecture Contract

- 高内聚：颜色与 surface token、按钮、focus、selection、status orbit、overlay/elevation
  等真正跨页的视觉规则只实现一次；生命周期和运行状态的映射在既有纯投影边界集中
  收口，页面不得各写一份判断。
- 低耦合：页面特有的 filter、布局和交互状态留在页面边界。Stage menu 与 Sources
  listbox 可以共享视觉 primitive，但必须保留各自正确的菜单/listbox 语义。
- 只消费权威已有数据，不在组件中制造业务事实，不为列表计算引入逐项请求，也不新增
  第二份持久化或全局 UI store。
- 保持 Web 现有依赖边界。若真实验收必须增加 Protocol/Server 投影，先说明缺失事实、
  最小改动和风险并停止等待用户批准；不得擅自扩大为领域模型或持久化重构。
- 需要重构时做彻底硬切，删除只为被替代 Board、native Sources 或双实现兼容服务的
  adapter、alias、CSS、tests 和依赖；不保留 feature flag、fallback、兼容 wrapper、
  双渲染或隐藏旧 UI。仍承担正式职责的 adapter 和改写后继续验证现行行为的测试必须保留。
- 不建立通用 inventory engine、万能 row/filter/status 系统或新的视觉回归平台。
  只抽取已被多个页面真实复用且职责清楚的部分。

## Plan

### 1. 锁定视觉基线与能力对照

- 逐页打开当前原型与生产页面，建立一张简洁的页面/状态/viewport/theme 对照表。
- 为原型状态准备语义等价的真实产品状态；不能复制 synthetic 数据冒充产品状态。
- 罕见瞬时视觉状态可以用既有 canonical view-model fixture 呈现；mutation、revision
  conflict、持久化、deep link 和 Back 必须走真实产品链路。fixture 只能证明呈现，不能
  证明 API 或持久化；没有安全准备路径时停下汇报，不新建 QA 平台。
- 先确认 Preview stage mutation、linked Work 状态、Automation invocation、Reasoning、
  Tool 和 finalized `ask_user` 等所需事实能从当前产品权威取得。
- 发现原型暗示不存在的能力、既有能力会被改变，或需要新增领域事实时，暂停对应页面
  并向用户提交事实、选项和风险。

### 2. 收口共享工作台视觉基础

- 同步 Master 的 light/dark semantic tokens、surface roles、role-based elevation、
  字体、密度、focus、selection、status orbit、按钮、空态和 motion。
- 保持 project rail、Todo navigator、canvas、overlay 和 Inspector 的职责与层级清楚；
  删除备注 footer 和旧的页面局部视觉语言。

### 3. 硬切 Todos 与 Todo detail

- 完整删除 Board，保留单一 List、三个 inventory surface、正确分组、筛选、空态和
  Preview/详情返回状态；将 operational signal 与 lifecycle 彻底解耦。
- 按原型实现 New Todo 和 Preview Stage 菜单及其 pending/error/recovery；同步 List/
  导航计数和焦点，`<=720px` 直接进入完整 Todo detail。
- 校准 Todo detail 的 lifecycle、Todo/Work、文档、References、Plan、Result 和 linked
  Work 呈现，不复制 mutation owner，不改变现有深链与持久化语义。

### 4. 同步 Runs 与 Schedules

- Runs 使用自定义 Sources listbox，并保留真实来源、分组、状态、筛选恢复和 New Session。
- Schedules 对齐列表/详情、failed/missed、空态、筛选、responsive back 和编辑能力；
  两页保持平整列表，Scheduled 定义不能被误画成真实 Running。

### 5. 同步 Session 工作台

- 对齐 Todo-bound、Direct、non-Todo Automation 三类 source-aware shell；不能伪造
  Todo 身份，也不能丢失真实来源和 canonical URL。
- 对齐 Work/final response、Reasoning、Tool、Delegation、Recovery、Compaction 和 settled
  `ask_user` 的层级与顺序，以及仅在具体 Session 出现的 Inspector 和 Composer。
- 使用 running、permission、question、ready、failed Bash、Direct completed 和
  Automation source-only 等代表状态逐个做真实浏览器对照，不能只验收最空状态。

### 6. Root、Settings 与响应式回归

- 保持 `/` 的最近项目/首项目跳转和零项目注册入口，不新增 Dashboard 或虚构内容。
- Settings ready、Runtime Data recovery 和 Config Recovery 保持现有信息结构、控制能力
  与安全语义，只同步共享视觉并修复回归。
- 在窄屏重新验证 Todo navigation drawer、Preview bypass、Schedules list/detail、
  Session Inspector overlay 和 Composer，不允许用隐藏关键能力来解决空间问题。

### 7. 清场与交付验证

- 删除旧 Board、native Sources、重复状态算法、旧样式和不再使用的依赖；测试只验证
  当前正向行为，不新增“旧 UI 已不存在”的墓碑测试。
- 完成自动化 gates、真实浏览器矩阵和同状态视觉对照；发现偏差后继续修正并重新截图。
- 提交可复核的 QA 记录和代表性对照图，交给用户做最终视觉 review。

## Non-goals

- 不重新设计 Design Master、页面规范或原型；明显 prototype defect 必须先报告，
  未经用户批准不得顺手改设计方向。
- 不改变 Todo、Session、Execution、Automation、Goal、Plan、HITL、Reference 的领域模型
  或持久化语义。
- 不新增 Dashboard、分析图表、通用 AI SaaS 装饰、页面级玻璃/光晕或额外导航层。
- 不重写 Root/Settings 的产品流程，不把 prototype fixture 变成生产数据。
- 不创建新的通用设计运行时、截图框架或为了未来可能复用而提前抽象。

## Risks And Stop Conditions

出现下列任一情况，对应工作保持未完成并立即向用户汇报，不得自行猜测：

- 当前 API/Store 无法 revision-safe 地移动 Todo stage 或无法识别冲突；
- 无法权威得到 Todo linked Work 的 `Running / Needs you`，或只能通过逐项请求拼凑；
- Web 缺少可显示 Reasoning、Tool target/settled 状态、finalized `ask_user` 答案等事实，
  必须修改 Protocol/Server 才能满足原型；
- Automation source、Invocation 到 Session/HITL 的关系或 failed/missed 事实不完整；
- 原型、规范与真实 deep link、Back、持久化或既有产品能力发生实质冲突；
- 为了“看起来一致”必须删除未获批准的功能，或需要改变信息架构主次关系。

## Acceptance Criteria

以下 AC-01 至 AC-09 必须全部通过。任一项只靠源码、DOM、测试或主观描述推断，均为
`NOT_DONE`。

### AC-01：设计权威与视觉证据可复核

- 实施记录明确引用基线提交 `df7613c8`，且逐页实际打开当前原型和生产 UI。
- Root 零项目状态、Todos、Runs、Schedules、Todo detail/Work/Session 的 `session.html`
  对应模式，以及 Settings ready dialog 和它直接展示的 section 是 prototype-backed；
  每个直接覆盖的 surface/state 在相同 viewport、theme 和语义状态下有 product/reference
  对照。
- Root redirect/loading/registry error、Config Recovery 全页和 Runtime Data recovery 等
  没有直接原型的状态是 product-only/spec-backed；必须实际目视产品并记录规范与最近
  共享原型参考，不能声称存在同态 reference。
- QA 记录至少写明 route、准备状态、viewport、theme、操作、可见结果、截图和结论。
- 对 prototype-backed surface，未实际目视比较两边渲染不能标记视觉完成；对
  product-only/spec-backed 状态，未实际目视产品并记录最近参考同样不能完成。

### AC-02：共享视觉系统统一

- Root、Todos、Runs、Schedules、Session 和 Settings recovery 使用同一套批准的 light/dark
  token、surface、focus、selection、status、button、elevation 和 motion 语言；无页面
  局部第二套视觉系统。
- 选中态不改变行的尺寸或节奏；键盘 focus 在 base、surface、elevated、overlay 上仍与
  selected/pressed 状态独立可见。
- 普通信息文字达到至少 4.5:1，对必要控件边界和状态指示达到至少 3:1；系统字体与
  中文回退无裁切、重叠或不可读情况。
- `prefers-reduced-motion` 下不存在非必要循环、位移或缩放动效。

### AC-03：Todos 与 Preview 完成硬切

- 产品只有 List；没有可达 Board、List/Board 切换、Board URL 状态、拖拽路径、专属
  依赖或隐藏旧 DOM。代码清场由 diff review 证明，不写墓碑测试。
- List 分组、Active/Rejected/Archived、first-use、group empty 和 filter no-results 结果
  真实；filter no-results 保留控件并提供明确 reset/clear 操作。
- Preview Stage 是非原生自定义菜单，包含且只包含四个普通 stage；键盘、pointer、
  `aria-expanded`、当前项、Escape/Tab 和焦点恢复全部可操作。
- mutation pending、revision conflict、成功后 Preview 保持、List/导航计数同步和移动后
  行焦点恢复均有可见证据；失败不能只靠游离 toast。
- New Todo 在桌面和窄屏均实际对照原型；Save、Start discussion、Run now 三种结果、
  pending 禁止重复/关闭、局部错误恢复和关闭后的准确焦点恢复均无回归。
- 纯 `In progress` 为中性；真实 `Running / Needs you` 在 lifecycle 移动后仍保留。
  只有移到 Done 且 linked Work 为 Running/Needs you 才出现确认，确认不改变 Work。
- 720px 打开完整详情，721px 打开 Preview；两侧都无横向溢出或丢失完整详情入口。

### AC-04：Runs 与 Schedules 行为和信息统一

- Runs Sources 是 `All sources / Todo / Automation / Direct` 自定义单选 listbox；生产
  可见控制中无原生 select，且 Arrow、Home/End、Enter/Space、Escape、outside、Tab
  和 committed-selection focus 行为通过。
- Runs 的 Needs you/Running/Recent、来源、失败色和行信息与真实 Session 一致；Failed
  始终为错误语义，不被画成 amber Needs you。
- Schedules 的 Needs you/Scheduled/Paused/Inactive、failed/missed、linked Session、
  无运行记录、筛选恢复、宽屏 split 和窄屏 back 都使用真实事实且可操作。
- 两页没有浮动 selected card、重复导航、伪造 Session link、KPI 卡或与 `New todo`
  竞争的第二个项目级主动作。

### AC-05：Session 工作台与原型同构

- Todo-bound Session 保留 Todo/Work shell；Direct 和 non-Todo Automation 只显示真实
  单 Session shell。不同入口打开同一 canonical Session 时，source 呈现一致。
- 完成 Work 可显示 settled-call aggregate，live Work 不显示变化中的 count，paused Work
  不重复产品级 `Needs you`；final response 始终在 Work 外，无文本时不制造空响应。
- 可见 Reasoning 独立呈现；空 Reasoning 只切断分组而不显示占位；Tool Run 保留真实
  顺序和重复调用，singleton、mutation、Bash、Delegation 与 `ask_user` 按规范呈现。
- Inspector 只有 Agents/Changes/Context，无 summary strip；Changes 明确是当前 checkout，
  不宣称由 Session 独占产生。
- Composer 顺序为 HITL → Goal → Queue → input；model menu、Effort、attachments、
  Enter/Shift+Enter/IME 和互斥 Stop/Queue/Send 行为与规范一致，且不覆盖 transcript。
- running、permission、question、ready、failed Bash、Direct completed、Automation source-only
  代表状态均完成产品/原型实际渲染对照。

### AC-06：Root 与 Settings 无功能回归

- 有有效项目时 `/` 直接进入 All todos；无项目时只显示注册入口，不闪现 Dashboard、
  假数据或不可用 Todo navigation。
- Settings ready dialog、Config Recovery、Runtime Data recovery presentation、section
  navigation、focus return 和安全确认保持现有真实能力；本 Goal 不新增或删除 Settings 功能。
- 零项目和 recovery 状态使用隔离的测试环境准备，不改写用户真实 project registry、
  Config 或 Runtime 数据。
- 两者均消费新的共享视觉规则，并在 light/dark 与窄屏完成真实渲染回归。

### AC-07：响应式与可访问性完整

- 每个主要 surface 在 390、760、1024、1440px 的 light/dark 均实际打开验证；复杂 overlay
  和菜单至少覆盖一个桌面和一个窄屏交互状态。
- 另在涉及页面验证 560/561、640/641、720/721、840/841、980/981、1260/1261px 两侧，
  证明 Todo shell、Settings、Preview、Schedules、Todo navigation 和 Inspector 在精确
  切点没有错位、遮挡或能力丢失。
- 每个宽度满足 `document.scrollWidth <= document.clientWidth`，浏览器 console error 为 0；
  drawer、Preview、Inspector、Composer 和 dialog 不遮挡关键内容或主动作。
- 所有 icon-only 控件有可访问名称。dialog、Preview 和规范要求模态化的 drawer 正确
  trap 并恢复焦点；menu/listbox 使用 roving focus、允许 Tab 离开，并按各自规范处理
  Escape 或 committed selection 的焦点返回。coarse pointer 的关键操作至少 44px，
  移动端 Composer 输入保持 16px。

### AC-08：架构与 Hard-cut 通过 review

- 共享视觉 primitive 和状态投影各有单一清楚 owner；页面例外保持页面本地，没有复制
  业务判断、逐项请求、假字段、巨型万能组件或第二个布局/全局状态系统。
- 只为 Board、native Sources 或双实现兼容服务的旧路径、依赖、样式和测试已删除；
  正式 adapter 与现行行为测试保留。无 feature flag、fallback、compat wrapper、双渲染
  或隐藏旧 UI。
- Web 依赖边界保持不变；任何 Protocol/Server 扩大都具有事先用户批准和最小范围证据。
- 测试只证明现行正向行为，不新增只断言旧 symbol、class、route 或文件不存在的墓碑测试。

### AC-09：自动化与最终视觉验收全绿

- focused tests 覆盖 New Todo、Todos List/Preview stage、operational projection、Runs
  Sources、Schedules list/detail、Session Work/Tool/Composer/Inspector、Root 和 Settings 回归。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码 0。
- 真实浏览器 QA 有 light/dark、四个主要宽度、deep link、Back/return、pending/error/empty、
  代表运行状态和无横向溢出的可复核记录。
- 最终交付向用户展示至少 Todos + Preview、Runs Sources、Schedules、Session desktop/mobile
  的代表性 product/reference 对照；用户完成视觉 review 前不得宣称视觉验收完成。

## Completion Rule

只有 AC-01 至 AC-09 全部有可复核证据，自动化 gates 全绿，真实浏览器对照已经实际
目视完成，用户没有未决产品/视觉决策，且代码中不存在旧兼容路径或已知 P0/P1 问题，
本 Goal 才能标记为 `complete`。任何无法安全准备的状态、缺失的权威事实、未完成的
视觉证据或未经用户批准的跨层改动，都必须保持 `in_progress` 并明确说明阻塞项。
