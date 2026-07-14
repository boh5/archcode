# HITL Tool-Batch Hard-Cut Goal

## Objective

将现有 owner-local HITL continuation 硬切为职责清晰的三部分：项目级 HITL 队列只管理人类请求与回答，Session Tool Batch Scheduler 只管理工具批次的并发、阻塞与恢复，Goal Budget Handler 只应用预算决定。删除独立的 Session HITL replay/resume 执行体系、重复投影和全部旧兼容路径；旧 HITL、Session 数据不迁移。

## Locked Architecture

```text
LLM tool calls -> SessionToolBatchScheduler -> tool results -> one LLM continuation
                         |
                         +-> blocked call -> ProjectHitlQueue -> human answer
                                                              |
                                           Runtime Dispatcher-+
                                             | session -> same ToolBatchScheduler
                                             + goal    -> GoalBudgetHandler
```

- `ProjectHitlQueue` 持久化到项目唯一文件 `.archcode/hitl-queue.json`，只提供 `create/list/respond/cancel/resolve`、不可变回答、幂等和事件；不得依赖 Session、Goal 或 ToolRegistry。
- `SessionToolBatchScheduler` 的权威批次状态随 Session 持久化；不得另建 HITL journal、resume lease 或第二套 Session 执行状态机。
- `GoalBudgetHandler` 只处理 `goal_budget`；Goal 问题走发起 Session 的 `ask_user`，Reviewer 结果直接走 `goal_manage.finalize_review`，其他 Goal approval/review 不再经过 HITL。
- Runtime 只用显式 owner `switch` 分发回答，不建设 handler registry、插件协议或通用工作流。

最小协议必须等价于：

```ts
type HitlOwner =
  | { type: "session"; id: string }
  | { type: "goal"; id: string };

type HitlSource =
  | { type: "ask_user"; toolCallId: string }
  | { type: "tool_permission"; toolCallId: string; toolName: string }
  | { type: "goal_budget"; approvalPoint: string };

type HitlStatus = "pending" | "answered" | "resolved" | "cancelled";

type ToolCallState =
  | "queued"
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "manual_inspection_required";
```

- 每条 HITL 的身份只含公开 `hitlId`、创建幂等用 `requestKey` 和单份 owner；不保存 `projectSlug`、`sessionRootId`，source 不重复 owner id。
- Response 只保留与三种 source 对应的 `question_answer`、`permission_decision`、`budget_decision`，以及 `cancel`。
- `allowedActions` 与 inspection 只由当前记录推导；删除 ancestry/`projectionPath`，不再维护第二套 projection 领域模型。

## Non-goals

- 不重写 ToolRegistry、tool traits、权限策略、Goal 生命周期或通用 Session/worktree 生命周期。
- 不引入数据库、事件溯源、分布式锁、多进程协调、通用 dispatcher 框架或新的 inspection HITL/UI 操作。
- 不保留旧文件读取、schema 宽松解析、fallback、alias、迁移、双写或新旧 API 并存期。

## Acceptance Criteria

以下 AC-01 至 AC-07 必须全部有代码、测试或审计证据；任一缺失即为 `NOT_DONE`。

### AC-01：领域与持久化完成硬切

- `.archcode/hitl-queue.json` 是项目 HITL 的唯一权威存储；删除 owner-local `hitl.json`、Session `hitl-journal.json`、owner path/aggregation scan 及对应恢复逻辑。
- `HitlSource` 生产协议中恰好只有 `ask_user | tool_permission | goal_budget`；彻底删除 `goal_question | goal_approval | goal_review` 及其 response、route、UI、event、prompt 和测试分支。
- owner 只含 `{ type, id }`；source 不重复 owner id；`ask_user/tool_permission` 必须属于 Session，`goal_budget` 必须属于 Goal；`projectSlug` 只来自路由/项目上下文，`sessionRootId` 只属于 Session。
- 旧模块必须删除而非留壳转发：owner store/path/aggregation、ResumeCoordinator、Goal HITL gates/adapter，以及 `execution/session-hitl-*`；Session 中的 `SessionHitlBlocker/blockedHitl` 由 canonical tool batch 直接替代。
- 新 schema 严格解析；旧 owner-local 数据和旧 queue schema 均不读取、不转换，解析到旧结构时直接失败。

### AC-02：依赖边界高内聚、低耦合

- HITL Core 不导入 Session store/manager、Goal state/manager、ToolRegistry 或 Web 类型，也不解析 ancestry、cwd、Session tree 或 Goal receipt。
- Tool Batch Scheduler 不读写 HITL 文件、不处理 Goal；只通过 Runtime 提供的窄接口创建请求和读取已接受回答。
- Goal Budget Handler 不执行工具、不恢复 Session、不调用 LLM；Runtime Dispatcher 只有 session/goal 两个显式分支。
- 架构测试锁定上述依赖方向，并删除当前禁止项目 queue 的反向架构断言。

### AC-03：工具批次阻塞语义确定

- 生产路径统一使用现有 `partitionToolCalls` 顺序语义：同一 parallel partition 的 `concurrencySafe` 调用可并行，serial partition 是顺序屏障；删除使生产 HITL 路径全串行的 `durableHitlMode`。
- 一个调用进入 `blocked` 时，同一 parallel partition 的其他调用继续完成或形成各自 blocker；尚未越过顺序屏障的调用保持 `queued`，不得被标记为 skipped、aborted 或伪造 tool result。
- 回答应用后只恢复对应调用，然后继续原批次中仍为 `queued` 的调用；同一批次允许同时存在多个 blocker。
- 所有调用得到确定结果后只触发一次 LLM continuation；存在 `manual_inspection_required` 时终止本轮执行且不调用 LLM。

### AC-04：批次持久化与崩溃恢复确定

- Session 的 canonical persisted state 保存完整当前批次、每个调用状态、输入、结果、attempt 和关联 `hitlId/requestKey`；删除独立 journal、`blockedHitl` 及其他同义 checkpoint。
- 创建 blocker 的写入顺序固定为：先持久化 Session `blocked + requestKey`，再幂等创建 queue 记录，再回写 `hitlId`；冷启动能补齐任一步骤间的崩溃。
- 回答先原子持久化为 `answered`；handler 再持久化准确的应用事实（`ask_user` tool result、permission decision/规则、或 Goal budget decision），最后把 HITL 标记为 `resolved`。获批工具的后续执行与结果只属于 Tool Batch Scheduler，不延长 HITL 生命周期。
- `completed/failed` 调用绝不重放；无结果的 `running + readOnly` 调用最多恢复重试一次，仍无结果则写入确定的 recovery failure；无结果的 `running + !readOnly` 直接进入 `manual_inspection_required`。
- `manual_inspection_required` 是本次 execution 的终态：批次归档并保留审计信息，不自动重放、不继续 LLM，也不阻塞下一条普通用户消息；系统不新增 Resume/fallback 流程。

### AC-05：回答与 Session 执行语义确定

- 人类回答最多接受一次：重复提交同一 response 幂等成功，不同 response 返回冲突且不能覆盖原回答。
- `answered` 一经持久化立即从待处理 UI 消失；`resolved` 只表示回答已经应用到准确工具调用或 Goal budget，不等待后续 LLM 执行完成。
- 分发至少一次、handler 幂等；持久化 delivery 只允许 `{ attempts, retryAt?, error? }`，最多三次分发尝试，耗尽后由 `answered + error + no retryAt` 推导 inspection。
- 删除 `SessionHitlPause` 异常展开、ResumeCoordinator、SessionHitlResumeAdapter、专用 resume lease/claim/generation、`cancel_only` 和相关错误类型；恢复批次复用普通 Session execution 的互斥、abort、stop、cwd 与 agent slot。
- stop/delete Session 时，只按该 Session 当前批次引用取消对应 queue 记录；family activity 不再读取独立 HITL resume map。

### AC-06：API、事件、Web 与 Goal 表面收敛

- API 固定为项目 list/snapshot，以及 `/:hitlId/respond`、`/:hitlId/cancel`；mutation URL 不再重复 ownerType/ownerId，owner 仅作为 list filter。
- HITL 增量只通过现有全局 SSE 的项目事件进入一个 Web project HITL store；Session stream 只保留工具/执行状态，不复制完整 HITL lifecycle。
- Question、Permission、Budget 使用三个简单表单；UI 只提交用户动作，不构造 Goal review receipt 或领域 continuation 参数。
- 所有 list/event DTO 都是脱敏 view；原始工具输入和敏感回答不得进入 Web store。Session、Dashboard、Goal 页面过滤同一 store，回答后不得因 refetch 或另一事件源重新出现。
- Goal Budget 的批准/拒绝有真实回归；Goal 问题、Reviewer finalize 和 Goal 创建确认分别沿既有 Session/Goal 工具路径完成，不保留 HITL fallback。

### AC-07：场景验收、遗留审计与全量验证

- 测试至少覆盖：parallel sibling 在另一调用等待权限时继续、serial barrier 后调用不丢失、同批多 blocker、回答竞争、回答后重启、completed 不重放、read-only orphan 恢复、effectful orphan inspection、单次 LLM continuation、Goal budget、Session stop/delete、API/SSE 单一 store。
- 浏览器级验证 Question、Permission、Budget 三条路径：回答立即关闭卡片，准确工具/Goal 收到决定，页面刷新和 SSE 重连不产生重复卡片。
- 生产代码与活动 schema 的文字审计确认不存在 `HitlOwnerStore`、`resolveHitlOwnerPath`、`aggregateHitlProjections`、`SessionHitlBlocker`、`blockedHitl`、`SessionHitlPause`、`SessionHitlResumeAdapter`、`SessionHitlResumeLease`、`ResumeCoordinator`、`GoalGateService`、`GoalHitlResumeAdapter`、`hitl-journal.json`、`durableHitlMode`、`goal_question`、`goal_approval`、`goal_review`、`projectionPath` 或旧兼容/迁移分支。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；Reviewer 必须逐项给出 AC-01 至 AC-07 的证据，不能用“测试全绿”代替验收。
