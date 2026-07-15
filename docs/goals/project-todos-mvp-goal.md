# Project Todos MVP Goal

## Objective

为每个 Project 增加独立的 `Todos` 主入口：用户可以低成本记录尚未准备开发的事项，与专用 `Shaper` Agent 讨论、纠正或拒绝，并在决定开始后将当前 Todo 快照交给普通 Engineer Session、Goal 或 Automation。Todos 只拥有执行前的意图与决策，不改变现有 Session、Goal、Automation 的创建确认、执行、Review、HITL 或完成语义。

完成本 Goal 必须跑通 `记录 -> Shaper 讨论并写回 -> Ready/Rejected -> 选择现有执行原语` 的完整用户路径；不能只交付看板 CRUD。

## Locked Architecture

```text
Project open -> /projects/:slug/todos -> ProjectTodo domain
                                      -> Shaper Session -> project_todo_update -> same Todo
                                      -> Start Session -> ordinary Engineer Session
                                      -> Start Goal -> ordinary Engineer Session -> existing goal-create Skill
                                      `-> Create Automation -> ordinary Engineer Session -> existing automation-create Skill

/projects/:slug -> existing Project Dashboard, preserved for future implementation
```

- `ProjectTodo` 是用户拥有的项目级意图；现有 `SessionTodo` / `todo_write` 仍只表示单个 Session 内的 Agent 执行步骤，两者不得复用类型、存储、工具或 UI 状态。
- `packages/agent-core/src/todos/` 集中拥有该领域：`ProjectTodoStateManager` 只负责严格 schema、状态迁移、revision 和原子持久化；Todo 文件的 workspace 路径就是项目归属，不持久化可在重新注册时变化的 Project slug。窄 `ProjectTodoService` 只通过注入的 Session/provenance capability 协调可恢复的 Discussion/Activation 创建与资源绑定，不拥有 Session、Goal 或 Automation 生命周期。Server route 只做 HTTP 适配，Web 只依赖 Protocol DTO。
- 项目状态使用现有单文件原子写入和串行 mutation 模式，不新增数据库、Repository 框架、通用关系图或 Workflow/Phase Runtime。
- Shaper 是正式第八个 Agent。它负责完善和判断 Todo，不负责实现、规划或创建执行资源。
- Shaper Session 与 Todo 的绑定只由 Todo 上的 `discussionSessionId` 记录；`project_todo_update` 从当前 Session 身份反查绑定 Todo，模型不能填写任意 `todoId`。Session 删除预检通过窄 Todo owner 查询保护被引用 Session，不在 Session store 复制反向 ID。
- Todo 只记录一个当前 Activation 的类型、来源 Engineer Session、启动时 Todo revision、不可变 title/body 快照和可选的精确执行资源 ID；快照只用于故障恢复时重建同一首轮输入。Goal/Automation 的实时状态继续从其权威 store 派生，`createdFromSessionId` 只用于校验和恢复绑定，不作为唯一资源 ID，也不复制状态到 Todo。
- Discussion/Activation 跨 Todo 与 Session 两个持久化边界时不宣称跨文件事务：先原子保存预生成的 Session ID，再幂等 ensure Session，并以确定性 execution ID 启动首条消息；重试及 Project context 恢复必须收敛到同一 Session 和同一次首轮执行。

最小领域模型必须等价于：

```ts
type ProjectTodoStatus = "idea" | "ready" | "done" | "rejected";

interface ProjectTodo {
  id: string;
  title: string;
  body: string;
  status: ProjectTodoStatus;
  rejectionReason?: string;
  revision: number;
  discussionSessionId?: string;
  activation?: {
    kind: "session" | "goal" | "automation";
    sourceSessionId: string;
    todoRevision: number;
    snapshot: { title: string; body: string };
    resourceId?: string;
  };
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

`In Progress` 是存在 Activation 且未 `done/rejected/archived` 的 UI 投影；`Archived` 是可见性属性，不是 Todo 状态。不得新增笼统的 `closed` 状态。

## Non-goals

- 不实现跨项目 Todos、移动端、语音、MCP、GitHub/Linear 同步、多人协作或 Agent 自动提出/领取 Todo。
- 不实现拖拽、自定义标签、优先级、截止日期、依赖、子任务、自定义工作流或完整 revision history UI。
- 不支持一个 Todo 的多个 Discussion Session 或多个并行 Activation；MVP 每个 Todo 至多各有一个。
- 不实现 Project Dashboard 内容；只保留其现有路由和入口。
- 除本 Goal 明确规定的 Todo 引用 Session 删除保护外，不修改普通 Session、Goal、Automation、Reviewer、HITL、Budget、worktree、retry 或调度语义。
- 不新增 Work、WorkItem、Discover/Plan/Deliver Phase 或通用资源关系层。

## Hard-Cut Constraints

- Agent 列表和严格配置直接切换为包含必填 `shaper`；缺少 `agents.shaper.model` 必须失败并给出明确错误，不得回退到 Engineer/Plan 模型或隐藏默认值。
- 产品、Protocol、API、路由、组件和活动文档统一使用 `Todos` / `ProjectTodo` / `Shaper`；不得保留 `Backlog`、`WorkItem`、`Idea Library` 别名路由、双写或兼容 adapter。
- Project Todo 不接受旧 Session Todo schema，不读取 `todo_write` 事件，不提供字段默认补全、旧格式 fallback 或迁移器。
- 本 Goal 修改到的 Agent 配置、Project 打开动作和 Todos 导航必须直接切到新契约；删除相关死代码、旧测试和旧文案，不保留 deprecated export 或条件兼容分支。Project Dashboard 路由和入口按 Locked Architecture 明确保留。

## Acceptance Criteria

以下 AC-01 至 AC-06 必须全部有代码、测试和必要的浏览器证据；任一缺失即为 `NOT_DONE`。

### AC-01：ProjectTodo 领域完整且唯一

- 提供项目级 Todo 的 list/create/read/update/archive/restore 能力；创建只要求非空标题，`body` 默认为空，初始状态为 `idea`。
- 只允许 `idea -> ready|rejected`、`ready -> idea|rejected|done`、`rejected -> idea`、`done -> ready`；Reject 必须保存非空 `rejectionReason`，恢复后清除该原因。
- 每次成功 mutation 原子持久化并将 `revision` 恰好增加 1；带过期 `expectedRevision` 的更新返回明确冲突且不写盘。
- 只有 `ready` 且不存在 Activation 的 Todo 可以启动；活跃 Activation 期间不得切换 Idea/Rejected、再次启动或 Archive。`Return to Ready` 必须先完成一次 provenance 恢复，再按类型验收：Session 要求来源 family 为 idle；Goal 还要求不存在匹配资源、资源已删除或状态为 `done|not_done|failed|cancelled`；Automation 还要求不存在匹配资源、资源已删除或状态为 `paused|disabled`。满足后才可清除 Activation 并保留 `ready`；该动作不得代替原领域停止、取消、暂停或删除资源。
- `archivedAt` 可以隐藏任意非活跃 Todo，Restore 恢复原状态；Archive 不改写 `status`。Mark Done 保留 Activation 供结果回链，Done Reopen 必须同时清除旧 Activation 并回到 `ready`；MVP 不保存被清除的 Activation 历史。
- Todo 持久化、API、SSE resource change 和 Web query 都以 ProjectTodo domain 为唯一事实来源；Session store 不缓存 ProjectTodo 内容或反向 ID。

### AC-02：Shaper 是独立且可用的正式 Agent

- `AGENT_NAMES`、Protocol config、严格 Zod schema、Settings Agents UI、Agent definitions、model resolution 和测试都包含必填 `shaper`，且不存在模型 fallback。
- Shaper allowlist 至少包含只读文件/搜索/LSP、`web_fetch`、`bash`、`ask_user`、`memory_read`、`memory_write`、`project_todo_update`、Session `todo_write` 及 Explore/Librarian delegation；不包含 `file_write`、`file_edit`、`ast_grep_replace`、`goal_create`、`automation_create` 或 Build/Reviewer delegation。
- Shaper 的 Bash 继续经过现有 classifier、权限、redact、audit 和 logger 链，不新增 Shaper 专用 shell 或旁路；角色契约明确 Bash 用于调查和验证，而不是开始实现。
- Shaper 不启用自动 memory extraction/consolidation；它可以手工读写已经确认的长期事实，但不得把未确认 Todo 猜测自动沉淀为 Memory。
- Shaper prompt 明确输出是更新当前 Todo、提出未决问题并建议 Ready 或 Rejected；不得生成实现计划或宣称开始开发。

### AC-03：Discussion 必须真实写回 Todo

- `Discuss` 为没有 Discussion 的 Todo 预生成根 Session ID 并先保存 `discussionSessionId`，再通过窄 capability 幂等 ensure `agentName="shaper"` 的根 Session；再次点击、并发重试和进程重启都只能恢复或打开同一 Session。
- Shaper Session 首轮上下文包含 Todo ID、revision、title、body 和当前状态；Session 页面显示可返回该 Todo 的明确关联。
- Discussion 首轮使用由 Todo ID 派生的确定性 execution ID；若该 execution 已持久化则不得重复发送首轮消息。Session 创建、Todo 持久化或首轮启动在任一步失败后，重试必须收敛且不留下孤儿 Session。
- 新工具 `project_todo_update` 不接受 `todoId`，只更新绑定当前 Session 的 Todo；非 Shaper、非根 Session、未绑定 Session 或跨项目调用必须被拒绝。
- 工具只允许修改 `title`、`body`、`status: idea|ready|rejected` 和 `rejectionReason`，并要求 `expectedRevision`；不得设置 `done`、`archivedAt`、`activation` 或 Discussion 关系。
- Shaper 只有在用户于当前 Discussion 中明确要求或确认后才能切换 Ready/Rejected；状态更新成功后，返回并显示最新 Todo 和 revision。Todo 编辑结果在刷新和进程重启后保持一致。

### AC-04：项目默认入口与 MVP UX 明确

- 从 Project Bar、项目注册成功和正常“打开项目”动作进入 `/projects/:slug/todos`；直接访问 `/projects/:slug` 仍显示独立的 Project Dashboard 占位页。
- 项目侧栏同时提供 `Todos` 和 `Project Dashboard` 两个入口，现有 Sessions/Goals/Automations 列表和导航保持可用。
- Todos 默认主视图恰有 `Ideas`、`Ready`、`In Progress`、`Done` 四组；`Rejected` 和 `Archived` 是独立视图，不显示单一 Closed 组。
- `New Todo` 支持标题单行快速创建；卡片至少显示标题、当前投影、Discussion/Activation 关联和一个与状态匹配的主动作。
- 卡片详情允许编辑 title/body、打开或继续 Shaper Discussion、Mark Ready、Reject、Archive/Restore、Mark Done/Reopen、Return to Ready，以及选择 Start Session/Goal/Automation。
- MVP 不加载拖拽库且不存在拖拽状态迁移；所有会改变决策或启动资源的动作都有明确按钮和错误反馈。

### AC-05：三种 Activation 复用现有执行原语

- 三种启动都先原子记录预生成的 `sourceSessionId`、`todoRevision`、当时的不可变 title/body 快照和 Activation，再幂等 ensure 新的普通 Engineer 根 Session，并以该 Todo Activation 的确定性 execution ID 发送该快照；后续 Todo 编辑及故障恢复不得改变首轮输入，Shaper Discussion Session 不得复用为执行 Session。
- `Start Session` 立即令 `resourceId === sourceSessionId`。`Start Goal` 和 `Create Automation` 分别通过现有 `goal-create` / `automation-create` Skill 完成澄清和用户确认；不得从 UI、Shaper 或新增 API 绕过现有创建工具和 `createdFromSessionId` 校验。
- Goal/Automation 创建成功后，Todo 侧通过窄资源创建通知和只读 provenance capability 将该来源 Session 创建的首个同类资源 ID 绑定一次；重复通知必须幂等，后续资源不得改写绑定。若在资源提交后、Todo 绑定前重启，恢复逻辑按 `createdFromSessionId` 确定性绑定最早创建的同类资源。
- Activation 在启动前记录 Todo revision，之后修改 Todo 不得静默改变正在运行的 Session/Goal/Automation；MVP 不允许同一 Todo 创建第二个活跃 Activation。
- Return to Ready 通过 AC-01 的不活跃门槛后只解除 Todo 与当前 Activation 的关系，不停止、删除或修改已经创建的 Session/Goal/Automation；资源后续生命周期仍由其原领域拥有，门槛不满足时返回明确冲突且不得清除关系。
- Todos UI 在 `resourceId` 尚未绑定时链接来源 Session并显示准备中；绑定后按精确 `resourceId` 从权威 store 读取并链接普通 Session、Goal 或 Automation 的当前状态，资源缺失时显示已删除，不按 `createdFromSessionId` 猜测唯一结果。
- Shaper 不自动启动工作；`Ready` 也不触发执行。`Done` 只由用户显式标记，Goal done 或 Automation 创建成功最多提供建议，不得静默完成 Todo。
- 用户不经过 Todo 直接新建普通 Session、Goal 或 Automation 的既有入口和行为保持通过。

### AC-06：架构、硬切和最终验收

- `todos/` 领域不得依赖 Server/Web/Agent prompt 或 Goal/Automation 具体实现；StateManager 不得创建 Session，ProjectTodoService 通过窄 Session/provenance capability 协调后立即交还所有权。Server routes 通过 ProjectContext capability 调用该服务，Web 仍只依赖 Protocol。
- Session 删除预检必须把 Discussion Session 和仍保留在 Activation 中的来源 Session 识别为 `project_todo` owner 并拒绝删除，错误返回 Todo ID；Activation 清除后来源 Session 才失去该 owner，Discussion 关系在 Todo 存续期间始终受保护。
- 不得出现第二个 Todo 状态机、通用 Workflow Manager、Relation Graph、Repository/DTO 层或同时拥有 Todo、Session、Goal、Automation 生命周期的大型协调器。
- 审计确认生产代码和活动 UI 中不存在 ProjectTodo 对 SessionTodo/`todo_write` 的复用、`closed` Todo 状态、`Backlog`/`WorkItem` alias、Shaper model fallback、旧配置兼容或双读双写。
- 单元/集成/架构/Web interaction 测试覆盖状态迁移、revision 冲突、Shaper 授权、Discussion 单例、三种 Activation、精确资源绑定、Return to Ready 不活跃门槛、Todo owner 删除保护、默认项目导航和 Dashboard 保留。
- 故障注入测试分别中断 Discussion/Activation 的 Todo checkpoint、Session ensure、首轮 execution 以及 Goal/Automation 创建后资源绑定；重试或重启恢复后必须恰有一个 Session、一次首轮消息和至多一个绑定资源，不得存在孤儿或悬空关系。
- 浏览器逐条验收：打开项目落到 Todos；创建 Idea；与 Shaper 讨论并看到内容写回；确认 Ready 或 Rejected；使用三个独立的 Ready Todo 分别启动 Session、Goal、Automation；验证 Return to Ready；仍能打开 Project Dashboard。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；Reviewer 必须按 AC-01 至 AC-06 给出文件、测试、搜索和浏览器证据，不能只用“测试通过”代替验收。
