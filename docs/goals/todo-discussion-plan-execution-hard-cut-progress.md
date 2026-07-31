# Todo Discussion、Plan 与 Goal 交接实施进度

对应 Goal：
`docs/goals/todo-discussion-plan-execution-hard-cut-plan-goal.md`

## 当前状态

- 分支：`codex/todo-discussion-plan-goal`
- 状态：完成，待用户 Review
- 独立 Review：`sol(xhigh) APPROVED`

## 进度

### 2026-07-30

- 已完成 Plan Goal 的独立审查与修订，最终结论为 `APPROVED`。
- 已创建并切换到独立功能分支。
- 已确认实施边界：
  - Todo 状态机不变；
  - Plan 仍是 `.archcode/plans/<todo-id>.md` 普通文件；
  - Goal 仍是 root Lead 上可选协议；
  - Discussion 硬切为正式 Agent；
  - 不增加 Plan 服务、兼容层、迁移或通用 Tool Hook/Permission 重构。
- 正在核对 Agent、Session、Skill、Todo 与 Web 的现有实现边界。
- 已完成 Todo/Skill 交接：
  - Discussion 入口创建正式 `discussion` Session；
  - Start Work 只检查一次唯一 Plan 路径；
  - 有 Plan 时首条消息路由 `execute-plan`，无 Plan 时保持普通执行；
  - `project_todo_update` 改由 root Discussion 身份与 Todo 绑定授权；
  - `shape-todo`、`plan-work`、`execute-plan` 已更新/新增。
- 已完成 Todos 页面内的固定次级操作“Generate / Improve Plan”：
  - 不探测 Plan 状态；
  - 优先复用最近的 Discussion；否则创建 Discussion，并把 Plan 请求作为
    首条消息原子提交，避免普通 Discussion 执行与第二条命令竞争；
  - 已有 Discussion 发送 `/skill use plan-work`，随后进入对应 Session；
  - 未增加 Plan 页面、DTO 或 API。
- Todo/Skill focused 与架构测试：42/42 通过。
- Web focused tests：17/17 通过；Web typecheck 通过。
- 已完成正式 Discussion Agent 的核心身份硬切与跨模块集成：
  - 新增正式 `discussion` Definition、Role Contract 与 root identity policy；
  - 旧 `lead + discussion source` 数据严格拒绝，不兼容、不迁移；
  - Discussion 只可委派 Explore/Librarian，`mcpTools` 为空；
  - Goal、Automation、Worktree、Ultra 编排继续仅属于 Lead；
  - Discussion 的 `extraTools` 只能投影 Definition allowlist。
- 已同步 README、Concepts、Configuration、Multi-Agent Design、AGENTS 与
  Todos 页面设计规范。
- 仓库级验证：
  - focused tests：208/208 通过；
  - Agent Core unit：2793/2793 通过；
  - Agent Core integration：140/140 通过；
  - Agent Core architecture：79/79 通过；
  - `bun run typecheck`：通过；
  - `bun run test`：通过；
  - `bun run web:build`：通过；
  - `git diff --check`：通过。
- 早期 Mock API 浏览器操作不能证明真实 Session 命令时序，后续真实
  Runtime 复现出首次点击竞态：创建 Discussion 后其初始执行已为
  `running`，前端再补发 `/skill use plan-work` 会返回
  `SESSION_COMMAND_CONFLICT`。现已删除该两阶段调用。
- 使用当前代码的真实 Hono Server、Web UI、配置模型和隔离临时 Project
  完成端到端人工 QA：
  - 首次点击只创建一个正式 Discussion，其第一条接受消息就是
    `/skill use plan-work`，未出现 busy 或 `SESSION_COMMAND_CONFLICT`；
  - 模型实际执行 `skill_read → file_write → project_todo_update →
    file_read`，生成唯一 `.archcode/plans/<todo-id>.md` 后会话完成；
  - 第二次点击复用同一 Discussion，实际执行
    `skill_read → file_read → file_edit → file_read`，原地完善同一文件；
  - 最终仅一个 Discussion、一个 Plan 文件，Todo 保持 Idea，Goal 为空；
  - 浏览器从 Ready 向左拖动时，指针刚进入 Ideas 即完成跨列，不再等待
    整张卡片或卡片末端越界。
- 独立实现 Review 首轮指出验收证据不足，没有发现运行时身份、权限硬切、
  Plan 边界或 Start Work 分流的代码级阻塞。已补齐以下真实运行时集成流：
  - Discussion 依次执行 `skill_read → file_write` 生成唯一 Plan；
  - 再次执行 `skill_read → file_read → file_edit` 原地完善同一 Plan；
  - 有 Plan 的 Start Work 在用户拒绝 Goal 时执行
    `skill_read → file_read → ask_user`，随后保持普通 Lead；
  - 有 Plan 的 Start Work 在用户同意 Goal 时执行
    `skill_read → file_read → ask_user → create_goal`。
- 新增的 3 条全运行时集成验收及原有 2 条 Lead 流程合计 5/5 通过。
- 修正文档中把 Todo shaping 主体误写为 Lead 的表述，统一为 Discussion。
- 复审指出 Goal objective 不能用“交付 Plan”作为隐式引用；已将集成验收
  改为自足的结果契约，明确保存交付结果、测试零失败、Todo 仍是唯一工作项、
  不持久化 Plan 实体或 Plan→Goal 关联。该调整后的集成文件 5/5 通过。
- 独立 sol(xhigh) Reviewer 最终结论：`APPROVED`，无剩余 actionable
  findings。
- 用户 Review 后修复两类 UI 质量问题：
  - 将 Todo 固定操作统一为英文 `Generate / Improve Plan`，并同步设计规范、
    架构文档与验收记录；
  - 清理 Web 生产源码中另一处遗留中文输出操作，统一为 `View output` /
    `Hide output`；
  - Todo 拖拽碰撞检测改为鼠标/触摸指针优先；键盘拖拽没有指针坐标时才
    回退原几何算法。
- 窄列浏览器复验：工作区内四列宽度为 214px，从 Ready 手柄中心向左移动
  约 76px、指针进入 Ideas 后即成功跨列，不再要求整张卡片越过列边界；
  Todo 抽屉确认显示英文 `Generate / Improve Plan`。
- 真实用户 Todo 复现并修复 Plan 点击 500：其已有 Discussion 正悬停在
  `ask_user` 工具批次，Plan 命令触发 `SessionToolBatchActiveError`，但
  Server 未映射该并发冲突而落入 500。现为该错误补充稳定 code，并将
  运行中、停止中和工具批次未结束三类 Session-family 冲突统一映射为
  HTTP 409，作为同一 Session 并发写入的服务端兜底。
- 后续 Review 纠正了把该兜底错误上升为产品限制的问题：Plan 按钮不能因
  已有 Discussion 忙碌而禁用。现在空闲时复用最新 Discussion；运行中或
  HITL 悬停时创建新的 Plan Discussion，并以 Plan 请求作为首条原子消息。
- 隔离项目的真实 UI/API 场景矩阵补充覆盖：
  - Idea、Ready、In Progress、Done、Rejected 均可进入 Plan；
    Archived 仅允许 Restore，恢复后重新出现 Plan；
  - 首次生成、再次原地完善、忙碌时创建新 Plan Discussion、快速双击只
    创建一个目标 Discussion；
  - 无 Plan 的 Start Work 保持普通 Lead；有 Plan 时分别实测 Create Goal
    与 No Goal，后者的 Session `goal` 保持为空；
  - 过期 revision 与 Archived Session 创建均稳定返回 409；
  - 窄屏跨列、跨列回拖和同列重排均按指针所在列/位置落点。
- 人工 QA 额外发现 live HITL 通知会遮住 Session composer 的发送/停止
  操作，已将通知容器从右下角移到 header 下方右上角，并增加布局交互测试。
- 上述修复与全场景 QA 完成后重新执行仓库最终门禁：
  `bun run typecheck`、`bun run test`、`bun run build`、生产 Web 中文检索及
  `git diff --check` 均通过；隔离 QA Project、Sessions 与临时目录已清理，
  真实用户 Todo/HITL 数据未改动。

## 验收记录

- AC-1：Definition、Factory、Store schema、Profile、附件、模型选择、
  Goal/Automation/Worktree 测试通过。
- AC-2：生产代码检索确认 `entry === "discussion"` 只保留在 Todo 创建/
  首条消息、严格身份一致性与 UI 来源展示中。
- AC-3：Definition 精确工具矩阵、委派矩阵、MCP 空集及 extraTools
  fail-closed 测试通过。
- AC-4：全运行时集成测试实际生成并原地完善
  `.archcode/plans/<todo-id>.md`，trace 证明第二次先读后改；最终目录仅有
  这一份 Plan，Todo 状态与 revision 不变，产物包含七类信息和可判定验收。
- AC-5：浏览器点击链路与 Web coordinator tests 通过；全运行时产物测试
  证明 `/skill use plan-work` 后写文件前实际调用 `skill_read`，完善时再
  调用 `file_read`。
- AC-6：无 Plan 分流保持普通 Lead 且无 Goal；两条有 Plan 的全运行时集成
  流分别覆盖用户拒绝和同意 Goal，并验证实际 tool trace、Lead 身份及
  Goal 最终状态；未新增隐式 Goal 或 Plan 外键。
- AC-7：Goal schema、`run-goal` 与 fresh deep Analyst Review gate 未新增
  第二条流程；完整 Goal/Automation/HITL/recovery 测试通过。
- AC-8：补充验收测试后已重跑 `bun run typecheck`、`bun run test`、
  `bun run web:build` 与 `git diff --check`，全部通过；最后的 Goal
  objective 语义调整已再次通过 5/5 focused integration 与
  `git diff --check`；独立 sol(xhigh) Review 为 `APPROVED`。
