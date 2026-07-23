# Session Work 信息流折叠改造进度

## 2026-07-23

### 已确认边界

- 实现限定在 Web UI；不修改 Server、Protocol、Session 持久化或历史数据。
- 一个 `Execution` 对应一个 `Work` disclosure；用户输入和最终回复不属于 disclosure body。
- Tool 与 Child Session 详情继续留在 `Work` 内。
- 完成态只在存在可信最终文本时渲染最终回复，不创建空占位。

### 第一性原理更正

原 Plan 的“从后向前寻找最后一个无 Tool Assistant 消息”会在 Tool
直接完成 Execution 时回退到较早的过程文字，产生假最终回复。实现采用
保守、fail-closed 的 Web 投影：

1. 只有 `SessionExecutionRecord.status === "completed"` 才有资格产生最终回复。
2. 该 Execution 必须存在最后一个已完成 Step，且其 `finishReason` 不是
   `tool-calls`、`interrupted` 或 `error`。
3. 只检查该 Execution 最后一条 Assistant message，不向更早消息回退。
4. 只投影完整、非空，且未标记 `interrupted` /
   `discardedFromContext` 的 Text parts。
5. 同一消息中的 Reasoning、Tool、Recovery 和其他 part 继续属于 `Work`。

这利用现有 `Execution + SessionStep + SessionMessage + TextPart` 的 producer
约束；对于异常或被篡改但仍通过 schema 的历史状态，投影选择不显示最终
回复，而不是猜测。无需新增 `resultMessageId`。

### 实施记录

- 创建 worktree：`~/.codex/worktrees/019f8e30/archcode`
- 创建分支：`codex/session-work-fold`
- 同步已批准的 Signal Workbench 设计基线和技术 Plan。
- 按现有 `bun.lock` 完成 frozen install；没有修改依赖版本或锁文件。
- 三个独立 Agent 已完成分工：
  - 最终输出投影与 producer/reducer 契约审计；
  - Work disclosure、滚动锚定与组件边界实现；
  - 测试矩阵与交互回归实现。
- 修正技术 Plan 的最终输出判定，并实现纯投影与定向测试。
- 硬迁移 `ExecutionCard` 为用户输入、`WorkDisclosure`、最终回复三段结构；
  没有保留旧卡片、双渲染或兼容 fallback。
- 完成态 `Work` 默认折叠，运行态默认展开；Tool、Reasoning、Recovery、
  Child Session 和 compaction 仍留在可选展开的 `Work` body。
- 拆分实时跟随与 disclosure 锚定：只有近底部读者跟随新增内容，手动
  展开/折叠不会跳到 Session 底部；手动选择在当前路由生命周期内保留。

### 验证记录

- `bun run --cwd apps/web test`：
  - 541 个 Web 单元测试通过；
  - 86 个 Web 交互测试通过。
- `bun run typecheck`：5 个 workspace 全部通过。
- `bun run test`：8 个 Turborepo 任务全部通过，包含 Agent Core
  unit / integration / architecture lanes；Review 修复后已完整重跑。
- `bun run --cwd apps/web build`：通过；仅保留既有 chunk-size 提示。
- `git diff --check`：通过。
- 真实浏览器使用一条含 9 个 Execution、41 个 Tool 的持久 Session 验证：
  - 完成态默认折叠，最终回复始终在 disclosure 外可见；
  - Tool 与 Child Session 仍可在 `Work` 内展开；
  - 展开和折叠前后 summary 锚点位移均为 `0px`；
  - 320、390、1024、1440px 均无页面横向溢出；
  - 深色、浅色主题均正常；
  - 9 个 disclosure 全部具有 `aria-controls`，最小高度 57px。
- Review 修复后的浏览器烟测再次确认：9 个 Work 均默认折叠、2 个可信
  final response 常驻，`Stopped, Cancelled` 进入无障碍名称，展开锚点
  位移仍为 `0px`，Tool / Child 详情可见。

### 纠正与风险

- 完整 Web 测试曾发现一个旧路由测试仍假设“完成态 Work 默认展开”。
  用例已改为显式展开后再进入 Child Session；产品行为未回退。
- 现有 persisted UI snapshot 仍由组件模块管理，并由 Session 路由生命周期
  显式清理。此次没有为局部 disclosure 状态引入新的全局 Provider。
- 异常历史状态的最终回复投影选择不显示而不是猜测；这是有意的
  fail-closed 边界，不是兼容缺口。

### 独立 Review

- 使用独立 `sol(xhigh)` Reviewer 做三轮只读审查。
- 第一轮发现并修复：
  - 多个最终 Text part 必须先无分隔拼接，再作为一个 Markdown 文档解析；
  - disclosure 点击与同批 SSE 更新必须由一个互斥滚动事务处理，锚点优先；
  - 终止原因必须进入 disclosure 的无障碍名称；
  - 长历史流式更新必须复用未变化的 projection，并以 memo 隔离历史 turn。
- 第二轮指出原性能用例仍可能因 DOM reconciliation 产生假阳性；用例改为
  真实 running Execution，并直接记录 memoized `ExecutionTurn` 的 render
  count，确认 999 个历史 turn 不重新执行，只有活动 turn 更新。
- 第三轮结论：`VERDICT: APPROVED`，无剩余 findings。

### 最终状态

- Plan、设计系统、交互原型、Web 实现和测试已一致。
- 没有 Server / Protocol / 持久化迁移、旧组件、双渲染或兼容 fallback。
- 所有完成标准均有自动化测试或真实浏览器证据。
