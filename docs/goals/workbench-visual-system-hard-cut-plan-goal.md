# Workbench Visual System Hard-Cut Plan Goal

## Objective

在不改变任何产品功能、运行状态来源或交互流程的前提下，把 ArchCode Web 硬切为一套安静、精密、适合长期监督 Agent 的视觉系统：统一状态语义、Goal 图标、Running 表达、动效、排版、表面层级和明暗主题，消除当前重复文字、语义色反转、状态样式分散、整块旋转和无意义持续闪烁。

本 Goal 只修改 `apps/web` 呈现层及其测试。现有 Route、Protocol、API、Store、状态机、领域对象、按钮可见性、信息所有权与数据顺序全部保持不变。领域 mutation、导航、提交、展开、Stop、Queue/HITL 和既有 action handler 的触发条件、参数、disabled/loading/error、顺序及可见性不得改变；只允许增加不读取 Store/API 的局部 Tooltip 可见性和一次性展示动画状态，它们不得触发领域操作。被替代的状态 class map、旧 pulse/glow、Unicode 状态符号和旧样式直接删除，不保留 feature flag、fallback、兼容 wrapper 或双渲染路径。

## Design Intent

ArchCode 不是普通聊天页，而是长期运行、多 Agent、多 Execution 的监督工作台。界面必须让用户按以下顺序完成识别：

1. **是否需要我**：Needs you、失败、阻塞必须优先于普通运行信息。
2. **什么正在发生**：Session family、当前 Execution 和局部 Tool 的活动层级必须可区分。
3. **当前目标是什么**：Goal objective 是 Composer 上方的主信息，Goal status 是辅助判断，不得反客为主。
4. **完成到哪里**：Todo 使用确定性比例；Execution/Tool 使用真实状态；不能用一个泛化 Spinner 代替三类信息。
5. **证据在哪里**：Tool、Delegation、Diff、Reasoning 和 Inspector 保持现有 disclosure，不靠装饰抢占正文。

视觉通道的职责固定：位置表达所有权，图标/形状表达状态类型，颜色表达语义与紧迫度，动效表达真实变化，文字提供精确解释。任何一个通道都不得同时承担两个冲突含义。

## Relationship To Existing UI Goals

- 本 Goal 继承 `orchestration-workbench-ui-hard-cut-plan-goal.md` 已落地的 Shell、三栏职责、Dashboard projection、Execution Workstream、Composer Dock、Goal/Queue/HITL 顺序、Inspector 和响应式所有权，不重新设计信息架构。
- 本 Goal 明确替代该历史 Goal 中“沿用现有 CSS theme tokens、主题色、字体和状态外观”的视觉限制；历史文档不回写，生产呈现直接硬切到本 Goal 的 token 与状态规范。
- Agent role 到 Lead/Analyst/Build/Explore/Librarian 的身份映射保持不变；使用下文锁定的角色 hue，不得与运行/成功/警告/错误语义色共用状态含义。
- 若实施发现某项视觉要求必须修改 Protocol、Server、Store 或领域投影才能成立，必须停止并请求新决策；不得在 Web 端增加 heuristic、派生状态或伪造字段。

## Locked Visual Decisions

- 视觉方向是“沉静的实时工程工作台”：中性表面为主，品牌紫只用于选择、品牌和 Goal 身份，不使用玻璃拟态、装饰渐变、霓虹 Glow、Bounce 或整卡呼吸。
- 语义色固定为：进行中/信息=`info`，成功完成=`success`，需要用户/暂停/预算受限/阻塞=`warning`，失败=`error`，停止/闲置/未知=`neutral`。绿色不再表示 Running，紫色不再表示 Completed。
- 图标负责状态类型，颜色负责语义，动效只表示真实发生中的活动，文字负责精确解释。主状态不得只靠颜色；图标单独出现时必须有可见 Tooltip、`aria-label` 或等价文本。
- `Goal active` 和 `Automation active` 表示协议有效或已启用，不等于正在执行，必须静止。循环运动只允许出现在权威 in-flight 状态：Session family/Execution、streaming Reasoning、running Tool/Recovery、sending/steering Queue 和 Composer connecting/syncing；其他状态静止。
- 已知 `completed/total` 的 Todo 使用确定性 SVG 进度环；未知时长的 Session/Execution 使用局部活动圆弧；短时 Tool 使用仅旋转图标本身的 Loader。三者不得共用同一个 Spinner 表达。
- Goal 保持 Composer Dock 第一行和现有单行信息结构；改为状态图标、简短状态、主目标、图标化用量和图标操作，不增加展开层或新的交互步骤。

## Design Language Contract

本 Goal 不是给现有界面换一组颜色，而是以“沉静、精密、持续活着的工程工作台”完整替换当前产品内的组件视觉语言。既有信息架构、领域术语和操作逻辑保留；卡片、控件、状态标记、表面层级、密度、留白和动效的旧外观不享有兼容权。

- **工作台而非卡片墙**：先用 canvas、区域分隔和留白表达结构，只有可独立检查或操作的对象才成为 card；禁止 lane/card/card 的层层套盒与 shadow soup。
- **仪表感而非装饰感**：状态必须像可靠仪表一样稳定、可定位、可复核。一个组件最多有一个主语义强调；品牌色不能替代状态色，状态色不能铺成大面积装饰。
- **边界先于阴影**：常驻层级用 surface、1px border、2px leading rail 和 spacing 建立；shadow 只表示真实悬浮层或 Composer 输入焦点，不用于“显得高级”。
- **紧凑但不微缩**：通过固定 type scale、4px grid 和信息分组提高密度，不通过 9–10px 关键文字、全大写或压缩点击区获得“专业感”。
- **控件服从任务**：通用且高频的紧凑操作可使用带 Tooltip 的图标按钮；需要用户比较、确认或理解后果的动作保留可见文字。危险动作只在自身 hover/focus 或确认区域使用 error tone。
- **状态与关系分离**：生命周期状态使用 glyph + label + semantic tone；Discussion、Activation、Agent 等关系使用领域图标和中性/品牌关系样式。存在 Activation 不等于 linked Session 正在运行。
- **不制造假可操作性**：只有实际可点击、可展开或可输入的表面获得 hover/focus affordance。Project Todo lane 只是流程分组，不显示拖拽把手、drop zone 或其他 Kanban 拖动暗示。
- **直接硬切**：旧的 shadow-heavy cards、彩色大徽章、装饰性 Glow、持续 pulse、任意字号/圆角和重复状态文案全部删除；不提供 legacy class、兼容 wrapper、主题开关或旧外观 fallback。

产品名称、Logo 和既有领域语言不在本 Goal 中重做；这不限制应用内组件视觉语言的替换。若某处旧外观与本合同冲突，以本合同为准。

## Visual Specification

### Color And Surface

深色主题锁定为低饱和冷中性色，避免纯黑和高亮紫大面积铺底：

| Token role | Locked value |
|---|---|
| base / surface / elevated / overlay | `#0B0D10` / `#101318` / `#151922` / `#1B202A` |
| hover / active | `#202632` / `#282F3D` |
| border subtle / default / strong | `#222936` / `#2C3544` / `#3B4658` |
| text primary / secondary / tertiary / muted | `#F2F4F7` / `#A8B0BF` / `#818B99` / `#626D7D` |
| brand / info / success / warning / error / neutral | `#8B7FF5` / `#6EA0FF` / `#4CCB7A` / `#E4B454` / `#FF6B72` / `#818B99` |

浅色主题使用微灰工作区而非全屏纯白，浮层才接近白色：

| Token role | Locked value |
|---|---|
| base / surface / elevated / overlay | `#F1F3F6` / `#F7F8FA` / `#FCFCFD` / `#FFFFFF` |
| hover / active | `#ECEFF3` / `#E3E7ED` |
| border subtle / default / strong | `#E6E9EE` / `#D7DCE4` / `#B8C0CC` |
| text primary / secondary / tertiary / muted | `#151820` / `#4E5665` / `#66707F` / `#8D96A4` |
| brand / info / success / warning / error / neutral | `#6254D8` / `#315FD0` / `#187A43` / `#8C5C12` / `#BF3E45` / `#606A79` |

- semantic subtle background 使用对应前景色的低不透明度混合，深色为 `8%`、浅色为 `6%`；不再手写多套 muted hex。neutral subtle 同样由 neutral foreground 混合得到，ActivityArc/ProgressRing neutral track 使用 border-default。锁定 palette 下所有 semantic foreground 对其 subtle background 仍达到 `4.5:1`。
- brand 只用于当前选择、focus、Goal identity 和主要操作；status tone 必须使用 semantic token。
- base 负责 work canvas，surface 负责常驻区域与顶层 card，elevated 负责嵌套检查/编辑区域，overlay 只负责 Dialog/Popover/Menu；不能仅靠阴影区分常驻层级。
- muted 只可用于 disabled、占位符或纯装饰信息；用户判断状态或完成操作所需的正文与 metadata 必须使用至少 tertiary。
- 表单控件边界使用专用 `control-border` 语义 token，并在两主题下对相邻表面达到至少 `3:1`；它不得改写上表锁定的常驻 surface border palette。

### Typography, Spacing And Shape

- 根字号/行高统一为 `14px/21px`。type scale 固定为：page/session title=`16px/22px/600`，section title=`14px/20px/600`，body=`13px/20px/400`，Goal objective=`13px/20px/500`，control=`12px/16px/500`，status=`12px/16px/600`，metadata=`11px/16px/400`，code/path=`12px/18px/400 monospace`，numeric count badge=`10px/14px/600`。
- sans stack 固定为 `Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`；mono stack 固定为 `"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace`。不下载或新增字体依赖。
- 状态、按钮和标题使用 sentence case；仅极短分类眉题允许 uppercase，不再用 `10px + uppercase + tracking` 承载关键状态。
- 使用 4px spacing grid。常用组件间距只取 `4/8/12/16/20/24px`；不新增无来源的 5px、7px、9px 间距。
- radius 固定为 `6px` 控件、`8px` 卡片、`10px` Composer/Popover、`12px` Dialog；圆形状态/头像例外。禁止新增 arbitrary radius。
- 常驻表面无 ambient shadow；Composer 使用 `shadow-sm`，Popover/Menu 使用 `shadow-md`，Dialog 使用 `shadow-lg`。Focus ring 为 2px brand，且不得被 overflow 裁切。
- 紧凑 icon-only control 为 `28×28px`，标准 control 为 `32px` 高；Tooltip 不计入布局尺寸。

Surface ownership 固定如下，避免实现时重新判断：

| Surface | Background / border / shadow |
|---|---|
| root work canvas | base / none / none |
| Project Bar, Sidebar, Header, Inspector | surface / single default separator toward canvas / none |
| Dashboard card, Execution card, Automation card | surface / default / none |
| Tool, Reasoning, Recovery, Compression inside Execution | elevated / subtle / none |
| Project Todo lane | transparent over base / gutter separation / none |
| Project Todo card | surface / default / none |
| expanded Project Todo detail | elevated / subtle + 2px brand leading rail on article / none |
| Goal row | surface / default with local status glyph only / none |
| HITL card | elevated / default + 2px warning leading rail / none |
| Composer card | elevated / default, brand focus-within / shadow-sm |
| Dialog | overlay / strong / shadow-lg |
| Popover, Menu, Tooltip | overlay / default / shadow-md |

Agent identity hue 按主题固定，不参与 status tone：

| Agent | Dark / Light |
|---|---|
| Lead | `#A78BFA` / `#6D28D9` |
| Analyst | `#60A5FA` / `#1D4ED8` |
| Build | `#22D3EE` / `#0E7490` |
| Explore | `#94A3B8` / `#475569` |
| Librarian | `#C084FC` / `#7E22CE` |

### Iconography

- 只使用 Lucide 或同一代码库内的 CSS/SVG primitive；不使用 Unicode glyph、emoji、彩色插图或另一套 icon package。
- Lucide 默认 stroke width `1.75`，紧凑图标 `14px`，标准图标 `16px`，Goal leading glyph `18px`；根据视觉重量只允许 `±1px` 光学校正。
- 图标按钮必须使用熟悉隐喻并保留 accessible name。不能用图标替代 objective、错误原因、Needs you 问题或其他完成任务所需的关键文字。

### Motion Tokens

| Token | Value | Easing / use |
|---|---|---|
| hover/press | `120ms` | `cubic-bezier(0.2, 0, 0, 1)` for color/opacity |
| icon/chevron | `160ms` | `cubic-bezier(0.2, 0, 0, 1)` for rotation/crossfade |
| overlay | `220ms` | enter `cubic-bezier(0.16, 1, 0.3, 1)`, exit `cubic-bezier(0.4, 0, 1, 1)`; opacity + max 4px translate |
| activity | `1600ms` | `linear infinite`, only active arc/Loader/streaming glyph |
| attention | `700ms` | `cubic-bezier(0.2, 0, 0, 1)`, exactly 2 iterations |
| complete reveal | `180ms` | `cubic-bezier(0.2, 0, 0, 1)`, exactly 1 iteration |
| tooltip delay | hover `350ms`, focus `0ms` | appearance uses hover token; dismissal has no delay |

所有 transition/animation 只能引用这些 token。ProgressRing 的 dashoffset 使用 overlay duration/easing；continuous activity 只用 linear；exit 不得比 enter 更慢。

### State Grammar

| Visual state | Icon/shape | Tone | Motion | Meaning |
|---|---|---|---|---|
| running | `ActivityArc` | info | 1600ms linear loop | Session/Execution 正在发生未知时长工作 |
| needs_you | `MessageCircleQuestion` | warning | 700ms attention × 2 | 等待当前用户输入或批准 |
| pending | `Clock3` | neutral | none | 已排队但尚未执行 |
| paused | `CirclePause` | warning | none | 用户或产品暂停 |
| blocked | `CircleAlert` | warning | none | 有明确阻塞条件 |
| budget_limited | `Gauge` | warning | none | Goal 达到预算限制 |
| completed | `CircleCheck` | success | 180ms reveal × 1 | 已成功完成 |
| failed | `CircleX` | error | none | 执行失败 |
| stopped | `CircleStop` | neutral | none | 取消、终止或中断后的产品停止态 |
| idle | `Circle` | neutral | none | 当前没有活动工作 |
| unknown | `CircleDashed` | neutral | none | 尚无权威状态 |
| enabled | domain icon + static dot | info | none | Automation 已启用，不代表正在 Invocation |

领域特例保持身份清晰：Goal active 使用静态 `Target` + brand；Automation active 使用静态 `Calendar` + info；Tool running 使用 `LoaderCircle`；Todo 使用 SVG progress ring。这些特例复用 tone/token，但不伪装为同一种领域状态。当前 Lucide ESM 运行时不暴露 `CalendarClock` named export，因此不得仅凭类型检查使用该符号。

`ActivityArc` 不是通用 Loader：standard 为 14px、compact 为 10px，使用 1.5px neutral track 和约 100° info active arc、round linecap；只旋转 active arc，无中心点、Glow、背景方块或宽度变化。Todo progress ring 为 14px、1.5px track/progress stroke、从 12 点方向开始，`stroke-dashoffset` 直接来自现有 percent；进度更新使用 220ms transition，reduced motion 下即时更新。

一次性 attention/reveal 默认关闭，只能由拥有真实状态转换的已挂载领域组件显式启用。首次加载已经处于 Needs you/Completed、折叠 body 重挂载、切换 root/Child、路由返回和主题切换均静态展示，不得重播；只有同一 mounted identity 从其他状态转换到 Needs you/Completed 时播放一次。该机制只使用组件内 previous-kind ref，不写 Store、URL、Session 或持久化数据。

## Domain Mapping Contract

Visible label/detail 默认来自现有 presentation，不由视觉 primitive 生成。获批的展示 copy 例外只有 Goal short status（`Active/Paused/Blocked/Budget limited/Completed`）与 Project Todo 的 `Archived` override；它们不改变领域状态或行为。下表只锁定现有事实如何选择 visual kind；“motion”只代表视觉资格，不改变生命周期。

### Session, Execution And Child

| Existing fact | Existing visible presentation | Visual kind / tone / glyph / motion |
|---|---|---|
| family `running` | `Running` | running / info / ActivityArc / loop |
| family `stopping` | `Stopping` | running / warning / ActivityArc / loop |
| family `idle` | `Idle` or `Ready` by surface | idle / neutral / Circle / none |
| family unavailable | `Connecting` or `Status unavailable` by surface | unknown / neutral / CircleDashed; Composer connecting may use ActivityArc while query is in flight |
| Execution `running` | `Running` | running / info / ActivityArc / loop |
| unresolved `waiting_for_human` | `Needs you` | needs_you / warning / MessageCircleQuestion / transition attention only in owning HITL |
| answered/continuing wait checkpoint | existing `Input received` detail | completed / success / CircleCheck / transition reveal only |
| Execution `completed` | `Completed` | completed / success / CircleCheck / transition reveal only |
| raw `failed / timed_out / max_steps` | existing `Stopped · Failed/Timed out/Max steps` | failed / error / CircleX; label/detail unchanged |
| raw `aborted / cancelled / interrupted` | existing `Stopped · …` | stopped / neutral / CircleStop / none |
| Child `linked / running / cancelling` | existing `Running` + detail | running / info / ActivityArc / loop |
| Child `waiting_for_human` | `Needs you` | needs_you / warning / MessageCircleQuestion / no loop |
| Child `completed` | `Completed` | completed / success / CircleCheck / transition reveal only |
| Child `failed / timed_out` | existing `Stopped · Failed/Timed out` | failed / error / CircleX / none |
| Child `cancelled / interrupted` | existing `Stopped · …` | stopped / neutral / CircleStop / none |

Raw Execution failure 不新增第五种 `ProductExecutionStatus`，也不修改 `presentExecutionStatus` / `presentChildExecutionStatus` 的返回值、label 或 detail；领域组件只用已经存在的 raw fact 为 `Stopped` 选择 error 或 neutral 外观。

### Goal, Automation, Tool, Session Todo And Recovery

| Existing fact | Visual contract |
|---|---|
| Goal `active` | Target + brand + `Active`, static |
| Goal `paused` | CirclePause + warning + `Paused`, static |
| Goal `blocked` | CircleAlert + warning + `Blocked`, static |
| Goal `budget_limited` | Gauge + warning + `Budget limited`, static |
| Goal `complete` | CircleCheck + success + `Completed`, static on initial load |
| Automation `active` | Calendar + info + existing label, static |
| Automation `paused` | CirclePause + warning + existing label, static |
| Automation `disabled` | Ban + neutral + existing label, static；installed Lucide ESM 不暴露 CircleOff named export |
| Tool `pending` | Clock3 + neutral + `pending`, static |
| Tool `running` | LoaderCircle + info + `running…`; only SVG spins |
| Tool `completed` | Check + success + `done`, transition reveal only |
| Tool `error` | X + error + `error`, static |
| Tool unknown result | TriangleAlert + warning + `unknown`, static; existing safe details unchanged |
| Todo progress `running` | ProgressRing(percent) + info + completed/total; trigger omits generic Running |
| Todo progress `waiting` | ProgressRing(percent) + warning + completed/total; popover 保留 Waiting label |
| Todo progress `blocked` | ProgressRing(percent) + warning + completed/total; popover 保留 Blocked label |
| Todo progress `failed` | ProgressRing(percent) + error + completed/total; popover 保留 Failed label |
| Todo progress `completed` | ProgressRing(100) + success + completed/total; popover 保留 Completed label |
| Todo progress `idle` | ProgressRing(percent) + neutral + completed/total; popover 保留 Ready label |
| Todo item `in_progress` | CircleDot + info + existing Current label, static; no Spinner |
| Todo item `completed/cancelled/pending` | Check success / X neutral / Circle neutral; existing labels unchanged |
| Recovery `scheduled` | Clock3 + warning + `Scheduled retry`, static countdown |
| Recovery `retrying` | LoaderCircle + warning + `Retrying`; only SVG spins |
| Recovery `recovered` | Check + success + `Recovered`, transition reveal only |
| Recovery `failed` | X + error + `Recovery failed`, static |

### Project Todo

Project Todo 的四列是工作流分组，不是可拖拽 Kanban。下表只改变图标、tone 和 motion，不改变 `deriveProjectTodoGroups`、`ProjectTodo.status`、Activation 判定、排序或生命周期 action 文案；唯一 copy 例外是 `archivedAt` 为现有 archived view 补充可见 `Archived` 状态名。

| Existing fact | Visual contract |
|---|---|
| `idea` | Lightbulb + brand + `Idea`, static；表达待塑形，不再误用 warning |
| `ready` and no Activation | CircleDot + info + `Ready`, static |
| non-done Todo with Activation | Play + info + `In Progress`, static；只表示已关联工作，不代表资源正在执行 |
| `done` | CircleCheck + success + `Done`, static on initial load |
| `rejected` | CircleX + error + `Rejected`, static；rejection reason 保留可见文字 |
| archived record | Archive + neutral + `Archived`, static；仅为 `archivedAt` 的展示 override，不新增 status |
| Activation without `resourceId` | Clock3 + neutral + existing `Preparing resource…`, static；缺失 resource 本身不是 in-flight 证据 |
| Activation source Session family `running/stopping` | ActivityArc + info/warning + existing association label；motion 来自 source Session 的权威 family fact，而非 `resourceId` 缺失 |
| linked Session | exact Session family mapping；只有 family `running/stopping` 可在 association row 显示 ActivityArc |
| linked Automation | exact Automation active/paused/disabled mapping，全部静止 |
| resource query loading | LoaderCircle + neutral + existing loading label；只旋转 glyph |
| runtime family snapshot not initialized | CircleDashed + neutral + existing unknown/loading presentation, static；不得把未初始化等同于 query loading |
| linked resource deleted/unavailable | TriangleAlert + warning + existing `Deleted` label, static |
| Discussion association | MessageCircle + brand + existing `Discussion` label, static |

Project Todo 的 lane/status presentation 由路由相邻的纯展示模块拥有，并复用全局 token 与 primitive；它不得写入共享 runtime `status-visuals` 的领域状态集合，也不得读取 Store/API 或重新推导 Activation。这样既共享设计语言，又不把 Project Todo、Session Todo 和 Execution 压成一个 God map。

card status 的纯展示优先级锁定为：`archivedAt → Archived`；否则 `status=rejected → Rejected`；否则 `status=done → Done`；否则存在 Activation → In Progress；否则 `status=ready → Ready`；其余为 Idea。该优先级只选择现有 card 的 label/glyph/tone，不改变 `ProjectTodo.status`、`deriveProjectTodoGroups`、view filtering、持久化数据或 action matrix。

Activation association 的 motion 选择顺序锁定为：`sessionsLoading/automationsLoading` 的真实 resource query 正在 loading 时使用 LoaderCircle；否则 source/linked Session family 为 running/stopping 时使用 ActivityArc；否则缺失 `resourceId` 使用静态 Clock3；已有 resource 则使用其 Session/Automation 权威映射。`runtimeInitialized=false` 只表示 family snapshot 未初始化，使用静态 unknown，不能冒充 query loading；idle/unknown source Session 不得循环。

### Composer, Queue, HITL, Inspector And Dashboard

| Existing fact/surface | Visual contract |
|---|---|
| Composer `Connecting/Syncing` | ActivityArc + neutral/info + existing label while the existing query is in flight |
| Composer family running | ActivityArc + info + `Running` |
| Composer stopping | ActivityArc + warning + `Stopping` |
| Composer pending HITL | MessageCircleQuestion + warning + `Waiting for input`, static outside HITL owner |
| Composer ready | Circle + neutral + `Ready`; green is not used as generic readiness |
| Queue durable `queued` | Clock3 + neutral + `Queued`, static |
| Queue durable `steering` | ActivityArc + info + `Steering`, loop while state remains steering |
| Queue local `sending` | LoaderCircle + info + `Sending`, loop while request remains pending |
| Queue local `retryable` | TriangleAlert + warning + `Retryable`, static |
| HITL unresolved | MessageCircleQuestion + warning; only leading glyph may play transition attention |
| Inspector root/Child | exact Session/Child mapping above; no local color map |
| Dashboard item | reuse the item’s existing Goal/Session/Automation mapping；Web-only row projection 必须透传已存在的 `activityFor` fact，section membership 不得被用来猜状态 |

Project Todo lifecycle、Session Todo priority、MCP connection、Model Picker、Diff/file state、route/query loading、form submission busy 和普通 priority badge 不进入 runtime `status-visuals` God map；它们继续保留现有领域 label/logic，只改用本 Goal 的 typography、surface 和 semantic token。若某个局部 async Loader 继续旋转，只能旋转 glyph，不能扩展新的产品 visual kind。

## Component-Level Design

### Shell, Sidebar And Dashboard

- Project Bar 与三栏职责不变；只用 base/surface/border 建立层级，去掉常驻 Glow 和多余 shadow。
- Sidebar item 保持现有点击区域和排序。标题为 13px，第二行为 11px；当前项用 2px brand 左轨和 subtle selected background，不加外描边。
- Session running 在标题左侧显示 10px `ActivityArc`；idle/unknown 使用静态圆形。Goal marker 复用五状态 Goal glyph + short status，`Target` 只用于 active，不再显示 `Goal · raw_status`。
- Automation active/paused/disabled 分别使用静态 `Calendar/CirclePause/Ban`，不得因 active 持续闪烁。
- Dashboard 四个 section、内容和 CTA 不变。卡片状态统一使用 `StatusGlyph + label`；Needs you 使用最高语义强调，Running now 只使用局部 info，不铺满整卡。

### Session Header And Todo

- Header 现有 58px 最小高度和信息顺序不变。title 为第一层；紧邻状态胶囊固定为 `ActivityArc + Execution running`、`MessageCircleQuestion + Needs you`、`CircleCheck + Completed`、raw `failed/timed_out/max_steps` 的 `CircleX + Stopped · detail`，或其他异常停止的 `CircleStop + Stopped · detail`。
- 状态胶囊高 22px，使用 semantic subtle background，不发光、不缩放整块。detail 继续作为同一胶囊的次级文字。
- cwd、worktree、Goal、Execution/model 和统计继续位于第二行；统一为 11px，分隔符只承担节奏，不与正文等亮。
- Session Todo trigger 使用 14px SVG progress ring、`completed/total` 和可选 `Todos` 短标签；不再显示 Spinner 或泛化 `Running`。popover 内容、进度条、P0/P1/P2 priority 语义和操作保持现状，priority badge 仅换用 semantic subtle background。

### Execution Workstream, Reasoning, Tool And Delegation

- running Execution 使用 2px info 左轨、info glyph 和 label；编号圆保留但不承担状态颜色。历史卡只用 default border，当前卡也不增加 ambient shadow。
- Execution header 的编号、状态、耗时、标题、Tool/Child count 和折叠行为不变；状态名称使用 sentence case，title 仍为 13px 主信息。
- streaming Reasoning 保留 `Sparkles + Thinking…`，只让末尾三个点或 glyph 做局部 opacity 节奏；Reasoning 容器、边框和背景不动。
- Tool row 保留 18px 状态底座。running 时只有内部 `LoaderCircle` 旋转；completed/error/pending 使用 `Check/X/Clock3` 静态图标。工具名、目标、Diff summary 和 disclosure 不变。
- Delegation 继续是特殊 Tool card；Agent/Profile/Skills/Child 入口不变。Child 状态使用统一 visual kind，elapsed time 保留，running 不再使用绿色 badge。
- Recovery、Compression、System notice 只统一字体、边界和局部状态图标；不加入模拟进度或装饰动效。

### Goal And Composer

- Goal row 保持单行，最小高度 42px，结构固定为 `status glyph -> short status -> objective -> usage -> actions`。
- active/paused/blocked/budget limited/complete 分别使用 `Target/CirclePause/CircleAlert/Gauge/CircleCheck`；状态词固定为 `Active/Paused/Blocked/Budget limited/Completed`，不再重复 Goal 前缀或 raw enum。
- objective 为 13px、单行省略、保留完整 `title`；blocked reason 继续包含在可访问描述/title 中，不新增展开状态。
- usage 固定为 `Workflow executionCount`、`Cpu totalTokens`、`Clock3 duration`；数值可缩写显示，但 title/accessible text 保留精确值。
- action 固定为 `Pencil/Pause/Play/Trash2` 的 28px icon button。原 Edit Dialog、mutation、错误、禁用态和按钮矩阵不变；Clear 只有 hover/focus 才转 error tone。
- Composer Card 继续是现有输入与模型/运行控制所有者；只校准 surface、radius、focus 和阴影，不改变 Send/Queue/Stop、键盘或 slash menu。

### HITL, Inspector And Overlays

- Needs you 只在 HITL leading glyph 上执行两次 attention ring；HITL Card 本身不 pulse。问题、选项、批准/拒绝、inspection 和响应流程不变。
- Inspector Tab、Agent tree、Changes、Context 和 Focus Mode 不变；统一 surface、11/12px metadata、选中 Tab brand rail 和 focus ring。
- Dialog/Popover/Menu 使用 overlay surface、10/12px radius 等级和唯一 shadow token；入场只允许 opacity + 4px translate，不使用 scale bounce。

### Project Todos

- 页面定位为“由明确动作推进的工作流板”，不是通用 Kanban。保留 `Board / Rejected / Archived` 三个 view、现有总数、说明、URL 选中 Todo、lane 顺序和全部 mutation；不得增加拖拽、筛选、搜索、批量操作、自动迁移或新的状态。
- Header 使用 page title 16px、总数 count badge 10px 和 body 13px；view switch 是 32px 高的同层 segmented control，active 只用 active surface + brand bottom/leading indicator，不使用 shadow。三个 view 的顺序、`aria-pressed` 和切换 state 不变。
- New Todo 保持单一 title input、Enter 提交和 New Todo button。输入条使用 elevated surface/default border，focus-within 才显示 brand ring；按钮仍是可见文字主操作，不改 disabled、错误反馈、trim 或 mutation。
- Board 在 `>=1200px` 为四列，`800–1199px` 为两列两行，`<800px` 为 Idea → Ready → In Progress → Done 的单列流。删除 `min-w-[880px]` 与 board 横向滚动依赖；各断点不得隐藏 lane、Todo 或操作。
- lane 本身不再是带 shadow 的大 card；使用透明/base 背景、12px gutter 和紧凑 lane header 分组。header 为 `glyph + 12px status title + 11px hint + 10px count`，不显示拖拽把手、drop highlight 或整列语义色背景。
- 空 lane 是 lane 内最小 64px 的静态 inline message，使用 16px neutral/领域 glyph、11px title 和 11px hint；删除大面积 dashed empty card、`min-h-28` 和装饰性空态插画。
- Todo card 使用 surface/default border、8px radius、无 shadow；hover 只提高 border。展开/URL 选中的 card 使用 2px brand leading rail + strong border，不改变宽度、不抬升阴影。展开仍由整行 header button 和 Chevron 控制，单次只展开现有 `expandedId`。
- card header 固定为 `status glyph + 11px sentence-case label -> Chevron -> 13px title`；collapsed body/rejection reason 为 12px、最多两行。card status 严格按 `archivedAt → rejected → done → Activation → ready → idea` 的展示优先级选择 Idea/Ready/In Progress/Done/Rejected/Archived，不再使用 9.5px uppercase 彩色 badge。
- collapsed association row 把 Discussion、Activation 和资源状态表达为紧凑关系行，不使用多个高饱和彩色 pill。Discussion/Activation 保留现有链接与文字；只有 linked/source Session family 的权威 running/stopping 或 resource query loading 可局部旋转。`resourceId` 缺失仅显示静态 Clock3，静态 `In Progress` lane/card 自身不得旋转。
- collapsed card 保留当前由状态决定的一个文字 next action；expanded card 保留 body、rejection reason、Edit、Discuss、Activation resource、所有 lifecycle action、inline rejection form 和 action error 的原顺序、可见矩阵、handler 与导航。视觉只用 primary/secondary/quiet/danger 层级区分，不把现有动作折叠进 More menu。
- expanded detail 使用 elevated surface + subtle top divider；title input 高 32px，body textarea 保留 `rows=4` 和 `resize-y`，不新增固定 height/min-height，二者只共享 radius、字体、padding、border 与 focus token。error 使用 2px error leading rail + 可见文字；Activation detail 是关系 panel，不嵌套成另一个 shadow card。
- Rejected/Archived view 在 `>=800px` 为两列、`<800px` 为单列，复用同一 card grammar 和 expansion 行为；不存在为这两个 view 维护的旧版 card 外观。

### Automations, Settings, Diff And Empty States

- Automations 列表与 detail 保持 schedule、Run now、Edit、Pause/Resume、Invocation 和错误行为。active/paused/disabled 使用上文静态图标映射；schedule、last/next run 为 11px metadata，卡片不因 active pulse。
- Settings、Add/Edit/Close Project 和 Edit Automation 继续使用现有 Dialog 与字段 schema。field label/helper/error 固定为 12/11/11px，input/select/button 高 32px、radius 6px；Advanced JSON/mono 内容为 12/18px。不得因视觉重构改字段、默认值、保存或验证逻辑。
- Diff canvas、Changes Inspector 与 inline Diff 保留现有 added/deleted/hunk 颜色及数据行为；只统一外层 surface、toolbar、tab、border、focus 和 12/18px monospace，不用品牌色覆盖代码 diff 语义。
- Empty、loading、not-found 和 query/error surface 使用同一 page title/body/action scale。通用 async loading 只旋转 glyph，不旋转容器；不新增 skeleton、插画、营销文案或自动重试。
- Project Action Menu、Model Picker、slash menu、Toast/notification 若存在，统一使用 overlay/radius/shadow/focus token；菜单项顺序、快捷键、选择和关闭行为保持现状。

### Responsive Rules

| Viewport | Goal row | Header | Shell/overlay |
|---|---|---|---|
| `>=1100px` | status glyph + label、objective、三个 usage 的 icon/value/unit、全部合法 action | 保留当前完整 metadata | 继承现有双侧栏布局 |
| `800–1099px` | usage 只保留 icon + value，隐藏 unit；objective `min-width: 120px` | 先隐藏总 stats，保留 cwd、Goal、Execution/model、Todo、Inspector | 继承现有侧栏折叠/Inspector 行为 |
| `560–799px` | usage 整组隐藏；status label 保留；objective `min-width: 96px` | `<720px` 隐藏 Execution/model，`<640px` 再隐藏 cwd；title、Execution status、Goal glyph、Todo、Inspector toggle 保留 | 不改变现有 `<800px` Dock/Shell 高度与面板策略 |
| `<560px`（含 390/320） | status label 隐藏但 glyph accessible name 保留；objective `min-width: 48px` 并单行截断；最多三个 action 总宽固定 `92px`（`28×3 + 4×2`） | 只保留 title、Execution status、Goal glyph、Todo 和 Inspector toggle；detail 可截断 | 页面/workstream 无横向滚动；Popover/Dialog 保持至少 8px viewport gutter |

- objective 的 `title`/accessible text 始终为完整内容，截断不改变 DOM 文本。action 不换回文字、不折叠进 More menu、不减少合法操作。
- `IconAction` Tooltip 通过 portal 渲染，位置 clamp 在 8px viewport gutter 内，不受 Goal row、Queue/HITL scroller 或 Composer Dock overflow 裁切。
- Project Bar、Project Sidebar、Inspector 和 Focus Mode 的挂载/折叠/显示断点完全继承现有 Workbench；本表只定义新视觉在既有可用宽度内的保留优先级。

## Presentation Architecture

```text
globals.css
├── surface / type / radius / shadow tokens
├── semantic status tokens
└── motion tokens + reduced-motion override

status-visuals.ts                 # 纯视觉 kind -> icon/tone/motion metadata
├── StatusGlyph.tsx               # 静态 Lucide glyph/tone/accessible label
├── ActivityArc.tsx               # 不确定时长的活动 SVG
├── ProgressRing.tsx              # 只呈现调用方计算好的 percent
└── IconAction.tsx                # icon button + portal tooltip，不触发领域行为

routes/project-todo-presentation.ts # Project Todo lane/status/relationship 的路由局部纯展示映射

Domain components
├── ChatHeader / Sidebar / Dashboard
├── ExecutionWorkstream / DelegationCard / ToolCard
├── TodoProgressButton / SessionGoalProgressRow
├── ProjectTodosRoute / TodoGroup / TodoCard
└── HITL / Automation / Recovery surfaces
```

- `presentExecutionStatus`、`deriveTodoProgress`、Session family activity、Goal/Automation 状态继续是权威事实；共享视觉层不重新推导状态，也不订阅 Store。
- `status-visuals.ts` 不导入 Store、API 或 Protocol 领域对象，不生成产品 label，不读取 raw record；它只保存有限 visual kind 的 icon/tone/motion eligibility。各领域组件在现有事实边界完成下表映射。
- `StatusGlyph` 不包含百分比或领域逻辑；`ActivityArc` 只接受 `size/tone/label`；`ProgressRing` 只接受已经由 `deriveTodoProgress` 算好的 `percent/size/tone/label`；Tool Loader 只旋转内部 SVG。四者不得互相复制实现。
- `IconAction` 只组合原 button props 与 portal tooltip。Tooltip 必须越过 Composer Dock 的 overflow 边界且限制在 viewport gutter 内；它只拥有 hover/focus 可见性，不包装、改写或延迟原 handler。
- 各领域组件只把自己的现有状态映射为有限的视觉 kind；图标、tone、尺寸和运动规则由唯一视觉映射渲染，删除散落的 class map。
- `project-todo-presentation.ts` 只接收显式 lane/status/relationship fact，拥有 Project Todo 的 glyph/tone/presentation metadata；不导入 query/mutation/runtime Store，不复制 `deriveProjectTodoGroups`，也不把 Project Todo status 扩进共享 runtime visual kind。
- 不建立通用 Card/Button framework、主题编辑器、可配置密度或新 UI 状态机。`IconAction` 的职责固定为原生 button + accessible portal tooltip，不吸收 tone mapping、mutation 或业务可见性。

## Plan

1. **建立新设计语言**：一次性落地深浅主题的 surface、text、border、semantic、type、spacing、radius、shadow 和 motion token；按“工作台而非卡片墙”替换旧视觉基础并删除被替代的 pulse/glow/shadow 规则。
2. **建立高内聚展示 primitive**：增加纯视觉 `status-visuals`、`StatusGlyph`、`ActivityArc`、`ProgressRing` 和 `IconAction`；为 Project Todo 增加路由相邻的 presentation module，禁止 primitive 读取领域状态。
3. **统一 Runtime 状态呈现**：硬切 Header、Sidebar、Dashboard、Execution、Delegation、Tool、Recovery、HITL 和 Automation 的分散样式；Session/Execution 使用活动圆弧，Tool 只旋转 glyph，Session Todo 使用确定性进度环，静态状态不循环。
4. **重做 Goal 控制条**：移除 `◎` 和重复 raw status；锁定五种状态图标、主目标层级、用量图标和 Edit/Pause/Resume/Clear 图标操作，保持原按钮矩阵和 mutation。
5. **重做 Project Todo 工作面**：保留 Board/Rejected/Archived、四 lane grouping、Activation/Discussion 和完整 action matrix；硬切为 flat workflow board、无 shadow card、关系行与 4/2/1 列响应式布局，明确 In Progress 与实际 Running 的区别。
6. **统一其余工作台质感**：收敛 Composer、Inspector、Automations、Settings、Diff、overlay 和 empty state 的字号、间距、边界、圆角与阴影，分别校准明暗主题与所有锁定 viewport。
7. **清场与验收**：删除旧 class map、旧状态 DOM、Project Todo 旧 presentation maps 和兼容样式；补齐 token/组件/交互/响应式测试、reduced-motion 检查、全量构建和真实浏览器状态矩阵。

## Non-goals

- 不改变 Session/Execution/Goal/Todo/Automation/HITL/Tool 的状态值、投影规则、生命周期或文案所代表的产品语义。
- 不新增、删除或重新排序产品操作；不改变 Goal 控制矩阵、Queue/Steer、Stop、Todo popover、Tool disclosure、Inspector、Dashboard section 或响应式侧栏行为。
- 不修改 `packages/protocol`、`packages/agent-core`、`apps/server`、持久化 schema、SSE、API 或依赖清单。
- 不改变产品名称、Logo 或营销品牌，不建设插画、可换肤系统、通用 Design System、Storybook、复杂时间线或粒子/背景动画；应用内现有组件设计语言则明确在本 Goal 中被替换，不属于保留项。
- 不借视觉改造修复领域状态矛盾；若权威 Store 同时投影出看似冲突的状态，只能明确各状态所属对象，不能在 UI 中猜测或改写事实。

## Risks And Controls

| 风险 | 控制方式 |
|---|---|
| 视觉共享层变成第二套状态机 | primitive 只接受视觉 kind；领域映射仍在现有组件边界，禁止读取 Store/API |
| 图标化降低可理解性 | 状态保留简短文字；图标操作提供 hover/focus Tooltip、`aria-label` 和原处理函数 |
| 持续动效争抢注意力 | 只允许真实 running/streaming 循环；同一局部最多一个循环动画；其他状态静止 |
| 明暗主题或窄屏回归 | 每个 token 双主题定义；1440/1024/390/320px 浏览器矩阵逐项验收 |
| 大范围 CSS 清理误伤功能 | 先锁定行为测试；删除只发生在替代样式落地后，最终搜索证明无旧路径 |
| 把 Project Todo `In Progress` 或缺失 resource 误画成实时 Running | lane/card 的 Play 和无 `resourceId` 的 Clock3 静止；只有 linked/source Session family 或 query 的权威 in-flight fact 可显示局部活动 glyph |
| Project Todo 响应式重排改变内容可达性 | 只改 CSS grid，从 4→2→1 列保持 lane/DOM 顺序；320px 逐项验证所有展开内容和 action 可达 |

## Acceptance Criteria

以下 AC-01 至 AC-09 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：纯视觉边界没有越界

- 产品代码改动仅位于 `apps/web`；`packages/protocol`、`packages/agent-core`、`apps/server`、API、SSE、Store schema 和依赖清单无 diff。
- 现有领域状态输入/投影、mutation、onClick/onSubmit、路由、排序、展开规则、控制可见性和 API/Store 数据字段保持不变；允许 Web-only presentation adapter 透传已有 raw/activity fact 或拆除会丢失状态的旧 `BadgeStatus` 压缩，但不得改变 Dashboard section membership/order 或生成新领域状态。行为测试证明 Goal 五状态按钮矩阵、Todo popover、Tool disclosure、Queue/HITL 和 Stop 无回归。
- 只允许 `IconAction` Tooltip 和 post-mount transition effect 使用局部展示 state/ref；测试证明它们不读取或写入 Store/API/URL，不改变或延迟原 action handler，也不生成领域事件。
- 不新增 feature flag、legacy prop、deprecated alias、兼容 class、隐藏旧 DOM 或新旧主题切换路径。

### AC-02：视觉基础只有一个权威来源

- 深色和浅色主题都从 `globals.css` 的唯一 token 集得到 surface、text、border、info/success/warning/error/neutral、radius、shadow 和 motion；被改组件不得复制 raw hex、状态颜色或时长常量。
- `status-visuals` 是共享 runtime 图标、tone 与运动资格的唯一映射；删除 `BADGE_CLASSES`、`EXECUTION_STATUS_CLASS`、Execution `STATUS_CLASS`、Tool/Recovery `STATUS_CONFIG` 的外观字段、Sidebar 两套 status-dot map、Dashboard Goal class map 及其旧测试，不保留 re-export。Tool/Recovery 可保留领域 label，但不能保留第二套颜色、图标或动效映射。
- Project Todo 删除 route 内旧 `STATUS_STYLES` 以及 `LANE_PRESENTATION.iconClass/badgeClass` 外观字段；lane/status/relationship metadata 只有 `project-todo-presentation.ts` 一个权威来源。依赖测试证明该模块不导入 query、mutation、runtime Store 或 Protocol reducer，且共享 `status-visuals` 不新增 Project Todo status。
- `StatusGlyph`、`ActivityArc`、`ProgressRing` 和 `IconAction` 的 public props 分别只包含文档锁定的展示输入；依赖审计证明前三者不导入 Store/API/Protocol，`ProgressRing` 不计算 Todo percent，`IconAction` 不导入 mutation hook。
- 旧 `pulse-dot`、`pulse-ring`、状态 Glow 和无消费者样式全部删除；若某动画仍有合法非状态消费者，必须改为准确命名且只由该消费者使用。

### AC-03：语义色、图标和所属对象一致

- Running/进行中在 Header、Sidebar、Execution、Delegation、Tool 和 Dashboard 统一为 info tone；Completed 统一为 success；Needs you/paused/blocked/budget limited 为 warning；Failed 为 error；Stopped/idle/unknown 为 neutral。
- 每个主状态同时具备图标或形状、语义色和可读名称；组件测试在不检查颜色 class 的条件下，仍能分别通过 icon identity 与 accessible label 断言 Running、Needs you、Paused、Completed、Failed 和 Stopped。
- Header 明确显示 Execution 状态，Goal 行明确显示 Goal 状态，Todo trigger 明确显示 Todo 比例；同屏不再出现没有所属对象的多个泛化 `Running`。
- Goal active、Automation active、paused、blocked、budget limited、completed、failed、stopped、idle 和 unknown 均无循环动画。
- Execution/Child 的 label/detail 与四种 `ProductExecutionStatus` 完全不变；raw `failed/timed_out/max_steps` 只让现有 `Stopped · detail` 使用 error visual，raw `aborted/cancelled/interrupted` 使用 neutral visual，不新增产品状态或修改 presentation function 返回值。
- Project Todo 的 Idea/Ready/In Progress/Done/Rejected/Archived 分别使用 brand/info/info/success/error/neutral 的锁定 glyph；In Progress 的 Play 与缺失 `resourceId` 的 Clock3 静止，只有 association row 内权威 Session family running/stopping 或 query loading fact 可以循环。

### AC-04：Running 与进度表达完成硬切

- Session Header 使用 `ActivityArc + Running`，由 Header 所有权与 accessible label 明确这是 Execution 状态；Sidebar running 使用同语义的小尺寸圆弧且无 Glow；Execution running 使用 info 状态图标和 2px 活动侧轨，不用阴影冒充运行。
- Tool running 只旋转 Loader SVG；其 18px 背景容器的 computed transform 始终为 `none`。pending/completed/error 图标静止。
- Todo trigger 显示由现有 `percent` 驱动的 14px SVG 进度环和 `completed/total`，不显示 Spinner 或无主语的 `Running`；popover、百分比和 Todo 行为保持原样。
- Reasoning streaming 只在 `Sparkles/Thinking…` 局部表达活动；同一 Execution 内即使 Tool 与 Reasoning 同时更新，也不存在整卡 pulse、边框旋转或背景 shimmer。

### AC-05：Goal 控制条清晰且操作不变

- Goal 行最小高度为 42px，生产 DOM 中不存在 `◎`、`Pursuing goal + active` 或 `Goal paused + paused` 这类重复状态；objective 使用至少 13px 正文并占据主要弹性空间。
- 状态图标固定为：active=`Target`、paused=`CirclePause`、blocked=`CircleAlert`、budget limited=`Gauge`、complete=`CircleCheck`；所有图标静止并有状态名称。
- execution count、tokens、duration 分别使用 `Workflow`、`Cpu`、`Clock3` 加可见数值；窄屏可按现有断点隐藏统计，但 objective、状态和合法操作不可被挤出或遮挡。
- Edit、Pause、Resume、Clear 分别使用 `Pencil`、`Pause`、`Play`、`Trash2`；每个按钮保持原 handler、disabled/loading/error 和可见性矩阵，点击热区至少 28px，键盘 focus 可见，Tooltip 可由 hover 与 focus 触发，Clear 仅在 hover/focus 呈危险色。
- Header 与 Sidebar 继续保留 Goal 状态可见性，但改为紧凑图标/短标签，不再显示 `Goal · raw_status`；完整 objective、用量和控制只有 Composer Goal 行拥有。

### AC-06：工作台排版与表面达到统一层级

- Header/Sidebar/Goal/Execution/Delegation/Tool/Dashboard/Todos/Automations/Settings/Diff chrome 的主内容不小于 12px，状态与次要 metadata 不小于 11px；仅纯数字 count badge 可使用 10px。
- 被改表面只使用统一 radius token；生产代码不再出现为旧状态条单独存在的 `rounded-[10px]` 或重复 shadow 值。
- 常驻 Execution、Tool、Reasoning 和 Sidebar item 不使用 ambient shadow；阴影只用于 Composer、Dialog、Popover、Menu 等真实浮层。当前 Execution 依靠侧轨和状态图标，不依靠更重阴影。
- Project Todo lane/card/expanded detail 无 `box-shadow`；lane 依靠 gutter，card 依靠 border，expanded card 依靠 2px brand leading rail + strong border 表达层级。静态源码与浏览器 computed-style 均须证明旧 shadow card language 已消失。
- 深浅主题中 base/surface/elevated/overlay 必须解析为四个不同 computed color；primary/secondary/tertiary、brand 和五个 semantic foreground 对 surface/elevated 及各自 semantic subtle background 的对比度至少 `4.5:1`，五个 Agent identity foreground 对 surface/elevated 也至少 `4.5:1`，focus ring 与非文本交互边界至少 `3:1`。muted 只用于 disabled/placeholder/装饰。自动 token contrast test 必须逐项通过，1440px 截图再确认 Goal/Running/Needs you 只做局部强调而非整块高饱和背景。

### AC-07：动效与无障碍均可验收

- motion token 固定为：hover/press `120ms`、icon/chevron `160ms`、popover/dialog `220ms`、activity loop `1600ms linear`、Needs-you attention `700ms × 2`、complete reveal `180ms × 1`；本 Goal 修改范围内不存在未命名的任意 duration。
- 循环动效只作用于活动圆弧、Tool Loader 或 streaming glyph，且只使用 transform/opacity/SVG stroke；不得动画 width/height/top/left、整卡 border、box-shadow 或背景位置。
- `prefers-reduced-motion: reduce` 下所有循环和位移动画停用，状态图标、文字、颜色和确定性进度仍完整可辨；测试验证 computed animation 为 `none` 或 duration 为 `0s`。
- initial mount、历史展开、route return、root/Child 切换和 theme change 不播放 attention/reveal；只有同一 mounted identity 的 visual kind 真正转换到 Needs you/Completed 时分别播放 `700ms × 2` / `180ms × 1`。组件 rerender/remount 测试逐项证明不重播，CSS contract 与 computed-style 测试分别证明时长/次数和 reduced-motion 归零；实现不引入 JavaScript animation timer，因此不使用与实现无关的 fake timer。
- 动态主状态使用非打断式 status 语义，不制造多个重复 live region；所有 icon-only 操作有 accessible name，Tooltip 不承载完成任务所必需的唯一信息。

### AC-08：自动化、真实浏览器与 Hard-cut 证据完整

- 单元/组件/交互测试覆盖全部 visual kind、Execution 四种产品状态、Goal 五状态、Session family activity、Automation 三状态、Tool 四状态、Session Todo 0%/部分/100%、Project Todo 六种 presentation、Tooltip 键盘行为和 reduced motion。
- 在独立 QA workspace 通过真实产品流程验证至少：实际 Running Execution、Needs you HITL、paused Goal、部分 Todo、running/completed/error Tool、completed/stopped Execution 和 active/paused Automation；不得只用静态 DOM 伪造浏览器验收。
- 浏览器矩阵覆盖 dark/light × 1440/1024/700/390/320px，以及 Dashboard、Session、Composer、Sidebar、Inspector 开关、Project Todos、Automations list/detail、Settings、Diff 和 empty/not-found surface；无横向滚动、遮挡、不可达操作，console error 为 0。
- 实施进度文档必须提供浏览器 evidence table，每行包含：真实状态产生步骤、权威 Store/record 来源、稳定 selector、期望 label/icon/tone/animation、theme、viewport、截图 artifact 路径和 console 结果。不得用新产品 fixture route、手工改 DOM 或仅凭 className 代替真实状态验收。
- `bun run typecheck`、`bun run test`、`bun run web:build`、`git diff --check` 全部退出码为 0。
- 生产搜索证明不存在旧状态 class map、`◎`、Goal raw-status 重复文案、状态 Glow、persistent-state `animate-pulse`、Session Todo Spinner、旋转 Tool 背景、Project Todo 旧 `STATUS_STYLES`/lane style fields/`min-w-[880px]`/lane-card shadow、legacy/fallback/compat 路径；Reviewer 必须逐项给出 AC-01 至 AC-09 的文件、测试、搜索和浏览器证据。

### AC-09：Project Todo 成为完整且诚实的工作流工作面

- Board/Rejected/Archived 三 view、Idea→Ready→In Progress→Done lane/DOM 顺序、`deriveProjectTodoGroups` 输出、URL selection、Discussion/Activation links、collapsed next action、expanded content、action 顺序和全部 mutation/navigation/disabled/error 行为与改造前测试快照一致。
- Board 的 computed grid 在 1440px 为 4 列、1024px 为 2 列、700/390/320px 为 1 列；Rejected/Archived 在 1440/1024px 为 2 列、700/390/320px 为 1 列。各 viewport 的 page、board 和 card `scrollWidth <= clientWidth`，不存在 `min-width: 880px` 或 lane 横向滚动。
- lane 无 border/shadow card shell；Todo card 默认和 hover 的 computed `box-shadow` 为 `none`，expanded/URL-selected card 的 2px brand leading rail 与 strong border 可见且不改变 card 宽度。empty lane 不含 dashed box、`min-height: 7rem` 或装饰插画。
- card status 按 `archivedAt → rejected → done → Activation → ready → idea` 的优先级产生 Archived/Rejected/Done/In Progress/Ready/Idea；测试证明 Archived 只是 `archivedAt` 的展示 override，底层 `ProjectTodo.status`、grouping 和 action matrix 未改变。六种 presentation 的 icon、accessible label 和 tone 与映射逐项一致。
- 静态 In Progress 的 card/lane 与无 `resourceId` 的 Preparing resource 均无 animation；只有 linked/source Session family running/stopping 和 resource query loading 在各自 association glyph 上运行动画，idle/unknown source Session 与 linked Automation active 保持静止。
- 组件测试逐状态展开 card，证明 Edit、Discuss/Continue Discussion、Mark Ready、Reject、Restore to Idea、Start Session、Create Automation、Move to Idea、Mark Done、Return to Ready、Reopen、Archive/Restore 仍按现有条件出现且调用原 handler。title input computed height 为 32px；body textarea 仍为 `rows=4`、`resize-y` 且无新增固定 height/min-height。测试还证明没有 drag handle、`draggable`、drop handler、More-menu 折叠或新产品字段。
- 真实浏览器至少创建并验证一个 Idea、一个 Ready、一个具 Discussion 的 Todo、一个 linked/running Session Activation、一个 linked/active Automation、一个 Done、一个 Rejected 和一个 Archived；dark/light 与 1440/1024/700/390/320px 截图中，标题/正文/关系/操作均可读、可聚焦、可点击，console error 为 0。
