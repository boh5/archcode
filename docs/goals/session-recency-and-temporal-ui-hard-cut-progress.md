# Session Recency And Temporal UI Hard-Cut Progress

本文件只记录 `session-recency-and-temporal-ui-hard-cut-plan-goal.md` 的执行过程、证据、偏差与风险；目标、锁定决策和验收标准仍以 plan-goal 文档为准。

## Status

- 当前阶段：完成
- Goal：complete
- 开始时间：2026-07-25 23:50 CST
- 最晚主动暂停：2026-07-26 01:20 CST
- 独立终审：`sol(xhigh)` 第三轮 `PASS`

## Execution Log

### 2026-07-25 — Baseline And Parallelization

- 当前工作树在实施前只有未跟踪的 plan-goal 文档，没有需要绕开的用户代码改动。
- 锁定两条主线：Agent Core 的 Session recency/durable repair；Web 的 shared clock、纯 formatter、Temporal primitives 和全部动态时间表面硬切。
- 并行委派：
  - `backend_persistence`：Agent Core no-op persistence、并发 barrier、restart durable repair 和聚焦测试，`sol(high)`。
  - `frontend_temporal_core`：Web clock/formatter/primitives 及聚焦测试，`sol(medium)`。
  - `temporal_migration_audit`：全部动态时间调用面和测试矩阵只读审计，`terra(high)`。
- 主执行负责 progress、跨边界集成、业务组件迁移、全量验证、真实浏览器验收和最终 `sol(xhigh)` 独立 review。

### 2026-07-25 — Dynamic Time Migration Audit

- 独立只读审计确认动态表面完整：七类 relative time、Execution/Delegation elapsed、Recovery countdown；未发现第八类会随 wall clock 自行变化的产品展示。
- Automation、Todo、artifact expiry 和 Goal 累计 duration 均为静态展示，继续保持 Non-goal，避免扩大 formatter 语义。
- Delegation 当前 ViewModel 未投影 `endedAt/durationMs`；实现只需对当前可见 running elapsed 建立共享订阅，不为了本 Goal 新增终态时长产品面。
- Recovery countdown 必须保留 `Math.ceil`，elapsed 必须保留 `Math.floor`，两者不能错误复用同一舍入语义。
- Sidebar 的 short visible、full relative accessible name 和 absolute tooltip 必须共享同一个 clock snapshot，但不是强制三段文案相同。
- Session store 中用于本地写入/缓存时间的 `Date.now()` 不是展示时钟 owner，不属于清理范围。

### 2026-07-25 — Backend And Temporal Core Implementation

- `commitDurableSessionMutation()` 已按顶层 `Object.is` 过滤 patch；纯 no-op 不替换 Store、不通知、不新增写盘、不推进 `updatedAt`，但会等待并传播调用时观察到的 pending persistence barrier。
- `setTitle`、parent identity setter 与 `updateToolBatches` 已切到同一 no-op 语义；真实 patch/event 仍由单一 writer 严格推进 canonical `updatedAt`。
- restart interrupted reconcile 已从 read projection 中拆出，只由 authoritative hydration 使用同一个 `now` 修复 execution、child link、unfinished part、executing command receipt；真实 repair 一次落盘，clean load 零写盘，二次 hydration 幂等。
- repair 与 orphaned Steer rollback 保持两个串行领域事务，不再依赖误写盘副作用。
- Web 已新增 shared second/minute external clock、显式输入的纯 formatter、`RelativeTime`、`useRelativeTime`、`useElapsedTime`、`useCountdown`；旧隐式 formatter 签名已删除。
- Strict Mode 的 60 秒 cadence 切换初版会因切换到数值相同的 idle minute snapshot 丢掉一次可见更新；已更正为先用当前 cadence 完成 60 秒 render，再在 effect 中切换，full/short 均立即显示分钟值且不泄漏 scheduler。

### 2026-07-25 — Product Surface Migration And Test-Harness Correction

- Sidebar、Dashboard attention/Session、HITL、用户消息、Hard Compact、Dynamic Compression 已全部切到语义化 `RelativeTime`；Sidebar 的 short visible、full accessible name 和 absolute tooltip 共享 clock。
- Execution 与 Delegation elapsed、Recovery countdown 已删除私有/偶然刷新路径，统一使用 shared Temporal hooks；terminal/inactive 状态不订阅 second clock。
- `ExecutionWorkstream.parts.test.tsx` 的旧 fake React 把所有嵌套组件的 hook state 放在同一 slot 数组，新增合法 Temporal hook 后暴露了跨组件 state 污染；已按 component instance 隔离 slot，并把 ToolCard 详情/Artifact Viewer 的测试改为显式交互，不再依赖错误的 hook 碰撞“自动展开”。

### 2026-07-26 — Automated Verification

- Web 定向 temporal/business tests 通过；Web 全量 unit `510 pass / 0 fail`，interaction `93 pass / 0 fail`。
- Agent Core 定向四文件回归 `109 pass / 0 fail`，覆盖 no-op barrier、失败传播、重启修复、root 排序和恢复组合。
- `bun run typecheck`：5/5 workspaces 通过。
- `bun run test`：8/8 Turbo tasks 通过；其中 Agent Core integration `131 pass`、architecture `77 pass`。
- `bun run build`：Web 2710 modules / 308 assets 和 production binary pipeline 均成功，退出码 0。

### 2026-07-26 — Real Browser Acceptance

- In-app Browser 直接连接现有 Vite/Server，通过公开 Dashboard、项目 Sidebar 和 Session 页面验收；没有 debug route、fixture API 或生产 fallback。
- Dashboard 与 Sidebar 的 relative time 在无 API/SSE/鼠标操作时跨过共享 minute tick 自动推进；全部当前可见 `<time>` 均具有有效 `datetime`、本地绝对时间 `title` 和组合 aria 文案。
- 桌面 1280×720 与窄屏 390×844 的 document/body 均无横向溢出；窄屏项目 Session 抽屉可正常打开，时间列未挤压出视口。
- 在现有 `Visual QA Session Activation` 中通过公开 composer 发起一次只读运行态：Lead Execution 从 `0s` 持续推进；Build Delegation 从 `1s` 推进到 `24s`，期间没有新的 StreamEvent 才驱动每秒显示。
- 切到空白标签页 4 秒后返回，Execution 由 `28s` 立即校正到 `32s`，Delegation 由 `20s` 校正到 `24s`；没有补跑丢失 tick。
- 完成后 Execution 固定为 `Worked for 50s`，2.2 秒后仍不变；Delegation 转为 `Completed` 且不再呈现 live seconds。两轮浏览器流程 console error 均为 0。
- 浏览器 QA 只新增上述现有测试 Session 的消息、Execution 和只读 child Session 记录；Build 子 Agent 只执行 `sleep 25`，没有修改项目文件。

### 2026-07-26 — Independent Review Round 1 And Corrections

- 独立 `sol(xhigh)` 终审结论为 `NEEDS_FIXES`，识别四组实质缺口：Temporal hook 把 external snapshot 只当 rerender trigger、cold public Session read 可返回 restart ghost running、缺少正向 clock-owner 架构测试、领域级并发与非公开 temporal surface fixture 不足。
- 第一性原理更正：删除 `TimeClock.readNow()`；relative、elapsed、countdown 的 formatter 只消费 external store 发布/缓存的 scalar。hidden 期间即使父级重渲染也不推进，visible/focus 后才由 store 校正。
- Sidebar 改为一次 `useRelativeTimePresentation()` 派生 full/short，再由无时钟的 `RelativeTimeValue` 渲染语义节点，消除阈值边界的两次 wall-clock read。
- `getSessionFile()` 明确为公开 current-state read，统一经过 `getOrLoad()` authoritative hydration；tree/depth 继续直接读取 raw identity projection。公开读取不再暴露 persisted `running/executing` ghost，同时 clean read 保持零写盘。
- 新增正向 Web architecture test：生产代码只有 Temporal primitive 可直接依赖 clock/formatter，业务 component/route 不拥有 interval；没有枚举已删除名称。
- 新增真实 React/JSDOM surface fixture：Hard Compact 与 Dynamic Compression 从 `59s` 跨到 `1m`，Recovery 从 `2s` 到 `1s` 再到零，并验证状态离开 scheduled 后无 second scheduler；三个表面共享同一 second scheduler。
- 新增 `SessionInputService` 领域级 delayed-save success/failure：`acceptMessage` 与 `claimCommand` 的 replay 均不得越过首写 barrier，成功只写一次，失败同时传播。`claimCommand` 保留 owner=`claimed`、replay=`executing receipt` 的防重复副作用语义，不为字面结果相同破坏 ownership。
- 修复后验证：Web `513 unit / 0 fail`、`93 interaction / 0 fail`；Agent Core 聚焦 `113 pass / 0 fail`；root typecheck 5/5；`git diff --check` 通过。
- 已向同一独立审查者发起第二轮只读复审。

### 2026-07-26 — Review Closure And Final Verification

- 第二轮复审只剩一项测试证据问题：Recovery fixture 先到零再切状态，无法独立证明“状态变化导致退订”。
- fixture 已更正为 target 尚余 1 秒时执行 `scheduled → retrying` 并验证 second scheduler `1 → 0`，再执行 `retrying → scheduled` 验证 idle snapshot 刷新与 scheduler `0 → 1`，最后到达 target 再次退订。
- 第三轮同一独立 `sol(xhigh)` 复审逐条核验 AC-01～AC-08，最终结论 `PASS`，无实质 blocker。
- 最终工作树验证：`bun run typecheck` 5/5、`bun run test` 8/8、`bun run build`、`git diff --check` 全部退出码 0。
- 最终当前代码浏览器复验：Execution 7 从 `1s` 连续推进；Delegation 从 `1s` 推进，隐藏标签页 3 秒后 Execution `16s → 19s`、Delegation `9s → 12s` 立即校正；终态 Execution 固定 `Worked for 36s`，Delegation 不再显示 live seconds；全部 `<time>` 语义属性有效，console error 为 0。

## Acceptance Evidence

- AC-01：PASS — 三个静态 root 的 restart JSON/mtime/recency/顺序不变，child 保持 root-only 边界。
- AC-02：PASS — no-op identity、subscriber、write、barrier、领域 replay success/failure 和真实 mutation 写入次数均有确定性证据。
- AC-03：PASS — public current-state read authoritative repair 一次、二次幂等；clean/tree/depth 零写；repair+Steer 两事务。
- AC-04：PASS — shared scalar、single scheduler、cold mount、Strict Mode、hidden/focus、退订和正向 owner architecture test 均通过。
- AC-05：PASS — 七类 relative surface 全部迁移；阈值、自动推进、语义 `<time>` 和 Sidebar 单 snapshot 已验证。
- AC-06：PASS — Execution/Delegation/Recovery 共享生命周期；elapsed/countdown 舍入、状态退订、冷重订阅和终态冻结已验证。
- AC-07：PASS — 无旧签名、fallback、双路径、私有动态 interval、跨层 browser clock 依赖或墓碑测试。
- AC-08：PASS — 定向/全量/typecheck/build/diff、真实 React fixture、桌面/390px 浏览器和最终独立 review 均通过。

## Corrections And Risks

- 已识别风险：不能把“no-op 不新增写盘”实现成绕过已有 pending persistence；幂等 replay 必须等待并传播首写结果。
- 已识别风险：当前空 Steer 误写盘会顺带保存 load-time interrupted repair；删除误写盘前必须先建立显式 durable repair owner。
- 已识别风险：external clock 的零订阅缓存、Strict Mode 订阅生命周期和后台标签页恢复容易形成旧快照、泄漏或重渲染风暴，必须以可控 scheduler 验证。
- 历史上已经被重启污染的 `updatedAt` 无法可靠回推，本 Goal 不猜测性修复旧数据。
- 第一轮审查纠正：shared scalar 必须是 formatter 的唯一 `now`，不能只用于触发 render 后再读取 wall clock。
- 第一轮审查纠正：公开 current-state read 与 raw identity projection 必须分责；前者 authoritative hydration，后者只服务 tree/depth 等无副作用结构读取。
