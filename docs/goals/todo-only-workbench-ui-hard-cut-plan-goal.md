# Todo-only Workbench UI Hard-Cut Plan Goal

## Objective

将 ArchCode Web 从当前的 Global Home + 项目顶部 `Todos / Automations / Sessions` 结构，硬切到当前有效 HTML prototypes 实际呈现的 **Todo-only workbench**：项目 rail 是全局锚点，Todo navigator 是每个项目的持久导航，Todo 是工作上下文，`Runs` 与 `Schedules` 是次级运营入口；Todo-bound Session 始终留在对应 Todo 的 `Work` 上下文中。

本 Goal 主要是 UI 信息架构、视觉、交互与响应式重构。唯一跨越 UI 的改动是删除已经失去产品入口和语义的 Global Home projection（Web、Protocol、Server 一并删除）。除此之外，不改变 Todo、Session、Automation、Execution、HITL、Goal、Plan、Reference 的领域模型、持久化结构或 API 语义。

实施采用一次性硬切：删除被替代的 Home、项目顶部 tabs、旧 Shell、旧响应式分支和文档级快捷键，不保留 feature flag、fallback、兼容 wrapper、双渲染路径或墓碑测试。

## Authority And Verified Gap

权威按问题类型固定拆分，禁止用文档检查代替实际视觉判断：

1. 当前有效的 `design-system/prototypes/{index,todos,automations,sessions,session}.html` 及其共享 CSS/JS 是**视觉交付与视觉验收权威**。布局、几何、间距、密度、字体、颜色、图标、层次、边框、圆角、阴影、gradient、functional blur、动效、响应式和可见状态层级，以浏览器实际渲染的 prototype 为准；
2. 当前产品实现及其 Protocol/API/Store/Persistence 是**功能与领域事实权威**。真实能力、状态语义、数据来源、mutation、错误恢复、权限、canonical URL 和 durable behavior 不得因 prototype 的演示内容而漂移；
3. `design-system/MASTER.md` 与 `design-system/pages/*.md` 是解释设计意图、数值和边界的参考资料，不是视觉交付的替代证据。文档与实际 prototype 视觉冲突时，prototype 胜出并同步修正文档；
4. prototype 中的 synthetic data、fixture、sample query 或演示动作不自动成为产品功能；当前产品中 prototype 没有展示的真实能力也不能被静默删除；
5. UI/UX Pro Max 只辅助检查 accessibility、focus、font loading、reduced-motion、layout shift 与响应式质量，不得覆盖 prototype 的视觉方向或引入通用 AI SaaS 输出。

功能与 prototype 冲突按以下流程处理：

- `Objective` 与 `Locked Decisions` 中逐项列明的用户批准 hard-cut，是产品功能基线的唯一例外，并优先于“默认保留既有能力”；每个删除项必须引用相应决定。除此之外，产品功能基线始终优先于 prototype 的省略或演示，不得仅因 prototype 未展示就删除；
- 若 prototype 明显违反 canonical schema/API、持久化事实、已批准产品行为、可访问性底线，或只是坏链接、fixture/sample 泄漏、不可达/不可操作状态，则判为 prototype defect：先修 prototype，并同步参考文档，再以修正后的实际渲染为视觉基准；
- 若 prototype 省略了产品已有能力，默认保留功能并将其纳入同一视觉语言；如果加入后会改变信息架构、主次关系或用户路径，停止实施并提交给用户决策；
- 若 prototype 展示了产品不存在但可能有意的新能力，不得自行实现，也不得偷偷删掉该视觉入口；记录功能差距、选项和风险，停止并交给用户决策；
- 任何无法客观判为明显错误的功能差异都不得由实施者猜测。未获得用户决策前，对应 surface 保持 `in_progress`，不得以 fallback 或兼容分支绕过。

已完成的只读核验：

- 当前产品 `/` 仍渲染跨项目 Home；目标 `/` 只负责进入最近有效项目的 `All todos`，无项目时只显示注册项目空状态。
- 当前项目 Shell 仍有顶部 `Todos / Automations / Sessions` toolbar；目标改为固定 276px Todo navigator，且不再存在同级 tabs。
- 当前 Todo detail 是独立 document + 右侧工作 rail；目标是统一的 selected-Todo shell，并在 `Todo / Work` 两个本地目的地中承载 Todo 文档、Work 列表和 Todo-bound Session。
- 当前 Session detail 使用单层项目 toolbar；目标根据 immutable Session source 渲染 Todo-bound 双层紧凑上下文或 Direct/non-Todo Automation 单层 Session shell。
- 当前 Root shell 拥有 Inspector；目标由项目/Session Shell 拥有 Inspector 的布局与 overlay，Root 只保留全局 rail 和 overlays。
- 当前 Web 存在文档级 `Cmd/Ctrl+K`、`C`、`j/k`、`Enter` 监听；现行规范明确不注册应用/文档级快捷键，只保留控件本地和无障碍键盘行为。
- 当前 `GET /api/home`、Home protocol projection 和 Web Home 只服务被删除的 Global Home；`/api/search` 与全局搜索仍有独立用途，必须保留。
- 已以真实浏览器核对当前产品与当前 prototype 的桌面和窄屏结构；两者控制台均无 error。实现后的验收必须重新打开并同时渲染 prototype 与产品进行视觉对照，不能复用本次研究结果，也不能从文件、代码、DOM 或自动化测试推断视觉达标。

## Locked Decisions

- Todo navigator 在 `>980px` 固定为 276px，不提供 resize。只有 Context Inspector 可在 280–460px resize。实施时同步修正规范中任何暗示 navigator 可 resize 的残留文字。
- `/` 的最近项目只在 Web 本地保存 slug，key 固定为 `archcode.last-project`。只在一个已注册项目路由成功解析后更新；无效 slug 必须清除。
- `/` 解析优先级固定为：有效的 `archcode.last-project` → Server 项目列表第一项 → 无项目注册空状态。不得调用 project `touch`，不得用最近访问改变 project rail 的 registration order。
- Root/project entry 明确区分 `loading / success-empty / error`：只有 registry 成功返回空数组才能显示 no-project；请求失败显示显式 error + Retry，不清 localStorage。成功列表确认 deep-link `:slug` 不存在时，若它等于 stored slug 则清 key，再 `replace("/")` 重新按上述优先级解析。
- Global Home 完整删除：Web route/query/component/tests、Protocol Home DTO、Server `/api/home` projection/route/tests 同步移除；`/api/search`、全局搜索及其 route 保留。
- 生产 URL 固定为：Todo detail=`/projects/:slug/todos/:todoId`；Todo Work list=`/projects/:slug/todos/:todoId/work`；具体 Session 始终=`/projects/:slug/sessions/:sessionId`。不得把 prototype 的 `?view=work` 或 sample 参数带入生产。
- Todo navigator 中 `All todos` 指向 `/projects/:slug/todos`；Needs-you、In-progress、Ready 区域中的 Todo 行直接指向对应 Todo 的 canonical detail URL，而不是增加另一套 inventory URL 或持久化 filter 状态。
- Todo navigator 分组是一个确定的、允许重复的纯投影：`Needs you` 包含任意非 Rejected/Archived Todo，只要其全部 linked root families 中存在 authoritative unresolved HITL，或 Work/Todo-origin Automation Goal 为 blocked/budget-limited；`In progress` 包含全部 lifecycle=`in_progress`；`Ready` 包含全部 lifecycle=`ready`。粗粒度 Execution `waiting_for_human` 不能单独判为 Needs you，因为它也可能是 `child_dependency`。普通 Idea/Done 不单列，Rejected/Archived 只在 All todos 对应 surface 中出现。每组保持 canonical Todo array order，count 是本组行数；terminal Failed、Ready to review、Working、Scheduled 只作为 In-progress 行的 operational state，不改变分组。依赖数据未 authoritative 时不显示虚假 Needs-you count/row，失败时显示 unavailable + Retry，而不是 0。
- 同一 Todo 同时出现在 Needs you 与 lifecycle group 时，selected state 的优先级固定为 `Needs you → In progress → Ready`，只在最高优先级实例设置 `aria-current="page"`；All todos 只在 inventory route current。Idea/Done detail 若不属于 Needs you，可以没有 current navigator row，不能伪标 All todos。
- `Runs` 与 `Schedules` 只改呈现名称，分别继续使用 `/sessions` 与 `/automations` route family，领域实体/API/存储名称不改。
- Todo-bound Session 依据 immutable `session.source.todoId` 重建 Todo shell 并保持 `Work` 选中；Todo-origin Automation Session 同样如此。Direct Session 与无 Todo 的 Automation Session 不伪造 Todo 上下文。
- `New todo` 是 navigator 中唯一的 Todo 主 CTA，并在全部项目 route 可达。`Save` 留在当前 route；`Start discussion` 和 `Run now` 继续使用现有原子、幂等命令并进入 canonical Session URL。
- New Todo pending 时 Close、Escape、backdrop 和重复提交全部失效。Save 只绑定提交时的 `{ slug, content, localOperationToken }`，不获得 receipt/replay 语义；Run now/Start discussion 才绑定稳定的 `{ slug, content, clientRequestId }`。若 route change 或 feature unmount 使原 UI 消失，迟到 success/error 不得写入其他项目 dialog/toast，也不得用当前 slug 导航；原项目通过 authoritative refetch，两个幂等命令还通过既有 receipt/recovery 呈现最终状态。
- project rail 的 Search 只通过可见按钮打开。删除 `Cmd/Ctrl+K`、Todo `C`、`j/k`、document-level `Enter`；Dialog、menu、tabs、drag-and-drop 等组件本地键盘合同保留。
- Settings 不做结构重设计，只接受共享 token、rail 和 overlay 带来的必要适配及回归修复。
- Inter 固定为官方 `rsms/inter` v4.1 release `Inter-4.1.zip` 中的 upright roman variable `web/InterVariable.woff2`，产品和 prototype 使用 byte-identical 文件、`font-weight: 400 700`、`font-display: swap` 且 `src` 不写 `local()`。固定 SHA-256：release archive=`9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`，font=`693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3`，`LICENSE.txt`=`262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`。完整 system/CJK fallback 保留，但不再依赖 Google Fonts 或其他运行时外部字体请求。

## Prototype-first Visual Fidelity Contract

- “视觉复刻”不是大致采用同类颜色或布局，而是对当前 prototype 的实际渲染做高保真实现。Shell 几何、区域尺寸、对齐、间距、字体角色、颜色、图标、surface hierarchy、border/radius、elevation、gradient、blur、hover/pressed/focus/selected/loading/disabled/error 状态、motion 和 responsive behavior 都在交付范围内。
- 每个 `prototype-backed` surface/state 必须执行同一闭环：读取功能事实 → 在浏览器打开当前 prototype → 准备语义等价的真实产品状态 → 在相同 viewport、theme 和交互状态下同时截图 → side-by-side 与透明叠图检查 → 用 computed style/geometry 定位偏差 → 修正 → 重新截图。`product-only-preserved` state 执行真实产品渲染 + 最近 prototype shell/primitive/token 的目视校准和功能回归。对应 evidence lane 未通过前不得进入“完成”状态。
- 每个 QA state 必须归入一个 evidence lane：`prototype-backed` 使用同态截图/叠图和固定 anchor 门槛；`product-only-preserved` 明确记录“无直接 prototype reference”，在浏览器中对照命名的最近 prototype shell/primitive/token，并同时提供功能回归证据，不伪造同态 reference；`prototype-only-or-ambiguous` 保持阻塞，直到 prototype defect 被修正或用户完成产品决策。清晰且在范围内的 product-only 缺失参考可以先补进 prototype，重新渲染后转为 `prototype-backed`；Bootstrap/auth/recovery 等范围外能力只做 preserved regression，不借机重设计。
- 视觉判断必须真的查看浏览器渲染。只读 `MASTER.md`/page spec/prototype CSS/React 代码、检查 DOM/class、运行 unit test、typecheck/build 或声称“数值一致”，均不能单独证明视觉交付达标。
- prototype 的 synthetic 文案、ID、数量和数据内容无需逐字复制；产品使用真实数据，但必须匹配同一状态的视觉结构、密度、层次和反馈。字体抗锯齿与真实文本自然换行不要求整页二进制像素相同。
- prototype 明确定义的固定几何和对齐以 computed pixels 精确匹配。QA 表预先命名 rail/nav/header/Inspector/dialog/drawer/preview/Composer/canvas-gutter 等固定 anchors；同 viewport 下这些 anchor 的边界、宽高、inset 与中心线允许误差不超过 1px。内容驱动的 row/card 高度与自然换行不适用 1px 总高度门槛，但其 padding、gap、typography 和固定边界仍必须匹配。颜色/token、font family/weight/line-height、radius、shadow、blur、motion duration/easing 必须匹配 prototype 的 computed value。
- 视觉效果必须完整实现而不是在最后补色：navigator/canvas 的 neutral depth、selected brand field、live/attention/error signals、primary CTA depth、modal/drawer elevation、fixed-header functional blur、Composer priority/input surface、hover/press feedback 和 reduced-motion 都要在对应阶段校准。
- 不新增通用 screenshot-regression 平台或设计运行时。使用现有浏览器控制、截图、叠图/并排检查和少量几何断言即可；验收证据记录到一个简洁 QA 表，不为视觉复刻建立新框架。
- 实施开始和交付前都记录当前 prototype Git SHA/working-tree state。若 prototype 在实施中更新，受影响 surface 必须以最新实际渲染重新校准，旧截图不能继续作为完成证据。

## Architecture Contract

### Layout ownership

- `RootLayout` 只拥有 project rail、Add Project、global search、Needs-you popover、Settings、theme、toast 与主 `Outlet`；不得再计算 project toolbar、Todo navigator 或 Inspector grid。
- `ProjectLayout` 是项目工作台的唯一 Shell owner：读取当前项目，渲染 Todo navigator/drawer、project canvas，并为 Session route 提供 Inspector 的 sibling/overlay 布局位置。
- 扩展现有 `WorkbenchLayoutProvider` 管理 navigator drawer、Inspector open/width 与断点行为；不得新增第二个 layout store/provider。
- 新增一个窄职责 `ProjectTodoNavigator` 和一个 project-scoped navigation projection/hook。小范围抽出纯函数 `deriveProjectTodoNeedsUser`，遍历 Todo 的全部 linked root families，只认 authoritative HITL 与 blocked/budget-limited Goal；现有 `deriveProjectTodoOperationalState` 复用该 predicate，并删除 `waiting_for_human => Needs you` 的粗粒度 fallback。不得建立通用 inventory engine、navigation framework 或第二份判定算法。
- Todo selected shell 由一个 feature boundary 统一拥有 content-derived lead、lifecycle 和 `Todo / Work` 导航；Todo detail、Work list、Todo-bound Session 只填充其内容槽位，不各自复制 header。
- canonical root Session query 只计算一次窄 `SessionShellMode`（Todo-bound 或 Direct/non-Todo Automation），并通过 route/Outlet context 同时驱动 outer shell、Inspector inset 和 source error；不得新增 store。focused child、root transcript 与 full diff 只替换 Session canvas slot，不得提前 return 出另一套 header。分支来自 canonical root source，不能以 route 来源、history state 或请求失败 fallback 猜测。

### State and data ownership

- Todo navigator 只投影已有 Todo、全部 linked root Session families、Automation、Goal、runtime 与 HITL 数据，不持久化派生 group/count/status，不增加 Server aggregate endpoint。
- `New todo` capture 状态提升到 Project Shell 下的 feature boundary，使所有项目 route 共用一个 dialog；Todo mutation 仍由现有 API hook 拥有。
- Work list 的 filter、type filter、scroll 和返回位置是 route-local UI state；打开 canonical Session 后通过 navigation state 恢复，直接 deep link 的 `All work` 返回则落到 `/todos/:todoId/work` 的默认状态。
- `archcode.last-project` 只保存 slug，不保存 Project DTO、route、Todo 或 Session 快照。Project registry 仍是注册有效性的唯一事实源。
- 删除 Home projection 时只移除 Home 专用代码；`global-work.ts` 中 Search 的 schema、route 与 projection 必须保持独立且通过原测试。

### Visual system

- 以现行 semantic tokens 硬切全局颜色、14px UI baseline、Inter 400–700（`display=swap` + system fallback）、4px compact shape、6px control/card radius 和当前 elevation 规则。
- Motion token 只保留现行 `instant / fast / standard / deliberate / attention / activity`；旧 `hover / icon / overlay / complete` token 和调用点全部迁移后删除。
- Done 使用共享 outline `check` glyph；不得继续使用 circle-check 或 CSS border 拼成的替代图形。
- Primary CTA 才允许 prototype 中的 restrained gradient。Composer Dock 始终参与垂直布局且不覆盖 conversation；只有已预留的 full-width dock 背景透明，中央 priority/input surface 可见，禁止 blur/glass。普通 canvas、row 和 lane 不增加 glass、glow 或装饰性 elevation。
- shared primitive 仅限确有跨页一致性的 rail、status glyph、compact shell 和 primary action；filter、inventory projection 与页面 toolbar 保持页面本地，避免泛化。

## Plan

### 0. Lock rendered baselines and capability parity

- 在改产品代码前，先把本次批准的 authority contract 同步到根 `AGENTS.md` 与 design-system 说明：prototype 是视觉交付权威，规范是参考，产品是功能事实权威。
- 在字体本地化前，先在 network/resource timing 中确认当前 Google CSS 与 Inter WOFF2 成功返回，并通过 CSS Font Loading API 确认指定 Inter face 实际 loaded；`document.fonts.ready` 只用于等待，不能单独证明没有 fallback。证据齐全后再截取当前 Google-served prototype 的 reference screenshots 并记录关键 text/anchor geometry；若外部字体未真正加载则不得建立基准。随后从官方 [Inter v4.1 release](https://github.com/rsms/inter/releases/tag/v4.1) 引入 Locked Decisions 指定的 variable WOFF2 与许可证。替换后重新渲染：若关键 anchor 超过 1px 或出现明显 glyph/weight/run-length 漂移，停止并交给用户决策，不能把漂移后的画面静默设为新基准。
- 用浏览器逐一打开当前 `index.html`、`todos.html`、`automations.html`、`sessions.html`、`session.html`，记录 prototype Git/working-tree state，并建立一张窄的 surface capability/QA table：唯一 `qa_state_id`、URL/browser action、viewport/theme、prototype control/state、真实产品能力、处理结论、evidence lane、nullable `direct_prototype_state_id`、`nearest_reference_ids`、命名 anchors、证据路径、是否需要用户决策。只有同态 prototype state 才填写 `direct_prototype_state_id`；product-only state 必须留空并列出实际用于校准的最近 reference。
- 明显 prototype defect 必须先修 prototype 并重新渲染确认；有实质功能歧义则停止对应 surface，向用户给出事实、选项和风险。没有未决项后才开始该 surface 的产品实现。
- 为每个 `prototype-backed` state 准备语义等价的真实数据/安全 fixture；不追求复制 synthetic text，但必须能对照相同的 empty/loading/running/attention/error/completed/overlay 状态。`product-only-preserved` state 准备其真实状态和命名的最近 prototype reference，不伪造同态 fixture。

### 1. Hard-cut Root and Global Home

- 增加 `RootEntryRoute`：在项目列表加载完成前不闪现 Home；成功后按 Locked Decisions 解析并 `replace` 到项目 `All todos` 或渲染唯一 no-project state；registry error 独立显示 Retry。
- 将有效项目访问集中到一个 route-level effect 更新 `archcode.last-project`；验证无效/已删除 slug 清理和首项目注册后跳转。
- 在 `ProjectLayout` 校验 deep-link slug；成功列表确认未知 slug 后回到 Root 重新解析，registry error 时保留 URL 并显示 Retry，不误清 key、不重定向循环。
- 删除 Web Home route、query、components 和旧正向 tests；删除 Protocol Home types；从 Server 拆除 `/api/home` 及其专用 projection/tests。
- 保留 `/api/search`，并将其与 Home 删除后的 imports、route composition 和 tests 解耦。新测试只正向覆盖 RootEntry、项目注册与 Search；Home DTO/route 删除由 typecheck、production build 和 diff review 证明，不增加 `/api/home` 404 或 symbol-absence test。

### 2. Hard-cut shared tokens and primitives

- 让 product 消费 Phase 0 已固定的本地 Inter，移除运行时 Google Fonts 依赖；所有 fidelity capture 等待 `document.fonts.ready`。另用固定静态 state 的全新浏览器 context 做一次可归因 cold-load：在注册 `PerformanceObserver` 后人为延迟本地 WOFF2，使 fallback frame 可见，数据、skeleton 与其他异步 transition 必须先固定；字体 ready 前后命名 anchors 最大位移 `<=1 CSS px`、font-attributable CLS `<=0.01`，且不发生 clipping、overlap 或 wrap-strategy 改变。页面总 CLS 单独记录，不混入字体门槛。Vite dev 和 `dist/archcode` embedded UI 均必须成功返回本地 font 且无外部字体请求。
- 更新 global CSS、Tailwind semantic mapping、system/CJK fallback、shape/elevation/motion tokens；一次性迁移旧 token consumers 后删除旧定义。
- 收敛 shared status glyph、rail control、primary action 和 compact shell primitives；补齐 focus-visible、coarse 44px、dark/light、reduced-motion 合同。
- 删除旧 glyph hacks、重复 color literals 和被替代的 shared Shell class；不引入新的 design-system runtime/package。

### 3. Re-own the workbench Shell

- 将 Inspector layout ownership 从 `RootLayout` 移入 `ProjectLayout`，Root 只保留全局 overlay 与 project rail。
- 删除 `ProjectToolbar` 和所有 `Todos / Automations / Sessions` 顶部 tabs；把 edit project、close project 等项目动作迁入 navigator identity 区。
- 实现固定 276px `ProjectTodoNavigator`、`<=980px` drawer/scrim、focus trap/restore、route active state 与项目切换后的数据切换。
- 抽出并复用 `deriveProjectTodoNeedsUser`，移除 operational helper 对粗粒度 `waiting_for_human` 的 attention fallback；以单一 project-scoped projection 实现 navigator 分组、canonical order、authoritative loading/error、重复 Todo 的唯一 current state，使用表驱动测试且不增加 generic inventory abstraction。
- project rail brand 在有效项目中进入当前项目 `All todos`；no-project 时是静态品牌。保持 fixed registration order、More projects、Add、Search、Needs you、Settings、theme。
- Needs-you popover 只列 exact deep links，不渲染无真实目标的 `View all` footer。

### 4. Move capture and align Todo inventory

- 把 New Todo dialog 从 Todos route 提升到 Project Shell feature，navigator 只保留一个 primary trigger；从 Todos canvas 删除重复 CTA。
- 保持现有 `Save / Start discussion / Run now` API、idempotency、pending/error/recovery 与 exact navigation，不重写领域命令。
- 迁移现有异步隔离合同：pending 禁止 dialog dismissal；Save 捕获 local operation token，Run now/Start discussion 捕获 durable client request identity；route change 或 unmount 使 UI callback 失效但不篡改持久结果。late success/error、pending route change 与 indeterminate recovery 均有 focused test，不扩展 Save Protocol/Server contract。
- 将 All todos header、filter、List/Board、Active/Rejected/Archived 与 preview 对齐当前 prototype 的实际渲染；删除所有 document-level Todo shortcuts。
- Board 断点硬切为 `>1260` 四列、`721–1260` 两列、`<=720` 四条横向滚动 lane；保留 pointer/touch/keyboard drag 的 canonical Todo mutation。
- preview 在 `>720px` 是不改变 inventory 几何的 read-only overlay；`<=720px` item 直接进入 canonical Todo detail。

### 5. Build the selected-Todo shell and Work destination

- 建立单一 selected-Todo compact shell：content-derived lead、lifecycle、`Todo / Work`，不新增 Todo title 字段。
- Todo destination 继续承载 canonical lifecycle control、Brief/PRD、References、Plan、trusted Result；保留现有 mutation 和数据加载语义。
- 新建 `/todos/:todoId/work` route，按 Discussion、Work Session、Automation Session 显示 linked roots，提供 page-local filter/type controls、New Discussion、New Work Session、Create Automation。
- Work row 进入 exact `/sessions/:sessionId`；browser Back 恢复 Work filter/scroll，direct Session 的 `All work` 回到默认 Work list。
- 删除旧 Todo detail 右侧 work/lifecycle rail 和任何平行的 Todo header/detail implementation。

### 6. Integrate Runs and Schedules

- 保持现有 Sessions/Automations queries、mutations、classification 与 routes，只将 Shell、heading、row density、labels 和 navigator active state 接入 Todo-only workbench。
- Runs 继续是完整 Session inventory 和唯一 `New Session` 入口；Schedules 继续是 Automation inventory/detail 和 `New Automation` 入口。
- Runs/Needs-you/Search/Automation invocation 全部打开 exact canonical Session URL，并由 Session source 决定目标 Shell。
- 在 `<=980px` 下两页使用同一 Todo navigator drawer，不恢复顶部 tabs 或第二导航 rail。

### 7. Make Session detail source-aware

- Todo-bound Session 渲染 Todo compact shell + 50/57px Session context row，`Work` active；Direct/non-Todo Automation 只渲染单个 58px Session shell。
- root Session query 派生唯一 `SessionShellMode` 并通过 route context 驱动 Shell/Inspector；focused child（`?focus=`）和 full diff（`?view=diff`）只替换 canvas，Composer/HITL/Queue/Stop-Send 始终绑定 root Session。
- 将 Inspector 接入 `ProjectLayout`：`>1260px` 为 312px sibling、可在 280–460px resize；`<=1260px` 为 right overlay，并遵守 Todo/Session shell top inset。
- 保留现有 conversation、Work disclosure、final answer、Composer、HITL、Goal、Queue、attachments、model selection、Agents/Changes/Context 语义，仅重排层次和视觉。
- 删除旧项目 toolbar、重复 source banner、平行 Session header 和 source-guessing fallback。

### 8. Cleanup and verification

- 删除 retired components、routes、types、CSS、listeners、imports 和旧行为 tests；测试改为现行正向合同，不添加 tombstone tests。
- 将 `MASTER.md`/page specs 同步为对当前 prototype 视觉与产品功能事实的准确参考；同步根 `AGENTS.md` 中的视觉权威和 Root/Home/Web 架构事实，不改历史 `docs/` 记录。
- 每个 surface 完成后立即按其 evidence lane 执行视觉闭环；最终再对所有 prototype-backed surface 做一次最新 prototype 同态回归，并对 product-only-preserved states 做最近 shell/primitive/token 回归。任何只在代码或测试层面通过、但未实际查看产品与对应 prototype reference 的 surface 仍为未完成。
- 完成 focused automated tests、全仓 gates、真实浏览器功能矩阵和视觉对照矩阵；Settings 只修复实测回归。

## Non-goals

- 不修改 Todo/Session/Automation/Execution/HITL/Goal/Plan/Reference persisted schema 或 lifecycle。
- 不重命名 Session/Automation API、store、route family，不引入 `Run`/`Schedule` 领域实体。
- 不新增 Dashboard、cross-project feed、Home replacement、project analytics 或 aggregate Needs-you route。
- 不新增 Todo title、Todo-level execution、Work attempt、Result persistence 或 nested Session URL。
- 不重写 New Todo 原子命令、Session execution、global search、project registry ordering、Inspector data、Composer queue 或 attachment transport。
- 不为 QA 增加 production data-root、CLI flag 或 Save receipt/clientRequestId；隔离状态使用现有可注入 test seam 与 disposable CI runner。
- 不建立通用 inventory engine、generic drawer framework、generic filter、page builder、第二 layout store 或第二 status projection。
- 不建立 screenshot-regression service、设计运行时或像素基线管理平台；视觉证据使用现有浏览器和一份 QA 记录。
- 不把 prototype fixture、query parameter 或 synthetic count 带入生产。

## Risks And Controls

| Risk | Control |
|---|---|
| Root redirect 循环或错误项目 | 只在 registry query success 后解析；验证 stored slug 存在；使用 replace；无效 slug 先清除再按 Server 第一项回退 |
| registry failure 被伪装成零项目 | 只有 success-empty 才渲染注册空状态；error 保留 local state/URL，显示 Retry |
| 删除 Home 时误删全局 Search | 先分离 Home-only exports；对 `/api/search` 保留 route/API/Web focused tests |
| navigator 误把 child dependency 当用户决策 | 统一 `deriveProjectTodoNeedsUser` 只认 authoritative HITL/Goal；operational projection 复用它并删除 `waiting_for_human` fallback |
| Shell ownership跨 Root/Project/Session 重叠 | Root、Project、selected-Todo、Session 四层各有唯一职责；测试每个 source 只出现规定的 header 层数 |
| canonical Session deep link 丢失 Todo context | 只使用 immutable source.todoId 查 Todo；缺失/无权访问显示明确 unavailable/error，不降级伪造 Direct Shell；Automation source 仍保留 exact Automation/Invocation 返回路径 |
| fixed navigator 挤压窄屏 canvas | `<=980px` 完全移入 drawer；实测 980/981，不保留半固定 CSS 分支 |
| Inspector overlay 覆盖 shell 或 Composer | 按 source 与 1260/560 边界计算唯一 inset；实测 sibling/overlay、focus restore 与无 document overflow |
| 全局 token 改动造成 Settings 回归 | light/dark + 390/760/1024/1440 Settings QA；只修具体回归，不借机重构 Settings |
| keyboard hard-cut 损害 accessibility | 只删除 document/app shortcuts；保留 dialog/menu/tabs/drag 的本地键盘、focus trap、Escape 和 focus restore |
| 跨项目 late Todo response 污染新项目 | Save 用 local token、两个 start command 用 requestId，全部绑定 captured slug；unmount 后 callback 失效，authoritative refetch/receipt 决定原项目最终状态 |
| 用规范/代码推断视觉完成，实际渲染仍偏离 | 每个 state 强制打开产品与对应 prototype reference；prototype-backed 做同态并排/叠图，product-only 对照命名 primitives；未目视检查不得通过 |
| prototype fixture 被误实现为新功能 | 开工前做窄 capability table；明显错误先修 prototype，真实功能保留，任何实质歧义停下交给用户 |
| prototype 在实施期间继续更新 | 开始与交付前记录 prototype state；更新后只重跑受影响 surface 的视觉与功能校准，旧证据失效 |
| 本地字体复制或加载不一致造成排版漂移 | product/prototype 使用固定的 Inter v4.1 variable WOFF2、许可证与 SHA；浏览器验证实际字体、network、pre/post anchors 和 layout stability |
| product-only 状态没有同态 prototype 而无法叠图 | 归入 `product-only-preserved` lane，对照命名的最近 prototype shell/primitive/token + 功能回归；不伪造 reference，不借机重设计 |
| 既有功能保护阻止已批准 hard-cut | capability table 明确引用 Objective/Locked Decision；只有逐项批准的删除优先，其他能力一律保留或提交决策 |

## Acceptance Criteria

以下 AC-01 至 AC-10 必须全部通过；任一项缺失、只能推断、只看静态 route、只读文件/代码或只通过 automated test，均为 `NOT_DONE`。

### AC-01: Root entry and Home removal

- 有有效 `archcode.last-project` 时，访问 `/` 不渲染 Home frame，直接 replace 到该 slug 的 `/todos`；stored slug 无效时清除并进入 Server 列表第一项。
- 无 stored slug 时进入 Server 项目列表第一项；无注册项目时只显示 rail + heading + explanation + 一个 `Open project` 主动作 + local-data reassurance，且 Search/Needs-you/Todo navigator 均不存在。
- registry loading 不闪现 no-project/Home；registry error 显示错误与 Retry，保留 stored slug 且不 redirect；Retry success 后再按项目列表解析。
- 直接访问未知 `/projects/:slug/...` 时，只有 registry success 能判定不存在并 replace 到 `/`；若该 slug 等于 stored slug 则同时清 key。registry error 保留原 URL 显示 Retry，不进入 redirect loop。
- 首个项目注册成功后进入该项目 All todos；Cancel/Close/backdrop 保持空状态并把 focus 返回原 trigger。
- 连续访问项目不会发出 project `touch` 请求，也不会改变 project rail registration order。
- Web 无 Home route/query/render，Protocol 无 Home DTO，Server 不再 compose Home projection/route；删除由 typecheck、production build 和 diff review 证明，不新增 `/api/home` 404、旧 symbol/file/class absence 等墓碑测试。
- `GET /api/search`、全局搜索 UI、结果项目/实体标识和 exact deep links 全部仍通过。

### AC-02: Workbench Shell and navigation

- `>980px` 的项目页计算布局为 `52px project rail + 276px Todo navigator + flexible canvas`；navigator 无 resize handle。980px 时 navigator 不占 grid column，981px 时固定占 276px。
- `<=980px` 可见按钮打开 Todo navigator drawer；drawer 有 scrim、focus trap、Escape/close、route change auto-close 和 exact trigger focus restore，project rail 始终可见。
- 所有项目页 DOM 中不存在 `Todos / Automations / Sessions` 顶部 tab row；project identity、New todo、Todo groups、Runs、Schedules 和项目 edit/close 均只在 navigator。
- brand 在项目上下文打开当前项目 `/todos`；no-project 时不可点击。project marks 保持 fixed registration order，More/Add/Search/Needs you/Settings/theme 的现有能力与顺序可用。
- 4 个注册项目时直接显示 4 marks 且无 More；5 个时显示前 5 个 fixed marks + More。`<=760px` 只显示 active mark + More + Add，完整项目集仍在 More picker；切换项目只变 active state。
- navigator 的 All todos、In-progress Todo、Ready Todo、Runs、Schedules 均打开 Locked Decisions 中的 exact route；Needs-you 仍是一 Todo 一行，尾部显示该 Todo 的 exact action count，并进入 `/projects/:slug/todos/:todoId/work`。分组成员、允许重复、canonical order、authoritative loading/error 和唯一 `aria-current` 完全符合 Locked Decisions，并有表驱动测试覆盖 Idea/Ready/In-progress/Done + Discussion HITL、同一 Todo 多个 child Worker HITL、Work/Automation Goal blocked/budget-limited、child dependency 且无 HITL、Rejected/Archived + HITL、Failed/Working/Ready-to-review/Scheduled，以及各 dependency loading/error。
- Todo Work 顶部逐条展开该 Todo 的全部 HITL 与 Goal gate，显示 owning Agent/Session/mechanism；每条通过 root Session + `hitl` + 必要的 child `focus` 精确深链进入现有处理界面，不复制 mutation owner。全局 Needs-you popover 仍每行直接进入 exact Session，且无 `View all`/`See all` aggregate footer。

### AC-03: New Todo, inventory, and preview

- 在 Todos、Todo detail、Work、Runs、Schedules、Session detail 任一路由，navigator 的唯一 `New todo` 都打开同一 capture dialog；canvas/header 不出现第二个 Todo primary CTA。
- Save 保持当前 route 并刷新 Todo projection；Start discussion 创建一个 Idea + bound Discussion 并进入其 canonical Session；Run now 创建一个 In Progress Todo + bound Lead Session 并进入其 canonical Session。现有并发/replay/restart/recovery focused tests 全部继续通过。
- operation pending 时 Close、Escape、backdrop 与重复提交不可用。若 pending 中发生 route change 或 feature unmount，late success/error 不修改其他项目 dialog/toast、不用新 slug 导航；回到原项目后 Save 由 authoritative refetch、Run now/Start discussion 由 refetch + receipt/recovery 显示真实结果。
- Save 请求仍只有 `content` wire input，不新增 `clientRequestId` 或 replay；其 UI guard 使用 local operation token。Run now/Start discussion 才复用稳定 `clientRequestId`，现有 Protocol/Server contract 不因 dialog 提升而扩大。
- 产品不存在 `Cmd/Ctrl+K`、`C`、`j/k` 或 document-level Enter listener/`aria-keyshortcuts`；Search 与 New todo 只经可见控件打开。
- Active List 保持 980px centered；Board 在 1261px 四列、1260/721px 两列、720px 四条横向可滚动 lane。720/721 边界均无 document-level horizontal overflow。
- pointer/touch/keyboard Board drag 更新 canonical Todo lifecycle；reduced motion 下没有 landing 位移动画。
- 721px 选择 Todo 打开不改变 inventory width/left offset（误差各 <=1px）的 read-only preview；720px 不挂载 preview，直接进入 canonical Todo detail。preview close/Escape/scrim 恢复 origin focus。
- Filter、List/Board、Active/Rejected/Archived、pending/error、Rejected/Archived restore 和 no-results 均保持可用。

### AC-04: Selected Todo and Work

- `/todos/:todoId` 与 `/todos/:todoId/work` 共用且只渲染一个 58px selected-Todo shell；包含 content-derived lead、真实 lifecycle、`Todo / Work`，不存在持久化 title 或第二个等价 header。
- 560px 时 Todo shell 为 88px wrap；561px 时为 58px。两个边界均无不可达 tab、截断后无详情入口或 document overflow。
- Todo destination 完整保留 lifecycle、Brief/PRD edit、References、Plan、trusted Result 及其 pending/error/empty behavior；旧右侧 work/lifecycle rail 不存在。
- Work destination 按 Discussion、Work Session、Automation Session 展示全部 linked roots，filter/type controls 和 New Discussion/New Work Session/Create Automation 都调用现有 canonical commands。
- Work row 进入 `/sessions/:sessionId`；Back 恢复 Work list filter 与 scroll。直接 deep link Session 的 `All work` 进入 `/todos/:todoId/work` 默认状态。
- Todo detail 生命周期和 Session Execution 状态在文案、glyph 和 mutation 上不混用。

### AC-05: Runs and Schedules

- navigator `Runs` 打开完整 `/sessions` inventory，`Schedules` 打开 `/automations`；页面/API/store 中 canonical entity 仍为 Session/Automation。
- Runs 仍按 `Needs you / Running / Recent`，并保留 source filter、local filter、New Session 与 exact Session links；New Session 产生 Direct root Lead Session，不创建 Todo。
- Schedules 保留 `Needs you / Scheduled / Paused / Inactive`、list/detail responsive behavior、New/Edit/Run now 和 exact invocation Session links。
- Schedules 在 841px 是 list/detail split，在 840px 默认 list 且选择后同 canvas detail + visible Back；两边均无 overflow、重复 navigator 或自动选择错误。
- 两页不渲染 project top tabs、第二 navigation rail、duplicate global search 或 duplicate Todo CTA。

### AC-06: Source-aware Session Shell

- Todo-bound Work/Discussion/Todo-origin Automation Session 在 canonical Session URL 渲染 Todo shell，`Work` 为 active，并增加且只增加一个 Session context row。
- Direct Session 与无 Todo Automation Session 只渲染一个 58px compact Session shell，source 明确为 Direct/Automation；DOM 中无 Todo lead、Todo/Work tabs、Brief、Plan 或 References。
- Todo source 指向已删除/不可读取 Todo 时显示明确 unavailable/error，不得把它静默当作 Direct，也不得读取 history state 猜 Todo。`source.kind="todo"` 提供返回 Runs 的路径；`source.kind="automation"` 即使 Todo 缺失，仍保留 canonical Automation 身份和指向 exact `/automations/:automationId?invocation=:invocationId` 的返回路径，不能丢失为普通 Runs context。
- 从 Runs、Schedules、Needs you、global search、Automation invocation、Work row 进入同一个 Session URL 时，Shell 都只由 canonical source 决定且结果一致。
- `?focus=<childId>` 与 `?view=diff` 只替换 root Session 的 canvas slot；两者沿用同一个 source-aware Shell/Inspector，Composer、Queue、HITL 和 Stop/Send 仍绑定 root，且不存在独立 64px child/diff header。
- conversation、Execution Work、final answer、Composer、HITL、Goal、Queue、attachments、model selection 与 Inspector tabs 保持现有功能和数据语义。

### AC-07: Inspector and responsive geometry

- 1261px 的 Session Inspector 是 312px sibling column，可 resize 到 280–460px，collapse 后保留上次宽度；1260px 是不压缩 canvas 的 right overlay。
- overlay 对 Todo-bound Session 在 `>=721px` 从 108px 开始、`561–720px` 从 115px 开始、`<=560px` 从 145px 开始；Direct/non-Todo Automation 始终从 58px 开始，scrim 不覆盖 shell。
- Inspector overlay 有 visible close、Escape、scrim dismissal 和 exact trigger focus restore；open/close 不改变 conversation/Composer 的持久状态。
- RootLayout 不渲染 Inspector grid，非 Session 项目 route 不保留空 Inspector column。

### AC-08: Visual, accessibility, and hard cut

- light/dark 的 computed tokens、本地 Inter/system fallback、14px baseline、4/6px shapes、rail fields、elevation 和 status tones 与当前 prototype 实际渲染一致；Done 全部使用 outline check。
- product 与 prototype 使用 Locked Decisions 指定的 Inter v4.1 `InterVariable.woff2` 与许可证，font/license SHA-256 匹配，两个交付位置的字体 byte-identical；`@font-face` 为 upright 400–700、`font-display: swap` 且无 `local()`。浏览器以本地 font resource 成功记录 + CSS Font Loading API loaded face 证明 Inter 实际可用，`document.fonts.ready` 只负责等待；network 中无 Google Fonts/其他外部 font request。
- 本地化前后的 prototype reference 在命名 anchors 上误差不超过 1px，且无明显 glyph/weight/run-length 漂移。cold load 必须使用固定静态 state 隔离非字体异步变化：本地 WOFF2 network/resource record 成功，CSS Font Loading API 返回已加载 Inter face，ready 前后命名 anchors 最大位移 `<=1 CSS px`、font-attributable CLS `<=0.01`，无 clipping、overlap 或 wrap-strategy 改变；app 总 CLS 另记，不用于字体归因。Vite dev 与 compiled `dist/archcode` 都能加载本地 WOFF2；任一门槛失败、未获用户批准的 pre/post 漂移或生产字体 404 均为 `NOT_DONE`。
- production CSS/TS 只消费现行六组 motion tokens；`prefers-reduced-motion: reduce` 下无非必要 loop、pulse、lift、scale 或位移动画。
- 所有 icon-only control 有 accessible name；dialog/drawer/menu/tabs/drag 保持本地 keyboard interaction、visible focus、Escape 与 focus restore；coarse primary/rail/filter controls 至少 44px。
- Composer Dock 在 idle/running/HITL/failed 与所有断点均占用布局高度、conversation 尾部不被覆盖；full-width dock 无 fill/divider/blur/glass，只有中央 priority/input surface 可见。
- 无 Global Home、ProjectToolbar、旧 Todo detail side rail、并行 Shell、document shortcut、legacy token、feature flag、fallback、compat wrapper 或隐藏旧 DOM。
- 测试只验证现行正向行为；没有只断言旧 symbol/string/class/file 不存在的墓碑测试。
- 除 Home 专用 Protocol/Server 删除外，无 persisted schema、API behavior 或 agent-core 领域改动；Web 依赖边界仍只到 Protocol。
- Settings 在 641px 保持 desktop dialog navigation，在 640px 切为现行 compact three-column grid；Ready/Recovery/control-plane panels、footer、light/dark 和 focus return 均无回归。

### AC-09: Verification evidence

- focused tests 至少覆盖 root resolution/no-project/register、project rail order、navigator projection/drawer/capture、Todo inventory breakpoints/preview/drag、selected Todo/Work routing/state restore、Runs/Schedules links、Session source shell、Inspector ownership/geometry 和 Settings regression。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码 0；`bun run build` 的 embedded Web + Server production binary 编译成功，本地 `dist/archcode --version` 成功。
- 现有 CI `Verify` 在 disposable runner 上启动 production binary，证明 `/api/health` 与 embedded `/` asset smoke 通过。不得为本地 QA 改写用户 `~/.archcode`，也不为本 Goal 新增 data-root/CLI seam。
- Root loading/error/no-project/redirect、`/api/search` 与 Direct/Todo-bound Session deep link 通过注入临时 `homeDir` 的 ServerHost/API integration 和 production Web route tests 证明；真实浏览器的注册项目状态使用安全的现有项目或 disposable test host。no-project 不要求实际 binary 触碰本机用户 registry。
- 真实浏览器覆盖 390、560、561、640、641、720、721、760、761、840、841、980、981、1260、1261、1440px；light/dark 至少在 390、1024、1440px 验证。
- 真实状态至少覆盖：no-project（使用隔离的 disposable runtime，不删除用户 registry）、普通项目、Needs-you/In-progress/Ready/Done Todo、Rejected/Archived、Discussion/Work/Automation linked roots、Direct Session、Todo-bound Session、non-Todo Automation Session、active HITL、running/completed/failed work、Inspector Agents/Changes/Context。
- 每个宽度 `document.scrollWidth <= document.clientWidth`；控制台 error 为 0；route refresh 和 canonical deep link 后结构、active destination 与数据均正确。
- QA 记录逐项包含 route、viewport/theme、准备状态、用户动作、可见结果、产品/reference 截图和相应自动化断言。只证明 server listening、route 可打开、单张静态 screenshot 相似或 test 通过其中任一项，均不足以验收。

### AC-10: Prototype-rendered visual fidelity

- QA 表的每个 state 都有唯一 `qa_state_id`、URL/browser action、viewport/theme、evidence lane、命名 anchors 和证据。`prototype-backed` state 的 `direct_prototype_state_id` 必须非空，并在同一次 QA 中用浏览器实际打开当前 prototype 与真实产品，在相同 viewport/theme/语义状态下生成 product/reference screenshots，执行 side-by-side 和透明叠图目视检查；没有实际查看两边渲染结果的一律 `NOT_DONE`。`product-only-preserved` 的 `direct_prototype_state_id` 必须为空，`nearest_reference_ids` 必须列出实际对照项。
- prototype-backed 最小状态集合不得缩减：root/no-project；global Search dialog、Needs-you popover、Open project dialog；project rail/navigation 与 Todo navigator persistent/drawer；Todos List/Board/New Todo/preview；selected Todo/Work；Runs inventory；Schedules list/detail/New/Edit Automation dialog；Session 的 Todo-bound Work、Discussion、Todo-origin Automation、Direct、non-Todo Automation 五种 source shell 的 root transcript，并在代表性的 Todo-bound、Direct、non-Todo Automation source 上分别覆盖 focused child/full diff；failed Composer 与 attachment-chip 也必须有直接 prototype 对照；Inspector Agents/Changes/Context + collapsed/sibling/overlay；Composer normal/running/HITL/Queue edit/model menu；Settings modal/shared-token regression。1440px light/dark 完整覆盖，1024px 与 390px 覆盖每个主要 Shell；AC-09 的精确边界对相应 responsive state 逐项验证。
- product-only preserved 默认最小集合包含：4/5+ project marks 与 More、Root registry loading/error，以及 capability table 发现的其他真实状态。若实施中先补齐、修正并重新渲染了同态 prototype，可将相应 state 正式重分类为 `prototype-backed`，同时填写 `direct_prototype_state_id` 并执行完整叠图验收；不能只改表格标签。Bootstrap loading/unreachable/setup/config-recovery/login/activating/runtime-error、ErrorBoundary 固定为范围外 preserved regression，不借本 Goal 补 prototype 或重设计。仍属 product-only 的每项必须明确写“无直接 prototype reference”，实际打开产品并对照 `nearest_reference_ids` 命名的最近 prototype shell/primitive/token，提供功能回归和视觉一致性证据；不得伪造同态 screenshot、扩展 redesign 或因 prototype 缺失而删除。
- prototype 明确定义的 rail/nav/header/Inspector/dialog/drawer/preview/Composer/canvas-gutter 等命名 anchors，在相同 viewport 下边界、宽高、inset 与中心线误差均不超过 1px；内容驱动 row/card 的总高度和自然换行豁免，但 padding、gap、typography、固定边界及明确的 color、font、weight、line-height、radius、shadow、blur、gradient、duration、easing 仍须匹配 prototype computed value。
- 必须目视确认 neutral surface hierarchy、brand selection、live/attention/error signals、CTA depth、modal/drawer elevation、fixed-header functional blur、Composer priority/input surface、hover/pressed/focus/selected/loading/disabled/error、entry/exit motion 与 reduced-motion；不能用 token 名称相同或 CSS 值存在代替视觉确认。
- 真实文案、ID、count 和自然换行可以与 synthetic fixture 不同，但同语义状态的视觉层级、密度、截断/换行策略和反馈必须一致；字体抗锯齿差异不作为失败，明显的排版、对齐、层次、颜色、效果或 motion 差异必须修正。
- capability table 对每个 prototype-only、product-only 或 approved-hard-cut control/state 都有明确结论和 decision 引用：明显 prototype defect 已先在 prototype 修正并重新截图；产品既有功能未被静默删除；prototype 新能力未被擅自实现；每个删除只来自 Objective/Locked Decisions；所有非明显功能差异都有用户决策记录。
- `MASTER.md`/page specs、源码、DOM、computed values、automated tests 和 build 只能解释或定位问题，不能替代上述真实渲染对照。最终 QA 结论必须明确写出“已目视比较当前 prototype 与产品”，否则视觉验收无效。

## Completion Rule

只有 AC-01 至 AC-10 全部具备可复核证据，且 code review 无未解决 P0/P1、没有已知 fallback/旧兼容路径、全仓 gates 全绿，才可将本 Goal 标记为 `complete`。视觉完成必须由验收者实际打开当前 prototype reference 与真实产品，并按 state 的 evidence lane 目视校准；若任一 state 未完成对应视觉证据、任一验收状态无法安全准备，或存在未由用户决策的功能差异，必须保持 `in_progress` 并说明缺失证据。不得用“UI-only”、规范/源码一致、测试全绿或“与 prototype 相似”代替视觉验收。
