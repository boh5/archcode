# Automation Hard-Cut Refactor Goal

## Objective

将现有产品级 `Loop` 硬切为高内聚、低耦合的 `Automation`：Automation 只把一个时间 Trigger 转换为一次普通 Session 消息派发，不拥有 Agent 执行、Goal、HITL、权限、工具、Budget、worktree 生命周期或任务完成判定。删除全部旧 Loop 实现、协议、API、UI、持久化读取和兼容路径，不迁移旧数据。

## Locked Architecture

```text
Schedule Trigger -> durable Invocation -> Dispatcher -> ordinary Session API
```

- 每个 Automation 只有一个 Trigger：`once`、`interval` 或 `cron + timezone`；`Run now` 是操作，不是 Trigger。
- Action 只有两种：每次创建普通 Engineer Session，或向指定现有 Session 发送消息。
- Trigger 不运行 AI；静态时间判断之外的工作全部由目标 Session 及其可用 Skill 完成。
- Action 保存普通消息；Skill 通过现有 `/skill use ...` 消息机制调用，不保存 `skillRef` 或模板 ID。
- Invocation 只记录派发事实及 `sessionId` / `executionId` 指针；Session 是执行状态和结果的唯一事实来源。

最小领域模型必须等价于：

```ts
type AutomationTrigger =
  | { kind: "once"; at: string }
  | { kind: "interval"; everyMs: number }
  | { kind: "cron"; expression: string; timezone: string };

type AutomationAction =
  | { kind: "start_session"; message: string; location: "project" | "worktree" }
  | { kind: "send_message"; sessionId: string; message: string };

type AutomationInvocationStatus =
  | "pending"
  | "dispatched"
  | "failed"
  | "cancelled"
  | "missed";
```

字段可因持久化和审计需要增加标识与时间戳，但不得重新引入模板、Budget、Goal、collision、cleanup、integration health 或独立执行状态机。

## Non-goals

- 不修改 Agent、Agent Skill allowlist、工具授权、权限或 query loop 的既有逻辑；所需 Skill/工具只按现有 Agent 配置机制显式配置。
- 不修改普通 Goal Runner、Goal Lead continuation、Reviewer、Goal Budget、retry、HITL 或 Goal worktree 行为。
- 不修改通用 Session/worktree 生命周期，也不新增 Automation worktree cleanup。
- 不删除 GitHub 通用配置、认证、客户端或 connector tools；首版不实现 GitHub/event Trigger。
- 不建设通用 Conditions、Trigger 插件注册框架、RBAC、per-Automation model/tool profile、Budget、自动重试或兼容迁移层。

## Acceptance Criteria

以下 AC-01 至 AC-09 必须全部有代码、测试或审计证据；任一条件缺失即为 `NOT_DONE`。

### AC-01：Loop 完全硬切

- 删除 `packages/agent-core/src/loops/`、旧 Loop server routes、Web 页面/API/store/components、protocol Loop 类型与 reducer 分支，以及 runtime/project-context 中的 Loop 服务装配和导出。
- 删除产品级 `loopId`、Loop execution origin、Loop HITL owner/source、Loop stream/error event、Goal-Loop ownership 和 continuation/reconciliation 分支。
- 删除 `.archcode/loops` 的运行时读写、旧 schema 解析、fallback、别名、迁移器和 `/loops` API；旧数据保持未读取，不做转换。
- `packages/agent-core/src/agents/query/loop.ts` 等表示 LLM query loop 的通用代码不属于删除对象。

### AC-02：Automation 边界清晰

- 时间计算只产生 Invocation；Dispatcher 只调用窄化的普通 Session 创建/消息接口，不执行 Agent loop，也不复制 Session 状态。
- Automation 生产代码不得依赖 `goals/`、具体 HITL 实现、tool guards/hooks、GitHub tools 或 Loop 遗留模块。
- 不得出现承担 schedule、执行、HITL、Goal、cleanup 多重职责的 `AutomationRunner` 或同类大对象。
- 架构测试证明 Trigger、持久化和 Dispatcher 的依赖方向，且 Web 仍只依赖 protocol。

### AC-03：调度语义确定

- `once`、`interval`、`cron + IANA timezone` 均有确定性测试；非法 cron、无效时区和低于系统最小间隔的配置被拒绝。
- 每个 Automation 恰有一个持久化 Trigger；`Run now` 不写入 Trigger 配置。
- 服务离线期间错过的 recurring fire 不补跑；恢复后计算严格晚于当前时间的下一次 fire。
- 已过期的 one-shot 不执行，记录 `missed` 并禁用 Automation。
- 派发失败不自动重试：recurring 等待下一次 fire，one-shot 记录失败并禁用。

### AC-04：可靠派发与恢复

- Invocation 在调用 Session 前持久化，并使用稳定幂等标识关联 durable `executionId`。
- 进程在已接收 Invocation 后崩溃，重启能够识别已派发或继续未完成派发，不能重复创建同一次 Session execution。
- “恢复已接收 Invocation”与“补跑离线期间未接收的 schedule”有相反行为的测试。
- `dispatched` 仅表示 Session 接受执行，不得表示 prompt 任务成功。

### AC-05：Action 复用普通 Session

- `start_session` 每次创建普通 Engineer Session；Git 项目必须使用用户保存的 `project | worktree` 选择，非 Git 项目只能选择 `project`。
- `send_message` 通过与用户消息相同的命令解析、持久化、execution、权限和 HITL 入口；直接追加 transcript 视为失败。
- `/skill use ...` 的现有 Session 行为有回归测试；Automation 不授予 Skill、工具或额外权限。
- 目标 Session 不存在或不可执行时，Invocation 失败并产生 attention，不得静默改投其他 Session 或 Goal continuation。

### AC-06：Overlap、HITL 与控制语义

- 同一 Automation 最多一个 active Session execution，并只保留一个 coalesced pending Invocation；重复 schedule 或 `Run now` 不形成队列洪泛。
- `waiting_for_human` 视为 active；解决后才允许派发 pending Invocation。
- pause 取消 pending 并阻止未来 fire，但不停止已运行 Session；resume 从当前时间向后计算，不补跑。
- delete 删除 Automation 配置及 Invocation 记录，但不停止或删除其创建、唤醒的 Session。

### AC-07：API 与 Web UI 完成替换

- 提供 project-scoped Automation 的 list/create/read/update/delete、pause/resume、Run now 和 Invocation history API；不存在旧 `/loops` 路由。
- 创建/编辑 UI 只包含名称、单个 schedule、Action、消息，以及 `start_session` 所需运行位置；不得出现模板、Goal、Budget、collision、cleanup、approval policy 或 integration health 字段。
- Invocation history 展示 due/dispatch 状态并链接 Session；普通新结果可见，failed/HITL 明确进入 attention。
- 页面、导航、SSE/REST protocol 和用户可见文案统一使用 Automation，不保留 Loop fallback UI。

### AC-08：Goal、Agent 与 GitHub 不被误伤

- 普通 Goal 创建、运行、review、retry、HITL continuation 和 Goal Budget 的既有行为及测试保持通过；只删除 Loop 专属 Goal 分支。
- Agent definitions、Skill allowlist、query loop、tool filtering 和权限判定不因 Automation 获得新语义；如需新增 Skill/工具，只修改对应 Agent 的显式配置列表。
- GitHub integration 配置、认证和 connector tools 保留；仅删除 Loop poller、Loop template、Loop integration snapshot/health 和 Loop 专属接线。
- 未来 GitHub Trigger 可以通过 `GitHub event -> Trigger occurrence -> Dispatcher` 扩展，但本 Goal 不实现该 Adapter。

### AC-09：TDD、全量验证与遗留审计

- 核心调度、恢复、coalesce、pause/delete 和 Action 行为先有失败测试，再实现生产代码。
- 以下命令全部退出码为 0：`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check`。
- 目标审计确认生产代码、活动 API/UI 和配置文档中不存在 `LoopScheduler`、`LoopRunner`、`LoopState`、`LoopConfig`、`loopId`、`/loops`、`loop.state_change`、`.archcode/loops` 或旧 Loop fallback/migration。
- Reviewer 逐项给出 AC-01 至 AC-09 的证据，检查删除项、依赖方向和 Goal/Agent/GitHub 回归；不能用“测试全绿”替代逐项验收。
