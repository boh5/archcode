# Session Conversation Surface Hard-Cut Goal

## Objective

彻底重构 Web Session 中央对话面，使其在不改变 Workbench 三栏职责的前提下更宽、更紧凑且边界稳定。正常对话统一使用一条内容轨道；删除重复的用户头像和逐条 Agent 名称；保留现有 Agent 颜色身份；工具调用默认收敛为摘要行，需要时再展开详情。

本次直接替换旧布局和旧工具卡展开逻辑，不保留 feature flag、fallback、旧 DOM、双样式或兼容分支。

## Locked Product Contract

```text
Session center column
├── full-width transcript scroller
│   └── one shared conversation rail (max 880px)
├── full-width HITL/footer surface
│   └── the same conversation rail
└── full-width composer surface
    └── the same conversation rail
```

- 主轨道最大宽度固定为 `880px`，桌面横向 gutter 为 `20px`，窄屏为 `16px`；使用显式像素值，避免受当前 `13.5px` 根字号影响。
- Agent 正文、用户气泡、工具调用、委派/压缩内容、HITL 和 Composer 共享同一条轨道。用户气泡可在轨道内保持右对齐和现有最大占比，这不构成第二条轨道。
- 删除所有用户消息状态中的头像；删除每条 Agent 消息重复显示的名称和彩色圆点。Agent 消息继续使用现有 `resolveAgentAppearance(...).borderClass` 彩色左边线，八个内置 Agent 的语义配色不得改变；只为已删除名称/圆点服务且已无生产消费者的 appearance 字段和映射必须同步删除。
- Agent 身份仍在 Agent Tree、子 Session/委派视图等需要区分执行主体的位置展示；本次不删除全局 Agent identity。
- 正常轮次间距为 `16px`，同一回复内相邻内容为 `8px`，连续/分组工具项为 `4px`；Markdown 段落、列表和代码块节奏只在 conversation scope 内收紧。
- 单个 Tool 默认只显示一行：状态、工具名、主要目标、必要的次要摘要；输入、输出、错误详情、问答记录和内嵌 Diff 统一放入同一个展开区。
- 有合法 Diff metadata 的工具摘要行始终显示 `N files`，并仅在每个文件都提供完整计数时追加 `· +A −D`；展开后继续使用现有 `DiffView`。现有完整 Diff canvas、Changes 入口和 Session `view=diff` 路由不改。

## Architecture Boundaries

- 新增一个 conversation-specific rail/layout primitive，作为消息、HITL 和 Composer 对齐规则的唯一来源；不得在三个消费者中复制 `max-width` 与 gutter 组合。
- `ChatMessages` 只负责 transcript 滚动、顺序和消息渲染；滚动容器不得再次承担内容最大宽度。
- `ToolCard` 继续拥有单个工具的 disclosure 与详情展示；`GroupedToolCard` 只拥有批次折叠，不建设通用 Card framework 或第二套 Tool renderer。
- Agent 颜色继续由 `apps/web/src/lib/agent-constants.ts` 单一管理；消息组件不得复制 Agent 到颜色的映射。保留 Agent 到颜色 token 的既有对应关系，但不以“保留颜色”为由留下已无生产消费者的 dot/name presentation mapping。
- Conversation Markdown 密度必须使用局部 class/variant，不得通过无作用域的 Streamdown 标签覆盖影响其他页面。
- 不修改 Protocol、Server、Agent Core、Session Store 或 Diff 数据契约；本次是 Web presentation hard cut。

## Non-goals

- 不重构 Workbench 左栏、右侧 Context Inspector、顶部 Session header 或响应式侧栏策略。
- 不改变完整 Diff 工作区的布局、入口、数据加载或交互。
- 不改变 Agent 配色、Tool 状态语义、HITL 流程、Queue/Steer 行为或 Composer 功能。
- 不调整全局根字号，不引入可配置密度、用户布局偏好、通用 Design System 或宽内容 breakout 系统。

## Plan

1. **统一布局所有权**：建立唯一 conversation rail；将 `ChatMessages` 拆成全宽 scroller + rail，并让 HITL、`ChatInput` 的全宽背景内层复用同一 rail；删除旧 `max-w-3xl` 和重复 padding。
2. **硬切消息外观**：删除 canonical、queued、sending、failed 用户消息的头像；删除 Agent 逐条名称、圆点和常驻时间，时间改为 hover/现有操作控件 focus-within 可见且不新增消息级 Tab 停靠点；保留彩色左边线及其唯一颜色来源。
3. **收紧内容节奏**：用 conversation-scoped 样式统一轮次、消息块、Markdown 段落/列表/代码块和 grouped tools 的间距，删除与新节奏冲突的旧 margin/padding。
4. **重构 Tool disclosure**：以“整张工具记录折叠/展开”替换当前只检测长输出的机制；删除 DOM 高度测量和五行预览分支；折叠行保留状态、目标和 Diff 统计，展开区承载全部详情。
5. **验证并清场**：补齐组件、交互、响应式和浏览器视觉验证；搜索并删除被替代的头像 DOM、Agent message header、旧宽度类、long-output 状态和任何兼容实现。

## Acceptance Criteria

以下 AC-01 至 AC-06 必须全部有代码、测试或浏览器证据；任一条件缺失即为 `NOT_DONE`。

### AC-01：统一轨道真实生效

- 在中心栏可用宽度至少 `880px` 时，transcript、HITL 内容和 Composer 的 rail 外宽均为 `880px`，左右边界一致，允许的测量误差不超过 `1px`。
- 在中心栏不足 `880px` 时，三者使用全部可用宽度并保留至少 `16px` 左右 gutter；页面和 transcript 不产生横向滚动。
- `ChatMessages` 的 scroll container 占满中心栏；生产代码中不再以 `max-w-3xl` 或其他第二组 max-width 限制正常对话内容。

### AC-02：身份信息精简且 Agent 颜色不丢失

- canonical、queued、sending、failed 四类用户消息均不渲染头像或用户名，仍保持右对齐气泡和状态操作。
- Agent 消息不再逐条渲染 Agent 名称或彩色圆点；时间保持屏幕阅读器可读，视觉上只在消息 hover 或现有操作控件触发 `focus-within` 时显示，不得为此给消息容器新增 `tabIndex` 或 Tab 停靠点。
- 每条 Agent 消息仍使用 `resolveAgentAppearance` 返回的彩色 border；Engineer、Goal Lead、Plan、Build、Reviewer、Explore、Librarian、Shaper 到现有颜色 token 的对应关系逐项保持不变。若 `AGENT_DOT_CLASS`、`AGENT_NAME_CLASS` 或对应 `AgentAppearance` 字段在移除消息头后没有生产消费者，则必须删除，不能保留测试专用或兼容导出。
- Agent Tree、委派卡和子 Session 身份展示不因本次改造被删除或失去颜色。

### AC-03：垂直密度符合锁定节奏

- 浏览器计算样式证明：正常轮次间距为 `16px`、同一回复主要块间距为 `8px`、连续工具项间距为 `4px`。
- Markdown 段落、列表、引用和代码块不再叠加 Streamdown 默认大间距；连续两段正文、正文接列表、正文接代码块均无超过 `16px` 的非语义空白。
- 密度规则只在 Session conversation/Compression 内容中生效，其他页面的 Markdown 或普通排版不发生全局回归。

### AC-04：ToolCard 只有一个展开模型

- pending、running、completed、error、unknown-result 工具始终先显示单行摘要；存在详情时整行可展开，展开状态控制全部 input/output/error/Q&A/Diff 详情。
- 折叠态 DOM 中不存在详情内容；展开后当前结构化 `ask_user`、invalid input、unknown result、长输出和 malformed metadata 的安全展示行为完整保留。
- 删除 `isLong`、输出高度测量、五行输出预览以及仅为旧机制存在的样式和测试；不保留新旧两套 disclosure。
- `GroupedToolCard` 折叠时只显示批次摘要；展开后显示可独立展开的工具摘要行，不恢复嵌套的旧常显详情布局。

### AC-05：Diff 边界明确且无额外重构

- 带合法 Diff metadata 的折叠工具行始终准确显示文件数；只有每个 `DiffFile` 都同时提供有限的 `additions` 与 `deletions` 时，才分别求和并显示总新增行和总删除行。任一文件缺少计数、无 Diff 或 metadata malformed 时均省略 `+A −D`，不得把缺失值当作 `0` 或从 hunk 猜测。
- 展开工具后仍可使用当前内嵌 `DiffView` 查看该次修改。
- 完整 Diff canvas、右侧 Changes 入口、文件筛选和 `view=diff` 路由的现有测试与行为保持不变；本 Goal 不新增 ToolCard 到 Session route 的导航耦合。

### AC-06：Hard-cut 完成证据

- 组件/交互测试覆盖共享 rail、四类用户消息、八个 Agent 颜色、时间 hover/focus-within 且不增加 Tab 停靠点、无消费者 appearance 映射清场、Tool disclosure、GroupedTool，以及完整/缺失计数两种 Diff summary。
- 在桌面宽屏、双侧栏展开、中心栏窄于 `880px` 三种状态完成真实浏览器检查；消息与 Composer 对齐、滚动、展开、Queue 操作和 HITL 均可用。
- 生产代码审计不存在旧头像、旧 Agent message header、旧 conversation `max-w-3xl`、long-output fallback、feature flag、deprecated alias 或重复 rail 常量。
- `bun run typecheck`、`bun run test`、`bun run web:build`、`git diff --check` 全部退出码为 0。
- Reviewer 必须逐项给出 AC-01 至 AC-06 的文件、测试、搜索和浏览器证据，不能用“看起来更紧凑”或“测试通过”代替验收。
