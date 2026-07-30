# Todo Discussion、Plan 与 Goal 交接硬切 Plan Goal

## Goal

把下面这条用户路径做成清晰、可执行、可验收的产品能力：

```text
记录 Todo
  → 可选：在 Discussion 中澄清并生成/完善唯一 Plan
  → Start Work 创建普通 Lead Session
  → 若 Plan 存在，Lead 按 Plan 工作，并由用户决定是否启动 Goal
  → Goal 监督执行并在内部完成 Review
```

Todo 只负责记录工作及承载讨论入口；Plan 是普通 Markdown 实施方案；Goal 是普通 Lead Session 上可选的持久执行协议。三者彼此可组合，但不互相拥有，也不增加新的工作项状态机。

本次是架构硬切：Todo Discussion 从隐藏的 `lead + projectTodo.entry === "discussion"` 模式改为正式 `discussion` Agent。删除旧分支，不保留 fallback、数据迁移、兼容读取或墓碑测试。

## 已锁定的产品与架构决策

1. Todo 的四个状态、状态迁移和 `Start Work` 行为不改。
2. Todo 不知道后续是否使用 Plan 或 Goal；没有 Plan 的 Todo 可以直接执行，任何工作 Session 也可以选择使用或不使用 Goal。
3. 每个 Todo 最多使用一个确定路径的 Plan：`.archcode/plans/<todo-id>.md`。
4. Plan 是普通 Markdown 文件，不新增 Plan ID、数据库、服务、API、状态、版本、审批、锁、快照或 Goal 外键。
5. Plan 至少写清目标与背景、范围与非目标、实施步骤、依赖与顺序、验收标准、验证方法、风险与待确认项。
6. Plan 可由自然语言触发，也提供固定文案的“Generate / Improve Plan”入口；按钮确定性路由到 `/skill use plan-work`，命令校验 Skill 并注入 `skill_read` 指令，最终以 tool trace 与 Plan 产物验收。自然语言只以最终 Plan 结果验收，不新增意图路由器。
7. `Start Work` 只创建普通 Lead Session，不替用户决定是否启动 Goal。
8. `Start Work` 创建 Session 时只检查一次确定路径；若 Plan 存在，首条消息确定性路由到 `/skill use execute-plan`，命令校验 Skill 并注入 `skill_read` 指令。验收 trace 必须先读 Skill 和 Plan，再询问用户是否创建 Goal；用户拒绝时继续普通 Session 执行。
9. Goal 不要求必须有 Plan，Plan 也不要求必须创建 Goal。Goal 的 Review 继续留在 `run-goal` 协议内，不新增 Review 实体。
10. Goal 执行期间，只有当用户在当前 Lead 会话明确提出或告知 Plan 已修改时，Agent 才提醒“当前 Goal 仍按已建立的目标与验收口径执行”；不做自动感知、同步、版本检测或执行重启。
11. Discussion 需要 Bash、文件读写和研究能力。约束源码修改依靠 Agent system prompt 与 Skills，是行为约束，不宣称为安全边界；现有全局权限、`.git/**` 与 `.archcode/runtime/**` 保护继续生效。
12. 不做通用 Tool Hook/Permission 重构，不为本场景增加动态工具描述或路径型权限。
13. `.archcode` 是否进入 Git 完全由用户管理；产品不检查、不修改、不提醒 `.gitignore`。

## 目标架构

### 1. Agent 身份

- 新增正式运行时 Agent：`discussion`，默认 Profile 为 `principal`。
- `discussion` 只能由 Todo 的 Discussion 入口创建，不能从普通 New Session 创建，也不能被其他 Agent `delegate`。
- Discussion 仍是直接面向用户的 root Session，保留现有附件输入和下一次执行的模型/Variant 选择能力；这些共同能力不授予 Goal、Automation 或 Worktree 权限。
- Ultra/协作执行拓扑仍是 `Lead → Analyst / Build / Explore / Librarian`；Discussion 不是执行团队成员。
- Discussion 只可委派 Explore、Librarian，最大深度 2，用于本地与外部研究。
- 对外表述为“五个执行/协作 Agent，加一个 Todo Discussion 入口 Agent”，避免把 Discussion 包装成执行角色。

### 2. Session 来源与运行时职责

`Session.agentName` 是运行时行为、工具、Prompt、Skill 和授权的唯一身份依据。

`projectTodo: { todoId, entry }` 仅保留为不可变来源信息，用于创建命令、Todo 关联和 UI 展示。建立以下严格一致性：

- `agentName === "discussion"` 必须绑定 `projectTodo.entry === "discussion"`；
- `projectTodo.entry === "discussion"` 必须对应 `agentName === "discussion"`；
- Todo 的 `work` / `automation` 来源继续创建 Lead；
- 旧的 `lead + entry: "discussion"` 持久数据直接不兼容，不迁移、不降级读取。

除创建与一致性校验外，生产运行时不得再用 `projectTodo.entry` 选择工具、Prompt、Skill、Goal、Automation 或 Worktree 权限。

代码中把“直接面向用户的 root Session”与“只有 Lead 才能拥有的执行协议”分开：

- Lead 与 Discussion 共有：root Profile 解析、附件、模型/Variant 选择、Todo 来源绑定；
- 仅 Lead 拥有：Goal、Automation、Worktree、Ultra 执行编排；
- 不建立通用 capability/permission 框架，只在一个窄的 root identity policy 中枚举这两个正式身份。

### 3. Discussion 能力边界

Discussion Definition 集中声明：

- 可用：Bash、文件读写、搜索/AST 查询、Git status/diff、LSP、Web、Memory、输出恢复、提问、Skill、Todo 内部工作清单、当前绑定 Todo 更新；
- 可委派：Explore、Librarian；
- 不可用：Goal 创建/更新、Automation 创建、Worktree 变更、`ast_grep_replace`、Build/Analyst 委派以及执行型家族控制能力。

稳定 system prompt 只定义身份与边界：

- 目标是澄清 Todo、研究问题、形成可执行信息；
- 可以按用户要求创建或完善唯一 Plan；
- 不得开始产品代码实施；
- 源码不修改是行为要求，不是权限保证；
- 写 Plan 前必须读取现有文件，避免静默覆盖用户内容。

工作方法分别由 Skills 承担：

- `shape-todo`：Todo 澄清、研究、更新方法；
- `plan-work`：Plan 结构、写入和验收标准方法；
- `execute-plan`：普通 Lead 的 Plan → Goal 交接方法；
- `run-goal`：Goal 执行与最终 Review。

## 实施 Plan

### 第 1 步：硬切正式 Discussion Agent

1. 在 Agent 名称、定义索引、Factory、Store/Session schema、Prompt role contract 和 Web Agent 展示映射中加入 `discussion`。
2. 将现有 Discussion 专用工具集合、委派目标、深度和 Prompt 从 Lead 的条件分支迁入独立 Definition。
3. Todo Discussion 创建路径直接创建 `discussion` Session；`shape-todo` 只由正式 Agent identity 在每次 Execution 派生，不同时写入 `activeSkillNames`。
4. 保留 `entry` 作为来源信息，但删除 `ConfiguredAgent`、Runtime、SessionExecutionManager 和各工具中依赖 `entry === "discussion"` 的行为分支。
5. `project_todo_update` 改为校验“当前根 Agent 是 `discussion` 且绑定同一个 Todo”，不再校验 Lead Discussion 模式。
6. Goal、Automation、Worktree 等现有 Lead-only 能力通过 Agent 身份自然排除 Discussion，不再各自增加 Discussion 特判。
7. 收口 root identity policy，并逐项改造当前硬编码 root Lead 的公共入口：Session 创建/持久化、Profile 解析、Prompt lint/completion authority、Todo 绑定、附件校验和模型/Variant 选择；Goal 等执行协议仍保持 Lead-only。
8. 严格拒绝不一致的新 Session；旧 Lead Discussion 数据不迁移、不兼容。

### 第 2 步：收敛 Discussion Prompt 与 Skills

1. 重写 `shape-todo`，允许按用户意图形成 Plan，但继续禁止开始实现。
2. 收紧 `plan-work`：
   - Todo Discussion 中只写 `.archcode/plans/<todo-id>.md`；
   - 有文件先读后改，无文件才创建；
   - 必须包含已锁定的七类信息；
   - 验收标准必须是可观察、可判定的完成条件，未知项必须先询问用户；
   - 不创建任何 Plan 元数据或旁路状态。
3. 修改 Todo Discussion 的首条持久消息：允许用户要求生成/完善实施 Plan，但继续明确禁止开始产品代码实施；删除现有“不得产出 implementation plan”的冲突指令。
4. 在 Agent/Skill 文案中明确 Bash 与文件能力的行为边界；不得把 Prompt 描述成强制权限隔离。
5. 更新内置 Skill 清单与 Definition allowlist，使 Discussion 可用 `shape-todo`、`plan-work`，Lead 可用 `execute-plan`。

### 第 3 步：提供 Plan 产品入口

1. 在 Todo 详情的 Discussion 区域增加固定文案的次级操作“Generate / Improve Plan”；UI 不探测 Plan 是否存在。
2. 点击后优先进入该 Todo 最近一次 Discussion；不存在时创建新的 Discussion Session，并把 Plan 请求作为该 Session 的首条消息原子提交，不得先启动普通 Discussion 再补发第二条命令。
3. 已有 Discussion 发送 `/skill use plan-work ...` 和确定的 Plan 路径；新 Discussion 的首条消息使用同一 Skill 请求。命令校验 Skill 并向模型注入 `skill_read` 指令。验收 tool trace 必须在任何文件写入前调用 `skill_read`，Plan 已存在时还必须先调用 `file_read`；最终内容须与当前绑定 Todo 一致。
4. 自然语言“为这个 Todo 做/改 Plan”不增加意图分类器；验收其是否读写同一确定路径并产出同样的内容契约，不验收内部是否调用了 Skill。
5. 不改变 Todo 状态，不因生成 Plan 自动 Mark Ready，也不新增 Plan 页面或状态徽标。
6. 按仓库 UI 规范同步 Todos 页面设计说明与实现；该操作属于现有页面的小型交互，不新建平行原型或新页面。

### 第 4 步：接通 Start Work 后的 Plan → Goal

1. `Start Work` 仍创建普通 Lead Session，保持现有 Todo 状态迁移和来源关联。
2. Todo Session-entry coordinator 在创建 Work Session 时对确定路径做一次文件存在性检查；它不把结果写回 Todo、DTO 或任何持久状态：
   - 不存在：发送现有普通实施首条消息；
   - 存在：首条消息路由到 `/skill use execute-plan ...`，传递 Todo 与确定的 Plan 路径。
3. 不把 Plan 检查放入长期激活的 `orchestrate-work`，避免后续 Execution 重复检查和询问。
4. 新增 `execute-plan` Skill，要求 Lead：
   - 检查 Plan 是否足以执行，关键缺口先询问；
   - 用 Plan 中的目标与验收标准拟定 Goal；
   - 通过现有 `ask_user` 明确询问是否创建 Goal；
   - 同意后调用现有 `create_goal`；拒绝后继续普通执行；
   - 不把 Plan 路径、摘要、哈希或版本写入 Goal schema。
5. Goal 创建后的执行、委派、验收与独立 Analyst Review 完全复用现有 `run-goal`，不增加第二套 Review 流程。
6. Skill 只处理“用户在当前 Lead 会话明确提出/告知修改 Plan”这一事件并给出提醒；不增加文件监听、版本同步或自动重启。

### 第 5 步：删除旧架构并闭环验证

1. 删除 Lead Definition 中 Discussion overlay、`isDiscussion` 投影及所有基于 `entry` 的运行时分支。
2. 删除或重写依赖旧 Lead Discussion 身份的测试；只测试新的当前契约，不保留旧符号、旧 fixture 或兼容路径的墓碑测试。
3. 更新活跃架构文档、Agent 数量/职责、Todo Discussion 数据流和 Skill 说明；历史 `docs/goals/` 记录保持原样。
4. 依次完成类型检查、相关单元/架构/集成测试、全量测试、Web build，并对 Todo 的 Plan 按钮和两条 Start Work 路径做浏览器验证。

## 验收标准

### AC-1：Discussion 是正式且唯一的运行时身份

以下条件必须全部满足：

- Agent catalog 与持久化 schema 接受 `discussion`；
- Delegation request 的 Agent 类型不接受 `discussion`；
- 普通 Session 创建接口不能创建 Discussion，Todo Discussion 入口可以；
- `discussion` Session 缺少绑定 Todo、或 Discussion 来源绑定非 `discussion` Agent 时，创建/加载明确失败；
- 生产代码中不存在 Lead Discussion 工具 overlay 或 `isDiscussion` 运行时模式；
- root Discussion 使用 `principal` 默认 Profile，并保留附件输入与模型/Variant 选择；Goal、Automation、Worktree 仍只接受 root Lead。

### AC-2：`entry` 不再控制运行时行为

代码检索与架构测试共同证明：

- `projectTodo.entry` 只出现在 Todo Session 创建/首条消息、来源一致性校验、协议序列化和 UI 展示/命令分支中；
- Agent 工具解析、Prompt 编译、Skill 激活、Goal、Automation、Worktree、`project_todo_update` 授权均不读取 `entry` 决策；
- 上述行为全部由正式 Agent identity 与现有 root/Goal 状态决定。

### AC-3：Discussion 能研究、写 Plan，但不能进入执行协议

Definition 级测试必须精确证明：

- Discussion 有 Bash、`file_read`、`file_write`、`file_edit`、研究工具、`project_todo_update`、Skill 工具及 Explore/Librarian 委派；
- Discussion 没有 Goal、Automation、Worktree、`ast_grep_replace`、Build/Analyst 委派；
- `project_todo_update` 只能修改 Session 绑定的 Todo，并继续执行 revision 冲突校验；
- system prompt 与 Skills 明确禁止开始实现，同时文档明确这不是安全沙箱；
- 现有全局敏感路径、`.git/**`、`.archcode/runtime/**` 和 Bash 权限测试继续通过。

### AC-4：一个 Todo 只有一个普通 Markdown Plan

用新 Todo 完成一次“生成 Plan”并再次“完善 Plan”后：

- 两次操作都只读写 `.archcode/plans/<todo-id>.md`，目录中不产生该 Todo 的第二份 Plan 或旁路元数据；
- 第二次操作基于原内容编辑，不静默覆盖；
- 文件包含目标与背景、范围与非目标、实施步骤、依赖与顺序、验收标准、验证方法、风险与待确认项；
- 每条验收标准都描述可观察结果与判定方法，不使用“基本完成”“适当处理”“视情况”等无法判定的表述；
- 生成/完善 Plan 不改变 Todo 状态，也不自动启动 Session、Goal 或 Automation；
- 系统没有 Plan service/API/schema/status/version/link/watch/lock，也没有 Todo DTO 的 `planExists` 字段或 `.gitignore` 检查/修改逻辑；
- 内容是否满足七类信息与无模糊验收，由产物 Review 人工判定，不伪装成可穷举的字符串测试。

### AC-5：按钮与自然语言汇合到同一路径

浏览器验证必须证明：

- 所有可讨论的 Todo 都显示固定操作“Generate / Improve Plan”，前端不请求 Plan 存在性；
- 有 Discussion 时进入最近一次 Discussion，无 Discussion 时创建正式 `discussion` Session，且其首条接受消息就是 Plan 请求；
- 按钮确定性调用 `plan-work`，新建场景不产生与初始执行冲突的第二条命令；命令成功且 tool trace 显示写文件前调用 `skill_read({ name: "plan-work" })`，自然语言请求则以同一路径和同一内容契约的最终产物验收；
- Todo 原有四个状态、状态迁移和其他操作没有变化。

### AC-6：Start Work 与 Goal 保持正交

集成测试至少覆盖：

1. 无 Plan 的 Todo：`Start Work` 创建 Lead，正常执行，不自动创建 Goal；
2. 有 Plan、用户拒绝 Goal：Start Work 首条消息路由到 `/skill use execute-plan`，trace 显示 Lead 先读 Skill 和 Plan，在该次交接中询问一次，随后普通执行；
3. 有 Plan、用户同意 Goal：Start Work 首条消息路由到 `/skill use execute-plan`，trace 显示 Lead 先读 Skill 和 Plan，以其中目标和验收标准提出 Goal，并走现有 `create_goal`；
4. 没有 Todo/Plan 的普通 Lead：仍可按现有流程创建 Goal；
5. Discussion：不能创建 Goal，也不能被当作 Start Work Session。

所有路径都不得新增 Plan→Goal 外键、Goal schema 字段或隐式 Goal 创建。

### AC-7：Goal 验收与 Review 只有一套权威流程

- 有 Plan 的 Goal 和无 Plan 的 Goal 都由现有 `run-goal` 执行；
- Goal 完成前仍使用 fresh deep Analyst 的既有 Review gate；
- Goal completion mutation 继续校验当前 Goal instance/generation；Review 仍是 `run-goal` 管理的非持久化 Skill 协议，不新增 Review provenance、外键或实体；
- Goal 运行中，用户在当前 Lead 会话明确提出或告知 Plan 已修改时，Lead 提示当前 Goal 口径不会自动变化；未明确告知时系统不声称能够感知；系统不监听、不同步、不重启；
- 现有 Goal、Automation、HITL 和 Session recovery 测试无回归。

### AC-8：仓库级完成门槛

以下全部成功才算完成：

- focused tests（若硬切产生新的专用测试文件，将其加入同一命令）：

  ```sh
  bun test ./packages/agent-core/src/agents/factory.test.ts ./packages/agent-core/src/agents/configured-agent.test.ts
  bun test ./packages/agent-core/src/store/helpers.test.ts ./packages/agent-core/src/session-input/model-selection.test.ts
  bun test ./packages/agent-core/src/todos/service.test.ts ./packages/agent-core/src/tools/builtins/project-todo-update.test.ts
  bun test ./packages/agent-core/src/attachments/service.test.ts ./packages/agent-core/src/commands/skill.test.ts
  bun test ./packages/agent-core/src/__arch__/project-todo-boundaries.test.ts
  bun test ./packages/agent-core/src/lead-architecture-flows.integration.test.ts
  bun test ./apps/web/src/routes/project-todos.test.tsx
  ```

- `bun run typecheck`；
- `bun run test`；
- `bun run web:build`；
- Todo Plan 入口与 AC-5、AC-6 关键路径的浏览器验证；
- `rg` 审计确认 `ConfiguredAgent`、Runtime、SessionExecutionManager、Goal/Automation/Worktree 和工具授权中没有 `entry === "discussion"`、`isDiscussion`、Lead Discussion overlay、fallback 或 compatibility adapter；
- 活跃架构文档与实现一致；
- 独立 Reviewer 对架构边界、验收证据和过度设计风险给出无阻塞结论。

## 非目标

- 不改变 Todo 状态机、Start Work 按钮语义或 Todo 与 Automation 的既有关系。
- 不把 Todo、Plan、Goal 合并成一个实体。
- 不新增 Plan UI 页面、数据库、审批流、版本系统、文件监听或执行快照。
- 不重构通用 Tool Hook、Permission、Prompt Compiler 或 Tool Description 体系。
- 不承诺 Discussion 无法修改源码；Prompt/Skill 只表达产品行为要求。
- 不让 Discussion 加入 Ultra 执行拓扑。
- 不处理 `.archcode` 的 Git 跟踪策略。
- 不兼容旧 Lead Discussion Session，不增加迁移器或 fallback。

## 完成判定

只有 AC-1 至 AC-8 均有可复现证据，且独立 Review 无阻塞项时，本 Goal 才能判定完成。任何验收项若只能依靠“Agent 应该会这么做”而没有 Definition、schema、测试、文件结果或浏览器行为证据，均不得算通过。
