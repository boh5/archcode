# Session Conversation Surface Hard-Cut Progress

## Status

`DONE`

## 2026-07-16

- 已锁定 `docs/goals/session-conversation-surface-hard-cut-goal.md` 为唯一实施与验收契约；Goal 文档不记录执行流水。
- 已确认本次只修改 Web presentation 与对应测试，不改变 Protocol、Server、Agent Core、Session Store 或完整 Diff canvas。
- 实施拆为两个并行写入边界：Conversation rail/identity/density 与 Tool disclosure/Diff summary；另设独立只读验收审计，避免写入冲突。
- Hard cut 清场目标已确认：删除旧 conversation `max-w-3xl`、用户头像、Agent message header、无消费者 dot/name appearance 映射，以及 `isLong`/DOM 高度测量/五行输出预览；不保留 feature flag、fallback 或双实现。
- 第一性原理审计发现 `agent-constants.ts` 已声明 Shaper 颜色类，但 `globals.css` 缺少 `--agent-shaper` 与对应 Tailwind theme token；这使八个 Agent 的颜色验收在当前基线上无法成立。本 Goal 补齐 Shaper token，不改变其余七个既有配色。
- 密度审计确认旧 margin 分散在 Reasoning、Compaction、Compression、Recovery 和 grouped tools；实现必须删除这些与统一 `16px / 8px / 4px` 节奏冲突的叠加来源，不能只修改 transcript 外层 `gap`。
- Hard-cut 搜索限定于 Session conversation 生产面：其他页面合法的 `max-w-3xl`、Compression 持久输出 preview 和无关 fallback 不属于本 Goal，避免误删相邻领域行为。
- AC-04/AC-05 实现已完成：`ToolCard` 只保留一个显式 disclosure，所有 input/output/error/Q&A/unknown-result/Diff 详情均从折叠 DOM 中移除；旧 `isLong`、ref、DOM 高度测量与五行预览已删除。`GroupedToolCard` 只负责批次折叠，展开后的子工具仍独立折叠，间距为 `4px`。
- Diff 摘要已收敛为纯 helper：合法 metadata 始终显示文件数，只有所有文件都具备有限 additions/deletions 时才显示总计；部分计数和 malformed metadata 不猜测、不补零。ToolCard 不依赖 Session route，展开后继续复用现有 `DiffView`。
- AC-01 至 AC-03 实现已完成：新增唯一 `ConversationRail`，transcript、HITL、Composer 只复用该 primitive；消息轮次、回复块、连续工具与 conversation Markdown 密度统一收敛为 `16px / 8px / 4px`，旧分散 margin 已删除。
- 消息身份 hard cut 已完成：四类用户消息头像、Agent 逐条名称/圆点、无生产消费者的 dot/name appearance 映射和 More actions 占位按钮均已删除；Agent 时间不占布局高度且不新增 Tab 停靠点，彩色左边线继续由 `resolveAgentAppearance` 单点提供。

## Verification

- Tool disclosure/Diff summary 定向单元测试：116 pass，0 fail。
- Web interaction suite（含真实 React DOM ToolCard disclosure）：51 pass，0 fail。
- Tool disclosure legacy 搜索与 `git diff --check`：退出码 0。
- 根工作区 `bun run typecheck`：5/5 workspace，退出码 0。
- 根工作区 `bun run test`：8/8 task，退出码 0；其中 Web 532 unit + 51 interaction，Agent Core 2863 unit + 137 integration + 100 architecture tests 全部通过。
- `bun run web:build`：Vite 2669 modules，退出码 0；仅有既存 chunk-size warning。
- `git diff --check`：退出码 0。
- 真实浏览器宽屏（中心栏可用宽度大于 `880px`）：transcript 与 Composer 均为 `880px`，左右边界差 `0px`，rail padding `20px`，轮次 gap `16px`，无横向溢出。
- 真实浏览器窄屏（中心栏 `600px`）：transcript 与 Composer 均使用 `600px` 全宽，rail padding `16px`，左右边界差 `0px`，无横向溢出；双侧栏默认状态下两者同样对齐。
- 真实浏览器消息检查：Engineer 左边线为 `rgb(139, 92, 246)`/`2px`；Shaper 左边线为 `rgb(16, 185, 129)`/`2px`；消息正文无 Agent 名称、消息容器无 `tabIndex`，用户消息无头像 SVG。
- 真实浏览器 Tool disclosure：单个错误工具初始 `aria-expanded=false`，展开后详情进入 DOM；分组 `Read 3 items` 初始折叠，展开后显示 3 个仍可独立展开的子工具摘要；浏览器 console error 为 0。
- 真实浏览器密度：Shaper 回复的 `.msg-parts` 计算 `gap=8px`，连续 3 个工具的实测边界间距为 `[4px, 4px]`；实际报告消息中的正文→列表、列表→正文、正文→代码块、代码块→正文均为 `8px`，观察到的其他非语义空白最大为 `13.5px`，未超过 `16px`。
- 真实运行态 Queue/HITL：在隔离临时 Engineer Session 中用一次 Luna 执行产生 `ask_user`；等待 HITL 时成功创建 queued message，Edit→Save 后新文本可见，Delete 后消息从 DOM 移除；HITL 选择 `Yes` 并提交后卡片消失、执行恢复并最终回到 idle。浏览器 console error 为 0。
- 临时运行态已清理：验收 Session 删除成功，`specra-test-projects` Session 数回到原有 `4` 个，pending HITL API 返回空数组；未触碰原有 Session。
- HITL 对齐证据链：live HITL 卡已在真实浏览器出现并可操作；生产路由与测试证明其内层复用同一个 `ConversationRail`，该 primitive 在同一浏览器宽屏状态的 transcript/Composer 计算外宽均为 `880px`，因此不存在独立 HITL 宽度实现或第二组常量。
- 独立 Reviewer 已逐项复核 AC-01 至 AC-06，结论为 `DONE`，`no findings`；架构边界、hard cut 清场、浏览器证据和临时资源清理均通过。
