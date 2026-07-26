# Session Recency And Temporal UI Hard-Cut Plan Goal

## Objective

修复 Session 列表时间在服务重启后被重置为“刚刚”的持久化语义错误，并将 Web 端所有会随现实时间变化的相对时间、运行时长和倒计时硬切到一套统一、可测试、按需运行的 Temporal UI 边界。

完成后，`Session.updatedAt` 只代表最后一次真实、持久的 Session 语义变化；纯读取、加载和幂等 no-op 不得改写它。Web 不再依赖偶然重渲染更新时间，也不允许业务组件各自维护 interval 或在格式化函数中隐式读取 `Date.now()`。

## Evidence Baseline

- Sidebar 使用 `SessionSummary.updatedAt` 作为可见相对时间和 Recent 排序依据。
- Server Host 每次 Runtime 激活都会调用 `recoverSessionContinuations()`；其 Queue 恢复会遍历每个 root Session 并调用 `recoverOrphanedSteers()`。
- 当前 `recoverOrphanedSteers()` 在没有任何 `steering` message 时仍进入 `commitDurableSessionMutation()`；后者无条件调用持久化，而持久化边界无条件把 `updatedAt` 推进到当前时间。
- 最小复现已证明：`recoverOrphanedSteers()` 返回 `0` 条恢复记录时，Session `updatedAt` 仍会前进。因此该问题会持久化污染所有已注册项目的 root Session，并重排 Recent 列表，不是单纯的前端显示问题。
- `#loadFromDisk()` 还会把重启遗留的 running execution、active child link、未完成 text/reasoning part 和 executing command receipt 修复为终态，但当前只修复内存、不直接持久化；空 Steer 恢复的误写盘偶然替它落盘。若只删除 no-op 写盘，这些真实修复会在每次重启重新生成时间和 duration。
- Web 当前有七类相对时间展示：Sidebar Session、Dashboard attention、Dashboard Session、HITL Bell、用户消息、Hard Compact、Dynamic Compression；另有 Delegation/Execution 运行时长和 Recovery retry 倒计时。
- 当前多数相对时间没有刷新源；Execution 和 Recovery 分别维护自己的 1 秒 interval；Delegation 只会被上层偶然重渲染带动。`time-format.ts` 的动态格式化函数直接读取 `Date.now()`，无法主动触发 React 更新。

## Locked Decisions

### Session recency

- `Session.updatedAt` 继续作为 root Session 最近活动展示和降序排序的唯一权威字段，不新增第二个 recency 字段或从消息、Execution、文件 mtime 回推。
- 一次 durable mutation 只有在 persisted patch 至少一个顶层值相对当前 state 发生 `Object.is` 变化，或产生至少一个 durable event 时，才属于真实语义变化。空 patch、全部写回相同值的 patch、仅返回既有结果的幂等 replay、空恢复、无修复的 clean load、list、read 和 projection 都是 no-op；不做深比较来猜测领域等价性，返回新对象即表示调用方声明了真实变化。
- no-op 不替换 Zustand state、不通知订阅者、不排队写盘、不改变文件内容/mtime，也不推进 `updatedAt`。
- durable no-op 返回前仍必须等待它所观察到的既有 Session persistence barrier，并传播该写入失败；“不新增写入”不等于绕过并发中的首个 durable commit。
- 真实 patch/event 仍恰好持久化一次，并由现有持久化边界单调推进 `updatedAt`；本 Goal 不建立第二套 timestamp owner。
- no-op 约束覆盖全部 Session persistence entry points，而不只覆盖 durable mutation helper：重复 `setTitle`、无变化的 `updateToolBatches`、相同 identity setter 和其他直接 persist 调用都必须在进入写盘队列前判定。
- 重启中断修复是显式 durable repair：reconcile 必须返回是否改变 persisted state，并在同一次 authoritative hydration 中使用单一 `now` 完成修复；有修复时恰好持久化一次并推进 `updatedAt`，无修复时零写盘。running execution、active child link、未完成 part 和 executing command receipt 不得依赖其他恢复流程顺带落盘。
- 启动 Queue 恢复只有在确实存在 orphaned `steering` message 时才回滚并更新时间。Queue dispatch、Goal continuation 等其他真实恢复行为维持各自当前领域语义。

### Temporal UI

- 浏览器时钟是 `apps/web` 的 UI 基础设施，不进入 `@archcode/protocol`、`@archcode/utils`、Server 或 Agent Core。Web 不新增对 `@archcode/utils` 的依赖。
- 建立一个 subscriber-owned external clock，以 `useSyncExternalStore` 暴露 `second` 和 `minute` 两种 cadence；不使用会让整个应用树随秒重渲染的顶层 Context clock。
- 同一 cadence 在全应用最多存在一个底层 scheduler；从零到首个订阅者时先用注入的 `now`/真实 `Date.now()` 刷新 cached snapshot 并通知，再安排 boundary tick，避免 idle 后首次挂载读取旧时间；最后一个订阅者离开后停止。页面 hidden 时停止周期 tick，重新 visible 或 window focus 时立即校正。
- clock store 缓存当前 scalar snapshot；`getSnapshot()` 在 scheduler 未发布新 tick 时必须保持 `Object.is` 稳定，禁止直接在 `getSnapshot()` 中调用 `Date.now()` 导致 React 重订阅或无限渲染。
- `second` 只服务所有不足一分钟的相对时间、active elapsed 和 active countdown，保证完整/短样式都能在 60 秒边界及时切换；相对时间进入分钟级后切换到 `minute`。终态 duration 和绝对日期不订阅 clock。
- 所有 formatter 都是纯函数并显式接收 `now` 或确定的 duration；业务组件不得通过调用 formatter 隐式读取当前时间。
- 保留当前相对时间产品文案和阈值：完整样式为 `<10s just now`、`10–59s Ns ago`、`1–59m Nm ago`、`1–23h Nh ago`、一天 `yesterday`、其后 `Nd ago`；短样式在 60 秒内显示 `just now`，其后使用现有短格式。
- 相对年龄和 elapsed 对负差值钳制为零，避免轻微时钟漂移显示负数。本 Goal 不新增 Server/Browser 时钟同步协议；远程设备的显著系统时钟偏差仍由宿主时间同步负责。
- 相对时间统一渲染为语义化 `<time dateTime>`，tooltip 使用完整本地绝对时间。相同表面内的可见文本、title 和 aria-label 必须来自同一计算结果。

### Hard cut

- 删除旧的 `formatRelativeTime(timestamp)`、`formatShortRelativeTime(timestamp)`、`formatElapsed(startedAt)` 隐式时钟签名，直接迁移全部调用方，不保留 overload、deprecated export、wrapper 或 fallback。
- 删除 `ExecutionWorkstream` 和 `RecoveryNotice` 的组件私有 interval，以及 Delegation 对偶然父级重渲染的依赖。
- 旧测试按新公开契约直接重写或删除；不新增专门断言旧函数名、旧 hook 或旧 interval 已消失的墓碑测试。

## Target Architecture

```text
Agent Core durable mutation
  -> semantic patch/event?
       no  -> await observed persistence barrier -> return result
              no new state replace/persist, updatedAt stable
       yes -> reduce once -> persist once -> advance canonical updatedAt

Session disk hydration
  -> interrupted persisted state?
       no  -> hydrate only, no write, updatedAt stable
       yes -> reconcile once with one now -> persist repair once -> advance updatedAt

Browser wall clock
  -> one external scheduler per active cadence
       second -> recent full relative time / active elapsed / active countdown
       minute -> ordinary relative time
  -> leaf hooks/components
       useRelativeTime / RelativeTime
       useElapsedTime
       useCountdown
  -> pure formatters
       formatRelativeTime(timestamp, now, style)
       formatElapsedDuration(durationMs)
       formatCountdown(targetAt, now)
       formatLocalDateTime(timestamp)
```

模块职责固定为：

- `apps/web/src/lib/time-clock.ts`：subscriber lifecycle、cadence、visibility/focus 校正和可注入 scheduler 测试 seam。
- `apps/web/src/lib/time-format.ts`：纯 formatter 与 timestamp 校验/钳制，不包含 React、timer 或全局状态。
- `apps/web/src/components/primitives/TemporalText.tsx`：hooks 与语义化 `<time>` presentation；业务组件只消费这里的动态时间契约。

## Implementation Plan

1. **修正 Session no-op 写入边界**：让 `commitDurableSessionMutation()` 过滤 patch 中与当前 state `Object.is` 相同的顶层值；过滤后无 patch 且无 event 时跳过 state replace/新 persist，但在返回原结果前等待调用当下观察到的既有 persistence barrier 并传播失败。同步审计 `setTitle`、identity setter、`updateToolBatches` 和全部 `persist()`/`#enqueuePersist()` 入口，在拥有当前 state 的领域入口做 no-op 判定；底层 writer 只接收已确认的真实 snapshot，不自行深比较。确保幂等 replay、unchanged Goal、重复 Queue barrier、相同 title 和未变化 tool batches 都走该契约。
2. **拆开 no-op 与 durable restart repair**：让 interrupted-file reconcile 显式返回 changed fact，并由 authoritative hydration 使用同一个注入的 `now` 修复和持久化；clean load 零写盘，真实修复恰好写盘一次。禁止 read/tree/depth projection 隐式制造另一份带不同时间的修复结果，也不再依赖 Steer、Tool Batch 或 Goal 恢复顺带保存。
3. **验证启动恢复语义**：为无/有 orphaned Steer、多 root Session 排序、active root/child、running execution、未完成 part 和 executing command receipt 建立重启回归；确认静态 Session 的 JSON、mtime、`updatedAt` 与列表顺序不变，每类真实修复只生成一组稳定终态并持久化一次。
4. **建立纯时间格式层**：将 relative、elapsed、countdown 和 tooltip local date-time 收敛为显式输入的纯函数；统一非法/负值处理和现有文案阈值。
5. **建立共享 clock**：实现 second/minute external stores、零到首个订阅时先刷新 snapshot、按订阅启停、边界 tick、hidden 暂停、visible/focus 立即校正，以及确定性测试 scheduler；不得引入全局 Provider 或页面级 interval。
6. **建立 Temporal primitives**：实现 `useRelativeTime`、`RelativeTime`、`useElapsedTime` 和 `useCountdown`。hook 只在输出可能变化时订阅合适 cadence，达到终态后立即退订。
7. **迁移相对时间表面**：一次性迁移 Sidebar、Dashboard、HITL Bell、用户消息、Hard Compact 和 Dynamic Compression；同一 timestamp 不得在可见文本、tooltip 和 accessibility 文案中重复独立计算。
8. **迁移 live duration/countdown**：Execution、Delegation 和 Recovery 共用 Temporal hooks；Execution 只在 `running` 时订阅；Delegation 在 child link 为 `linked | running | cancelling` 时订阅，无 link 时仅 tool part 为 `running` 才订阅，终态或 `waiting_for_human` 不订阅。可见终态时长固定 authoritative `durationMs` 或 `endedAt-startedAt`；Recovery 到零或状态离开 `scheduled` 后停止订阅。
9. **硬切清理与验证**：移除旧 formatter 签名和组件私有时间循环；增加当前架构边界测试，禁止业务组件新增动态 `Date.now()` formatter 或私有时间 scheduler；完成 unit、interaction、typecheck、全量 test、build、diff 和浏览器验收。

## Non-goals

- 不改变 Session schema、API DTO、SSE payload、Dashboard 分类规则或 Session family activity 状态机。
- 不从历史消息重建已被旧重启污染的 `updatedAt`，也不提供数据迁移、双读、修复脚本或兼容 fallback；修复从新代码生效时开始保证正确性。
- 不实现 Server/Browser 时钟偏移测量、NTP、时区设置 UI、国际化相对时间或用户自定义日期格式。
- 不重构 Automation due/next/once、artifact expiry、Todo archived、Goal 累计 duration 等不会自行变化的静态时间展示，也不改变其 formatter 或产品文案。
- 不修改 React Query/SSE 的失效策略来“顺便刷新时间”；clock 只负责 presentation，不成为数据同步通道。

## Risks And Controls

- **误把真实 mutation 当成 no-op**：逐一审计所有 Session persistence entry points，并用 changed patch-only、same-value patch、event-only、patch+event、result-only、相同 title 和 unchanged tool batches 契约测试锁定持久化次数和 `updatedAt`；只在持有领域 state 的入口做 identity/value 判定，不引入通用深比较 writer。
- **幂等 replay 提前越过首个写盘**：no-op 捕获并等待调用时已存在的 persistence barrier；用可控延迟/失败 save 验证并发重复请求不会提前成功，也不会吞掉首写错误，同时不会创建第二个 snapshot 或推进第二次 `updatedAt`。
- **删除误写盘后丢失中断修复**：把 interrupted reconcile 从隐式 read projection 提升为有 changed fact 的 durable repair；使用一个注入的 `now`，并分别断言 clean load 零写盘、真实 repair 恰好一次写盘和二次重启零新增变化。
- **大量时间节点造成重渲染风暴**：external store 由叶子订阅；只有不足一分钟的相对时间使用 second cadence，历史消息使用 minute cadence；禁止顶层 clock Context。
- **后台标签页 interval 漂移**：hidden 时停止周期任务，visible/focus 时直接读取 `Date.now()`，不累计 tick。
- **clock idle 后首次挂载读取旧 cache**：零到首个订阅者的同步路径必须先刷新 snapshot，再安排下一 boundary；用 clock 空闲数分钟后的首次 mount 回归锁定。
- **终态时长继续增长**：elapsed hook 的 active predicate 必须来自权威状态；终态只格式化持久化 duration/endpoints，并验证退订。
- **格式重构导致文案或无障碍退化**：阈值表、`<time dateTime>`、绝对时间 tooltip、Sidebar aria-label 与窄屏布局均进入机械验收。

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：重启不再污染 Session recency

- 对至少三个具有不同 `updatedAt` 的静态 root Sessions，执行真实 `recoverSessionContinuations()` 前后逐一比较：Session JSON 内容、文件 mtime 和 `updatedAt` 完全相同。
- 重启后的 `listSessions()` 顺序与重启前一致；Sidebar 获得的排序不得由 Session 目录遍历顺序决定。
- child Session 不被错误提升为 root 列表成员，现有 root-only Sidebar 行为不变。

### AC-02：durable mutation 的 no-op 与真实写入边界确定

- result-only、空 patch、全部顶层值与当前 state `Object.is` 相同且零 event 的 outcome 不替换 Store state、不触发 Store subscriber、不写文件、不推进 `updatedAt`；测试必须覆盖 unchanged Goal 和重复 Queue barrier。
- 用可控延迟 save 并发提交两个相同 `clientRequestId` 的 `acceptMessage` 和 `claimCommand`：第二个 result-only replay 在首写完成前不得 resolve；首写成功后两者返回同一 durable 结果，总写盘次数为一且 `updatedAt` 只推进一次。
- 对同一并发场景注入首写失败：首请求和观察到该 pending barrier 的 replay 都必须 reject；不得把仅存在于内存的 receipt 报告为 durable 成功。
- 非空 patch-only、event-only 和 patch+event outcome 各恰好持久化一次，Store 与磁盘取得相同且严格单调的 `updatedAt`。
- 重复设置相同 title、相同 identity 值或让 `updateToolBatches()` 返回原引用时满足同一 no-op 契约；真实 title、identity 或 tool-batch 变化仍恰好写入一次。
- 无 orphaned Steer 时恢复结果为空且满足 no-op；存在 orphaned Steer 时 message 回到 `queued`、revision 增加、rollback event 持久化且 `updatedAt` 前进。
- 幂等 Session input replay 返回原结果且不改变 recency；不得用一次无变化写盘维持幂等性。

### AC-03：重启中断修复被独立、稳定地持久化

- 以固定 `now` 分别构造 child/root Session 的 running execution、root Session 的 active child link、未完成 text/reasoning part 和 executing command receipt；一次 load 后得到当前规定的 interrupted/indeterminate 终态，相关 `endedAt`、`completedAt`、`durationMs` 和 error 字段与内存一致，并且每份发生修复的 Session 恰好写盘一次、`updatedAt` 恰好推进一次。
- 同一文件第二次重启不再改变任何修复字段、JSON 内容、mtime 或 `updatedAt`；不得重新生成时间或 duration。
- 没有任何待修复状态的 clean root/child Session，load 前后 JSON、mtime 和 `updatedAt` 完全相同；read、tree、depth 等 projection 也不得写盘或生成与 authoritative hydration 不同的修复时间。
- 同一 root Session 同时存在 interrupted repair 与 orphaned Steer 时，按 hydration repair、Steer rollback 两个领域事务串行写盘，save 调用恰好两次、`updatedAt` 严格推进两次；第一份 snapshot 已包含 repair，第二份包含 repair 与 rollback，任一流程不得靠另一项的副作用落盘。

### AC-04：全应用只有共享、按需运行的 clock

- 同时挂载任意数量的 second/minute consumers 时，每种 active cadence 最多一个 scheduler；最后一个订阅者卸载后对应 scheduler 为零。
- clock 在零订阅状态空闲并推进可控 wall clock 数分钟后，首次挂载 second 或 minute consumer 必须在首次可见结果中使用 fresh `now`，不得先显示模块加载时的 cached snapshot，也不得等待下一个 tick 才校正。
- `useSyncExternalStore` 的 snapshot 在未 tick 时保持引用/数值稳定；React Strict Mode 下挂载、卸载和重新订阅不泄漏 scheduler、listener，也不出现 infinite-loop warning。
- hidden 后周期 scheduler 停止；恢复 visible 或 window focus 的同一事件处理中立即刷新 snapshot，所有 active consumer 在下一次 paint 前反映当前 wall clock，而不是等待周期 tick 或补跑丢失 tick。
- 业务 components/routes 中不存在独立动态时间 interval；架构测试约束当前允许的 clock owner，而不是枚举已删除的旧名称。

### AC-05：全部相对时间会按确定阈值自动推进

- Sidebar Session、Dashboard attention、Dashboard Session、HITL Bell、用户消息、Hard Compact 和 Dynamic Compression 七类表面全部使用统一 relative-time contract。
- 测试用可控 `now` 证明完整样式与短样式跨越所有锁定阈值时输出准确；时间推进不依赖 API refetch、SSE event、鼠标操作或父组件偶然重渲染。
- 每个相对时间节点都有有效 `<time dateTime>`；tooltip 是同一 timestamp 的本地绝对时间。Sidebar 可见值、title 和 aria-label 在同一 tick 上一致。

### AC-06：elapsed 和 countdown 共享生命周期

- `running` Execution，以及 child link 状态为 `linked | running | cancelling` 或无 link 且 tool part 为 `running` 的 Delegation，无需新 StreamEvent 即每秒前进；Delegation 进入 `waiting_for_human`、任一终态或无 link 且 part 非 `running` 后不再订阅 second clock，Execution 进入任一非 `running` 状态后也不再订阅。
- Execution 有 `durationMs` 时优先显示该权威值；否则终态使用非负 `endedAt-startedAt`，running 使用非负 `now-startedAt`。
- `formatElapsedDuration(durationMs)` 沿用当前 elapsed 舍入和粒度：向下取整到秒，`<60s` 为 `Ns`，`<60m` 为 `Nm Ns`，其后为 `Nh Nm`；不得套用 Goal 累计时长的整分钟语义。
- scheduled Recovery 每秒倒计时，到零或状态变化后停止订阅；retrying/recovered/failed 不运行 countdown scheduler。
- 同时存在 Execution、Delegation 和 Recovery 时仍只共享一只 second scheduler。

### AC-07：彻底硬切且架构边界清晰

- Web 动态时钟、React hooks 和 visibility lifecycle 只存在于 `apps/web`；Protocol、Utils、Server 和 Agent Core 不依赖浏览器或 React。
- 所有生产调用方直接使用新 formatter/Temporal contract；不存在旧签名 overload、deprecated export、adapter、feature flag、双路径或 fallback。
- 旧测试直接迁移到新契约或删除，不新增只为证明旧名称不存在的墓碑测试。
- 不新增 Session schema migration、旧数据修复逻辑或从消息/mtime猜测 recency 的兼容路径。

### AC-08：自动化与真实浏览器验收完整

- 定向测试覆盖 no-op 持久化、真实恢复、排序、clock subscriber 生命周期、visibility/focus、所有 formatter 阈值、relative/elapsed/countdown 交互和 `<time>` accessibility。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 真实浏览器必须验证可由公开产品流程稳定构造的闭环：Sidebar 与 Dashboard 相对时间无需数据事件即可跨越下一显示阈值；running Execution/Delegation 时长连续前进并在终态固定；切换标签页后返回立即校正；桌面和 390px 窄屏无溢出或跳动；console error 为 0。
- Recovery countdown、Hard Compact、Dynamic Compression 等无法由公开产品流程确定性制造的状态，必须由真实 React/JSDOM interaction fixture 配合可控 scheduler 验证跨阈值、退订和语义 `<time>`；不得为人工 QA 增加生产 debug route、fixture API 或测试 fallback。
- 验收报告必须区分自动化测试、真实浏览器观察和无法恢复的历史 `updatedAt` 数据边界；不得把方案、单元测试或静态截图表述为已完成运行时验收。
