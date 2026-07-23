# Session Work 信息流折叠改造 Plan

状态：Implemented and verified
范围：Web UI；不修改 Server、Protocol、Session 持久化和历史数据

## 目标

- Agent 工作时持续展示 reasoning、进度文字、Tool 和 Child Session 信息流。
- Execution 完成后，把过程收进一个可展开的 `Work`，最终回答始终直接可见。
- Tool 详情继续在 `Work` 内独立展开，不迁移到 Inspector 或其他页面。
- 展开、收起和流式更新都不能让用户突然跳到列表底部或失去当前阅读位置。

## 最终输出判定

以一个权威 Execution 为边界，结合现有 Step 和 Message producer
约束做保守投影，不在整个 Session 中猜测：

1. 只有 `SessionExecutionRecord.status === "completed"` 的 Execution
   可以产生最终回答。
2. 该 Execution 必须存在最后一个已完成 Step，且其 `finishReason`
   不是 `tool-calls`、`interrupted` 或 `error`；由 Tool 直接完成的
   Execution 因而不会回退到较早过程文字。
3. 只检查该 Execution 最后一条 Assistant message，不向更早消息回退。
4. 该消息中完整、非空，且未标记 `interrupted` /
   `discardedFromContext` 的 Text parts 共同组成最终回答。
5. 同消息中的 Reasoning、Tool、Recovery 及其他 part，以及此前所有
   Assistant 消息/part 都属于 `Work`。
6. `failed`、`aborted`、`waiting_for_human` 等非完成态，以及缺少可信
   terminal Step 或最终文本的完成态，不伪造最终回答。

这是一项 Web 只读、fail-closed 投影，不新增 `resultMessageId`，也不迁移
旧 Session。异常或被篡改但仍通过 schema 的状态不满足 producer 约束时，
选择不显示最终回答，而不是猜测。

## 设计基线

- 设计系统：`design/prototypes/signal-workbench/design-system/signal-workbench/MASTER.md`
- 页面规范：`design/prototypes/signal-workbench/design-system/signal-workbench/pages/session.md`
- 交互与视觉原型：`design/prototypes/signal-workbench/index.html`
- 实现以上述已完成的设计产物为准；Plan 不重复维护视觉规则。

## 实施步骤

1. 在 `apps/web/src/lib/execution-workstream.ts` 增加纯函数投影，将每个
   Execution 分成用户消息、Work 消息/part 引用和可选的最终文本 part
   引用；Step 数及 terminal Step 均按 `executionId` 权威关联，并覆盖多步
   Tool、纯文本、Tool 直接完成、中断、Recovery 及空输出测试。
2. 重构 `ExecutionWorkstream.tsx`：用户输入、Work disclosure、最终回答成为同一 Execution 的三个视觉段；Tool disclosure 保持原位和原能力。
3. 将滚动逻辑拆成“实时近底部跟随”和“用户 disclosure 锚定”两条路径，删除开合 Work 时的无条件滚底。
4. 更新组件/交互测试，并在 320、390、1024、1440px 的明暗主题下验证长输出、长 Tool 详情、键盘操作和 reduced motion。

## 完成标准

- 完成态默认只显示一行 Work 摘要和完整最终回答。
- Work 展开后所有过程文字、Reasoning、Tool、Child 和详情仍可访问。
- 展开任意历史 Work 后，视口锚点偏移不超过 1px，且不会跳到 Session 底部。
- 运行态到完成态的自动折叠不会打断正在阅读历史内容的用户。
- 历史 Session 无数据迁移即可得到一致结果。
- Web 定向测试、typecheck、Web build、`git diff --check` 和响应式浏览器 QA 通过。
