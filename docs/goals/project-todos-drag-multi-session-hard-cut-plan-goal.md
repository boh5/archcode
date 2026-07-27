# Project Todos Drag And Multi-Session Hard-Cut Plan Goal

## Objective

彻底重构 Project Todos，使 Todo 看板支持鼠标、触摸和键盘拖拽排序，并把当前“一个 Todo 只能拥有一个 Discussion 和一个 Activation”的反向引用模型替换为“一 Todo 可来源出多个独立工作”的来源模型。

完成后：

- Todo 只拥有内容、规划状态、归档和数组顺序，不保存 Session 或 Automation ID。
- Root Lead Session 可选记录其来源 Todo；Automation 可选记录来源 Todo ID。
- 用户可从 Todo 继续已有工作或新开 Discussion、Work Session、Automation setup Session。
- `Ready` 上的 `Start work`、`Continue work`、`Create Automation` 会自动进入 `In Progress`；拖拽进入 `In Progress` 本身不创建工作。
- 旧 Activation、反向 Session owner、旧接口、旧数据兼容和相关测试全部硬切删除。

本 Goal 只实施并验收新合同。旧 Todo 数据由用户在实施外手工清理；实现不得读取、迁移、重置或解释旧数据。

## Locked Decisions

### Product semantics

- 持久状态是 `idea | ready | in_progress | done | rejected`。主 Board 恰有 `Ideas`、`Ready`、`In Progress`、`Done` 四列；`Rejected` 与 `Archived` 仍是独立视图。
- 四个主 Board 状态之间可自由拖拽，不维护状态转换图。Reject 仍要求非空原因；离开 Rejected 自动清除原因。Archive 是独立可见性属性，不是状态。
- 拖拽只改变 Todo 的规划状态和/或顺序，不创建、恢复、停止或删除 Session/Automation。
- `Start work` 创建新的 Work Session。Todo 为 Ready 时先进入 In Progress；Todo 已为 In Progress 时状态不变。
- Todo 页面上的 `Continue work`：
  - Ready：先成功 PATCH 为 In Progress，再打开最近更新的 `entry="work"` Session。
  - In Progress：直接打开最近更新的 `entry="work"` Session。
  - Idea、Done、Rejected、Archived：只允许 `Open` 已有关联，不提供 Continue。
- `Open` 永远只是导航。用户从 Sessions 页面进入或发送消息，不反向修改 Todo。
- `Create Automation` 创建一个 `entry="automation"` 的普通 Root Lead setup Session，并遵循与 Start work 相同的 Ready/In Progress 门槛。Automation 仍通过现有 `automation-create` Skill 与 `automation_create` Tool 完成。
- Discussion 可从任意未归档 Todo 新开；同一 Todo 可有多个 Discussion。默认 Continue Discussion 打开最近更新的 Discussion，并提供显式 New Discussion。
- 一个 Todo 可来源出任意多个 Root Session 和 Automation；一个 Root Session 最多来源于一个 Todo。不支持把任意已有 Session attach、detach 或 rebind 到 Todo。
- 删除来源 Session 后不保留关系墓碑，也不修改 Todo。Automation 因拥有自己的 `projectTodoId`，不因来源 Session 删除而失去 Todo 关联。
- Automation Invocation 不是 Todo 的直接关系：`start_session` 新建的 Session 不复制 `projectTodo`；`send_message` 不创建或重绑 Session，并保留目标 Session 原有来源。
- Todo 详情只展示直接来源 Session 和带 `projectTodoId` 的 Automation；Invocation 及其 Session 统一在现有 Automation 详情页查看。

### Deliberate exclusions

- Session ID 由后端生成。创建请求不接受 `sessionId` 或 `clientRequestId`，不处理网络响应丢失后的 exactly-once 重试。
- Todo 状态、Session 创建和首轮消息接收不建立跨文件事务、事务日志或 Todo 专属恢复。进程在任意两步之间退出时，允许留下没有新 Session 的 In Progress Todo，或已关联但尚无首轮消息的空 Session。
- 不提供旧数据迁移、启动清理、旧 schema 识别、fallback、兼容接口或旧行为墓碑测试。

## Locked Architecture

```text
Web Todo Board
  -> thin Todo HTTP routes
  -> ProjectTodoService
       -> ProjectTodoStateManager
            owns content/status/archive/order/revision/atomic file write
       -> narrow Session capability
            creates backend-generated Root Session
            accepts its initial message through the ordinary Session path

Root Session.projectTodo ----> identifies source Todo and entry
Automation.projectTodoId ----> preserves its own source Todo association

Todo never points back to Session or Automation.
```

### Ownership boundaries

- `ProjectTodoStateManager` 只依赖 Protocol、runtime path 和通用安全文件写入。它负责严格 schema、Todo 不变量、revision、数组排序和串行原子 mutation；不得创建或查询 Session、Execution、Automation。
- `ProjectTodoService` 是唯一暴露给 ProjectContext 生产消费者的 Todo 应用边界。它负责 CRUD、Start/Discussion/Automation entry 和 Discussion 更新授权；内部以 private state 持有 `ProjectTodoStateManager`，不得向 Runtime、Agent、Tool、Server 暴露 `.state` 穿透访问；只依赖窄 Session capability，不拥有通用 Session 或 Automation 生命周期。
- Session Store 负责 Session ID、严格持久身份、Session detail/summary 投影和 Execution 记录，不解释 Todo 状态或 Todo prompt。
- Todo 首轮 prompt 由 `ProjectTodoService` 根据本次已校验的 Todo 生成，再交给现有 Session 消息接收路径；不得增加 Todo 专属 Execution 或恢复协议。
- Automation 创建路径从权威来源 Session 读取 `projectTodo?.todoId`，并把它复制为 Automation 自有的可选 `projectTodoId`。Automation 不回调 Todo Service 绑定资源。
- Server route 只做参数验证、错误映射和 ProjectContext 调用。Web 只依赖 Protocol，不依赖 Server 或 Agent Core。
- 不新增 Work、Relation、BoardOrder、Lifecycle、Repository、Workflow 或跨文件事务框架。

### Canonical data contracts

```ts
type ProjectTodoStatus =
  | "idea"
  | "ready"
  | "in_progress"
  | "done"
  | "rejected";

interface ProjectTodo {
  id: string;
  title: string;
  body: string;
  status: ProjectTodoStatus;
  rejectionReason?: string;
  revision: number;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

interface ProjectTodoSessionSource {
  todoId: string;
  entry: "discussion" | "work" | "automation";
}
```

- `SessionFile.projectTodo?: ProjectTodoSessionSource` 只能存在于 `agentName="lead"`、`parentSessionId === undefined`、`rootSessionId === sessionId` 的 Root Session；子 Session 不复制来源。
- Session detail 与轻量 `SessionSummary` 都只返回同一个 `{ todoId, entry }` 来源。
- `Automation.projectTodoId?: string` 是 Automation 自有来源，不是 Todo 反向关系。
- `state.todos` 数组是唯一排序权威。各列只按状态过滤并保留数组相对顺序；不得增加 position token、分列 order、副本索引或 Board revision。

## API Contract

Todo API 硬切为四个入口：

```text
GET   /api/projects/:slug/todos
POST  /api/projects/:slug/todos
PATCH /api/projects/:slug/todos/:todoId
POST  /api/projects/:slug/todos/:todoId/sessions
```

删除 Todo detail GET，以及旧 `discuss`、`activate`、`return-to-ready`、`archive`、`restore` 和任何独立 move 接口。普通 Session 创建接口保持现有行为。

### Flat Todo PATCH

```ts
interface ProjectTodoUpdateInput {
  expectedRevision: number;
  title?: string;
  body?: string;
  status?: ProjectTodoStatus;
  rejectionReason?: string;
  archived?: boolean;
  beforeTodoId?: string | null;
}
```

- 除 `expectedRevision` 外至少提供一个字段。
- 所有 mutation 必须校验当前 revision；冲突返回 409 且不写盘。
- 同状态且未提供 `beforeTodoId` 时保持原位置。
- 状态改变且未提供 `beforeTodoId` 时追加到目标列末尾。
- `beforeTodoId: null` 表示明确追加到最终目标列末尾；字符串表示插到该 Todo 前。
- anchor 必须存在、不是自己、未归档且处于最终目标状态；否则返回 409 且不写盘。
- `beforeTodoId` 只能用于四个主 Board 状态。Rejected 或 Archived Todo 不参与拖拽排序。
- `archived` 与 title、body、status、rejectionReason、beforeTodoId 全部互斥。`archived: true` 只接受未归档 Todo，`archived: false` 只接受已归档 Todo；其他组合或无效方向请求失败且不写盘。
- 进入 Rejected 必须提供非空 `rejectionReason`；离开 Rejected 自动清除原因。
- 每个成功请求最多把目标 Todo 的 `revision` 和 `updatedAt` 各更新一次。排序不得修改 anchor 或其他 Todo 的 revision。

### Todo Session creation

```ts
interface CreateProjectTodoSessionInput {
  expectedRevision: number;
  entry: "discussion" | "work" | "automation";
}

interface CreateProjectTodoSessionResponse {
  todo: ProjectTodo;
  sessionId: string;
}
```

- 后端生成 Session ID；客户端不得提供或推断。
- Discussion 要求 Todo 存在且未归档，不改变状态。
- Work/Automation 要求 Todo 未归档且状态为 Ready 或 In Progress。
- Ready 的 Work/Automation 在同一次 Todo mutation 中进入 In Progress，并追加到该列末尾；响应 Todo 的 revision 恰好为 `expectedRevision + 1`。
- In Progress 的 Work/Automation 只校验当前 revision，不触碰 Todo revision 或排序。
- Service 使用本次校验通过的 Todo title、body 和 revision 生成首轮 prompt，创建带 `{ todoId, entry }` 来源的 Root Session，再通过现有 Session 消息接收路径持久接收该 prompt。成功响应要求 Session 和首轮消息均已持久化；后续 Execution 调度沿用普通 Session 生命周期。
- Todo 创建请求不接受消息 `clientRequestId`；现有 Session 消息路径需要的内部请求身份由服务端生成，且不用于 Todo Session 创建去重。
- 状态已提交但 Session 尚未持久化，或 Session 已持久化但首轮消息尚未接收时退出，均不自动补偿、扫描或恢复。用户可以打开空 Session 自行发送消息，也可以从合法的 In Progress Todo 再次 Start。

## UI Contract

- 看板使用 Todo 专用拖拽实现，不抽象通用 Kanban/Board framework。
- 卡片有明确、可聚焦的 drag handle；卡片主体继续负责打开详情，拖拽不得吞掉点击或文本选择。
- 拖动期间只维护组件内临时顺序；drop 后发送一次 PATCH。成功后刷新权威列表；409 或其他失败时清除临时顺序、恢复服务端结果并显示错误。
- 必须支持：
  - pointer 拖拽同列和跨列；
  - touch 拖拽；
  - 键盘聚焦 handle，使用 Space/Enter 拾取与放下、方向键移动、Escape 取消；
  - 辅助技术可读的拾取、目标位置和完成/取消提示。
- Todo 卡片只展示简洁的关联摘要。详情抽屉保持两个直接列表：
  - 来源 Session：按 `updatedAt` 降序，并清楚标注 Discussion、Work 或 Automation setup；
  - Automation：按更新时间降序，并链接现有 Automation 详情页。
- Todo 页面只通过现有项目级 Session summaries 的 `projectTodo.todoId` 和 Automation 列表的 `projectTodoId` 过滤。不得在 Todo 页面查询或 join Invocation，不得增加 Todo 聚合查询接口或复制 Invocation 状态。
- 当前页面的创建 mutation 必须刷新 Todo、Session 和 Automation 查询。Global SSE 的 `session.runtime_changed` 必须使对应项目 Session list 失效，使其他窗口无需手动刷新即可看到新 Todo Session。
- 删除未使用的 Todo detail query/hook/key；Todo resource change 只失效 Todo list。

## Implementation Plan

1. **Protocol 与 Todo 领域硬切**
   - 将 `in_progress` 加入真实状态，删除 Activation、Discussion ID、Activation input/kind/owner 等类型。
   - 将 Todo schema 收敛到 canonical contract；删除状态转换图和 Session 唯一引用校验。
   - 将 StateManager mutation 收敛为一个扁平 update primitive，覆盖内容、状态、归档和数组重排。
   - Start 复用 StateManager 本次 revision 校验与 mutation 的返回结果生成首轮 prompt，不把 Session capability 引入 StateManager。

2. **Session 来源身份**
   - 为 Session 创建选项、严格文件 schema、store state、hydrate/persist、detail 和 summary 增加 `projectTodo`。
   - 在 schema 中强制 Root Lead 不变量，并把来源纳入 Session immutable identity 校验。
   - 将 Discussion 判定、Tool allowlist、Prompt Todo binding、Skill 选择和 delegation depth 从 Todo 反向查询改为当前 Session 身份。
   - `project_todo_update` 继续不接收 `todoId`，从当前 Root Discussion Session 取得 todoId 并保留 expectedRevision；其写入合同只允许 title、body 和 `keep|idea|ready|reject` 决策，不接受 in_progress、done、archived、beforeTodoId 或任何关系字段。

3. **Todo 应用协调**
   - 将 `ProjectTodoService` 收敛为 CRUD、createSession 和 Discussion update。
   - 将 StateManager 设为 Service private implementation detail；ProjectContext、Runtime、Agent、Tool 和 Server 只调用 Service 的窄用例方法，删除 production `context.todos.state`。
   - 后端创建 Root Session，按 entry 生成首轮 prompt，并通过现有 Session 消息接收路径持久接收。
   - 删除 activation resource reconcile、provenance reader、idle-family lease、return-to-ready 和 reverse owner 查询。

4. **Automation 与 Session 删除解耦**
   - Automation schema、Protocol 和 state 增加可选 `projectTodoId`。
   - Automation 创建时从来源 Session 复制 todoId；普通 Session 创建的 Automation 保留 undefined。
   - 删除 Automation 创建后的 Todo binding callback。
   - 删除 Todo Session owner conflict、对应错误与预检；Session 删除只保留 Tool Batch/Tool Output 等通用清理。

5. **Server API 硬切**
   - 将 Todo routes 收敛为四个 API，校验扁平 PATCH 与 Session entry。
   - 删除旧 route、输入、错误码和 service-like 方法。
   - 保持通用 Session API 不变；Todo Session 创建仍通过 ProjectContext 的 Todo service。

6. **Web 看板与关联工作**
   - 使用一套支持 pointer/touch/keyboard 的成熟 sortable primitive，实现 Todo 专用拖拽，不自行开发通用拖拽引擎。
   - 删除 Activation 投影、单例 Discussion/Activation hooks、旧按钮和 Return-to-Ready UI。
   - 实现真实 In Progress 状态、临时拖拽顺序、扁平 PATCH、失败恢复和明确 handle。
   - 实现 Start/Open/Continue/New Discussion/New Session/Create Automation 动作矩阵，以及直接 Session/Automation 关联列表。
   - 删除未使用的 Todo detail query，并补齐 Session list 的跨窗口 invalidation。

7. **彻底清理与验证**
   - 删除仅服务旧模型的 production exports、helpers、errors、fixtures、tests、文案和架构断言；不添加“旧字段/接口必须失败”的墓碑测试。
   - 更新 AGENTS.md 和仍描述 Activation/单例绑定的当前架构文档；历史 progress 只在被当作现行合同引用时修改。
   - 用户数据清理不属于实现或验证步骤，代码和脚本不得触碰已注册项目的旧 Todo 文件。
   - 按下面 Acceptance Criteria 完成自动化测试、真实浏览器验收和最终独立 Review。

## Hard-Cut Rules

- 新代码只接受 canonical schema；不得保留 optional legacy field、unknown-field ignore、migration、dual read/write、feature flag、deprecated alias 或 fallback。
- 删除旧接口和调用方，不保留适配 wrapper、重定向、旧错误码或专门验证旧接口 404 的测试。
- 删除 Activation、单例 Discussion、Return-to-Ready 和 Todo-owned Session deletion protection 的实现与行为测试；用当前正向合同测试替代。
- 不把旧方案换名为 `WorkLink`、`BindingService`、`RelationStore`、`TodoRun` 或另一种一对一状态机。
- 不为网络响应丢失增加请求幂等键、receipt、fingerprint 或重试状态。
- 不增加 Todo 专属 bootstrap Execution ID、来源 snapshot、副本 revision、启动扫描或补启协议。
- 不增加通用排序、拖拽、工作流或跨资源事务基础设施。

## Risks And Deliberate Tradeoffs

- **网络不确定性**：服务端成功但响应丢失后，用户再次 Start 可能创建第二个并行工作。这是明确接受的范围外风险。
- **跨文件崩溃窗口**：Ready 已进入 In Progress、Session 尚未持久化时退出，会留下没有新 Session 的 In Progress Todo；Session 已持久化、首轮消息尚未接收时退出，会留下直接关联的空 Session。两种状态都合法，不做回滚、扫描或恢复。
- **破坏性 API/schema 变更**：旧客户端与旧 Todo 文件不兼容；本 Goal 不处理旧数据。用户必须在运行新代码前自行清理。
- **并发排序冲突**：同一卡片 revision 过期，或 anchor 已缺失、归档、离开目标状态时请求返回 409；anchor 仅在同列改变位置仍是合法锚点，不尝试检测或合并该变化。不同卡片的合法请求按 StateManager 到达顺序生效。
- **跨窗口最终一致性**：关联列表依赖 Session/Automation 查询失效；漏掉 SSE invalidation 会导致其他窗口陈旧，必须纳入验收。
- **拖拽可访问性**：只验证鼠标会遗漏触摸与键盘用户；选用 sortable primitive 不能替代实际 interaction 和浏览器验收。

## Non-goals

- 不迁移、备份、重置或删除任何用户 Todo/Session/Automation 数据。
- 不支持跨项目 Todo、attach existing Session、关系历史、标签、优先级、截止日期、依赖、子任务或自定义列。
- 不增加服务端 Todo 聚合查询、分页或关系索引；当前继续使用项目级 Session/Automation 列表。
- 不在 Todo 页面展开 Automation Invocation 或其 Session；这些信息继续由 Automation 详情页负责。
- 不让 Todo 状态自动跟随 Session/Automation running、failed、paused、completed。
- 不因 Todo 移动、Rejected、Done 或 Archived 而停止、暂停、取消或删除工作资源。
- 不重构普通 Session、Automation scheduler、Invocation 生命周期、Goal、HITL 或 Session 内 Agent `todo_write`。
- 不处理网络 exactly-once，不建立离线操作队列。

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部有代码、自动化测试及其中明确要求的浏览器证据。任一条件未满足即为 `NOT_DONE`。

### AC-01：Todo canonical domain 与自由状态成立

- Protocol、Agent Core、Server 和 Web 使用同一个 `idea | ready | in_progress | done | rejected` 状态集合；In Progress 不再由关联资源投影。
- 新 Todo 为 Idea、body 为空、revision 为 1；成功更新恰好增加目标 Todo 一次 revision/updatedAt，过期 revision 返回 409 且磁盘内容不变。
- 四个主状态可在任意方向切换。进入 Rejected 缺少原因时请求失败且不写盘；离开 Rejected 后原因不存在。
- Archive/Restore 请求都不得夹带其他 mutation 字段；Archive 保留 status 且不删除或重插数组项，已归档 Todo 除 `archived: false` 外不可修改。Restore 后的位置以恢复时的 canonical 数组为准；归档期间其他 Todo 的移动可以改变其相邻项。
- Todo schema 和 state file 不含 Session ID、Automation ID或任何资源运行状态。

### AC-02：数组排序在同列、跨列和并发下确定

- reload 与 Runtime restart 后，同一列卡片顺序与最后一次成功 drop 完全一致。
- 自动化测试覆盖同列向前/向后、跨列、空目标列、明确 append、状态变化默认 append，以及移动首项/末项。
- self、missing、archived 或目标状态不匹配的 anchor 均返回 409，不改变任何 Todo。
- 两个不同卡片的请求按 StateManager 串行顺序生效；同一卡片过期 revision 的后请求失败。任何移动都不修改 anchor/相邻卡片 revision。
- Rejected/Archived 视图不提供 drag handle，也不接受 `beforeTodoId`。

### AC-03：一 Todo 多 Root Session 与后端 ID 成立

- 同一 Todo 可创建至少两个 Discussion 和两个 Work Session；所有 Session ID 均由后端生成且不同，Todo 文件仍不含这些 ID。
- Discussion 可从任意未归档状态创建且不改变 Todo；Work/Automation 只在 Ready/In Progress 成功。
- Ready Start 成功后 Todo 为 In Progress，并位于该列末尾；In Progress Start 不增加 Todo revision或改变顺序。
- 每个来源 Session 只保存准确的 todoId 和 entry；首轮消息包含本次请求校验通过的 Todo title、body 和 revision，后续 Todo 编辑不改写既有消息。
- Session schema 拒绝 child、非 Lead 或非 root identity 携带 `projectTodo`；子 Session 不复制来源。

### AC-04：首轮消息与 Discussion 权限边界成立

- 每个成功的 Todo Session 创建请求都持久化一个带 `{ todoId, entry }` 来源的 Root Session，并通过现有 Session 消息接收路径恰好接收一次首轮输入。
- 故障注入覆盖：状态提交后、Session 创建前失败时 Todo 合法停在 In Progress 且没有伪造关系；Session 持久化后、首轮消息接收前失败时保留一个可打开的空 Session。
- Todo Service 的首轮输入只调用普通 Session 创建和消息接收能力；Project 启动不进入 Todo 恢复流程。已接收的首轮消息不因当前 Todo 后续编辑、移动、Rejected、Done 或 Archived 而改写。
- 只有 Root Lead 且 `entry="discussion"` 的 Session 获得 shape-todo/`project_todo_update` 权限和 Discussion delegation 限制；Work/Automation Session 保持普通 Root Lead 能力。
- `project_todo_update` 输入没有 todoId，只能更新当前来源 Todo，并要求 expectedRevision；普通、child、非 Lead 或跨项目调用被拒绝。
- `project_todo_update` 只允许 title、body 和 `keep|idea|ready|reject`；尝试 in_progress、done、archive、排序或关系修改在 Tool schema 边界不可表达。

### AC-05：Automation 与删除语义成立

- 从带 Todo 来源的 Work/Automation Session 创建 Automation 时，Automation 持久化相同 `projectTodoId`；普通 Session 创建时该字段不存在。
- 一个来源 Session 创建多个 Automation 时全部关联同一 Todo；Todo 不选择“最早”或“唯一”资源。
- `start_session` Invocation 新建的 Session 不含 `projectTodo`；`send_message` Invocation 不创建或重绑 Session，并保留目标 Session 原有的 `projectTodo`。
- Todo 详情不查询或投影 Invocation；用户通过 Automation 链接进入现有详情页查看 Invocation 与对应 Session。
- 删除关联 Session 后，Todo 无变化且 Session 从关联列表消失；不存在 Todo owner deletion conflict。
- 来源 Session 删除后 Automation 仍通过自身 `projectTodoId` 出现在 Todo 下；删除 Automation 后关系自然消失且不留墓碑。

### AC-06：API 与 hard cut 完整

- Todo Server 只注册本计划列出的四个 API；Web 没有 Todo detail query，也没有旧 action hook。
- 扁平 PATCH 的字段组合、revision、archive 和 anchor 规则都有 route/service/state 正负测试。
- 当前 production type、schema、route、service、runtime wiring、Web 和活跃架构文档只描述新来源模型，不存在旧模型的运行路径、兼容字段、迁移或 fallback。
- 架构测试证明 ProjectContext 的生产消费者不能访问 `context.todos.state`；所有 Todo 用例经过 `ProjectTodoService`，StateManager 仍保持 Session/Automation 无关。
- 测试只验证当前合法合同和真实错误边界；不存在专门验证旧字段、旧接口或旧名称被拒绝的墓碑测试。
- 通用 Session 创建、普通 Automation 创建、Session 内 `todo_write` 和其他 Project API 的现有行为继续通过。

### AC-07：Web 行为与多窗口一致

- Ready 卡片的 Start work/Create Automation 成功后自动出现在 In Progress；Continue work 先完成 Ready -> In Progress PATCH 再导航。Idea/Done/Rejected/Archived 不显示 Continue。
- Open 在所有状态下只导航，不修改 Todo。New Discussion、Continue Discussion 和 New Session 指向正确 Root Session。
- 详情抽屉只展示两个直接列表：标注 entry 的来源 Session，以及关联 Automation；Todo 页面不发出 Invocation 查询。
- Continue work 只打开最近更新的 `entry="work"` Session，绝不打开 Discussion 或 Automation setup Session。
- pointer、touch、keyboard interaction 测试覆盖 pickup、同列/跨列移动、drop、Escape cancel、错误恢复和可访问提示。
- 两个浏览器标签同时打开同一 Todo Board：标签 A 创建 Todo Session 后，标签 B 通过 SSE/query invalidation 在不手工 reload 的情况下显示新关联。
- 409 后卡片恢复服务端状态并显示可理解错误；拖动过程中不发送网络请求，drop 恰好发送一次 PATCH。

### AC-08：仓库验证与真实浏览器验收

- 定向 Todo/Session/Automation/Server/Web unit、integration、architecture 和 interaction tests 全部通过。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 真实浏览器在 1440px、390px 和 320px 验收：创建 Todo；四列自由拖拽；同列重排；Ready Start 自动进入 In Progress；同 Todo 新开并打开多个 Session；打开关联 Automation；Rejected/Archived 无拖拽；窄屏无水平溢出。
- 浏览器键盘验收至少完成一次聚焦 handle、拾取、跨列移动、放下和 Escape 取消；触摸视口至少完成一次跨列 drop。
- 验收期间 console 无产品代码 error；所有失败请求都产生明确 UI 反馈且最终显示服务端权威状态。
- fresh independent `sol(xhigh)` 或更高 Reviewer 按 AC-01 至 AC-08 检查最终实现证据；存在 blocking/high finding 即为 `NOT_DONE`，修复后必须重新 Review。
