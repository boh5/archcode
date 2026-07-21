# Lead Agent Architecture Hard-Cut Plan Goal

本文件是 Lead Agent 架构重构的实施与验收契约。方向来源于 `docs/plan/lead-agent-architecture-draft.md`：只实施已经封板的结论，不再扩张产品概念。

## Goal

把 ArchCode 从“七个角色 Agent + 每 Agent 模型配置”彻底重构为：

> 单一 Lead 用户入口 + 有界浅层委派 + Profile 模型路由 + Skill 工作方法 + 可选 Goal 持久执行。

完成后只有 `lead`、`analyst`、`build`、`explore`、`librarian` 五个可运行 Agent。Visual 只保留未来占位，不进入配置、运行时、委派、Session 或 UI。

## Locked Decisions

- Lead 是唯一用户入口和最终技术责任人；简单工作由 Lead 直接完成。
- 委派层数保持现状：Lead -> Analyst/Build/Explore/Librarian（max depth 3），Analyst -> Explore/Librarian（max depth 2），Build -> Explore（max depth 2），Todo Discussion -> Explore/Librarian（max depth 2）；只有 Explore/Librarian 是终端节点。
- Analyst 通过 Skills 吸收架构分析、gap analysis、Plan review、普通 review 和 Goal final review；永久 Reviewer Agent 删除。
- Profile 只有 `principal`、`deep`、`fast`：root Lead 默认 `principal`，Analyst 固定 `deep`，Explore/Librarian 固定 `fast`，Build 由 Lead 选择 `deep|fast`。
- 多个 Build 可以同时执行；是否并行完全由 Lead 判断，不实现 owned scope、路径锁、lease 或单 Build 限制。
- Plan 只是 `.archcode/plans/*.md` 文件，没有 Plan service、状态、ID、API、页面或 Goal 关联。
- Goal 与 Plan 正交；Goal 必须获得用户明确授权，完成必须通过 fresh `deep` Analyst + `goal-review`。
- Project Todo 的“进入讨论”入口保留，以受限 Lead + `shape-todo` 替代 Shaper。
- 全量 hard cut：旧配置、旧 Agent ID、旧 Session schema 和旧委派字段直接失效；不迁移、不兼容、不保留 alias、fallback、双读或双写。

## Architecture Boundaries

```text
config/models       -> Profile 配置、解析与不可变 Execution binding
agents              -> 固定身份、工具权限、委派 target/depth 和稳定 Role contract
skills              -> orchestration / planning / analysis / review 工作方法
delegation          -> Agent + Profile + Skills 的严格直接子 Session 合同
execution           -> 唯一执行准入、并发、取消和终态所有者
session-goal        -> Goal 状态、用户授权与 final-review 机械门禁
todos               -> Discussion 绑定与 Todo 更新权威
protocol/server/web -> 严格 DTO、API 与可观察界面
```

| Agent | 稳定能力边界 | 明确禁止 |
|---|---|---|
| Lead | 源码读写与执行、用户沟通、委派、Plan、Goal、Automation、整合交付 | 把最终责任或 Goal 授权外包 |
| Analyst | 源码只读的深度分析与独立审查；保留 Git/LSP/Web/Memory 和 guarded Bash 验证能力；可委派 Explore/Librarian 补充事实 | 结构化源码修改、委派 Analyst/Build、控制 Goal |
| Build | 源码读写与执行、实现和验证；可委派 Explore 做本地检索 | 委派 Build/Analyst/Librarian、控制 Goal、自行扩大产品目标 |
| Explore | 本地只读搜索、AST/LSP/Git 证据 | 外部研究、修改、委派、决策 |
| Librarian | 本地只读与外部文档/参考研究 | 修改、委派、最终技术决策 |

- `SessionExecutionManager` 继续是唯一 live Execution 主链，不新增 Orchestration、Plan、Review 或 ULW workflow engine。
- AgentDefinition 只定义稳定权限；Profile 不改变权限；Skill 不授予工具。
- Discussion 权限由 Todo binding 这一运行时事实派生，不新增 Session mode/state。
- Goal review provenance 是 child Session 的执行来源证据，不演化为 Review 状态机。
- 本计划中的“ArchCode 已知成果写入”只指 review 创建后由 Lead/Build 成功完成的 `file_write|file_edit|ast_grep_replace`，以及其现有 Bash 分析已识别为 workspace 修改的命令；这些事实从现有 Execution/tool 记录读取，不新增 watcher、写入版本或 Review 状态。Analyst 的只读验证和研究子委派不属于成果写入。

## Implementation Plan

### Wave 1 — Contracts、Profile 与 Agent Catalog

1. 将配置硬切为严格 `profiles.{principal,deep,fast}`，删除 `agents.*`；旧配置必须明确失败。
2. 将模型解析从 Agent default 改为 Profile binding，并修复 Session override 跨 provider 泄漏 principal options 的问题。
3. 将 `AgentName`、协议、Store、API 和 UI catalog 硬切为五个运行时 Agent；`engineer` 改为 `lead`，新增 `analyst`，删除 `plan|reviewer|shaper`。
4. 旧 Session 文件不做转换；严格 schema 直接拒绝旧 Agent 身份或旧持久字段，并返回可诊断错误。

### Wave 2 — Agent 权限与 Skill 内聚

1. 重写 Lead、Analyst、Build、Explore、Librarian definitions/Role contracts。工具能力以现有角色映射为基线：Lead 继承 Engineer，Analyst 合并 Plan/Reviewer 的只读调查与验证能力，Build/Explore/Librarian 保持现有能力，Discussion overlay 继承 Shaper 的调查能力；只删除本计划明确点名的旧角色、旧 scope/lease 和越权能力。保留现有 delegation core tools 和深度模型，只有 Lead 保留 family cancel 权限。
2. 固定 target/depth：Lead 最大深度 3并可委派 Analyst/Build/Explore/Librarian；Analyst 最大深度 2并可委派 Explore/Librarian；Build 最大深度 2并可委派 Explore；Explore/Librarian 无 targets。
3. 把工作流从 Role Prompt 移到高内聚 Skills。生命周期核心固定为 `orchestrate-work`、`plan-work`、`run-goal`、`shape-todo`、`review-work`、`goal-review`；本地/外部研究、架构分析、复杂调试、gap analysis、Plan/代码/安全审查能力必须保留，但可以通过保留、重写、合并或新增 Skills 实现，不按能力标签锁死文件数量，也不要求删除 `codemap` 等现有领域 Skill。
4. 每次 Execution 从权威事实派生 lifecycle Skill：普通 root Lead 使用 `orchestrate-work`，active Goal 使用 `run-goal`，Todo Discussion 使用 `shape-todo`；不持久化 mode 或 workflow phase。

### Wave 3 — Delegation 与并行模型

1. `delegate` 严格收敛为 `{ agent_type, profile, title, objective, skills, background }`，其中 `agent_type` 只允许 `analyst|build|explore|librarian`；删除 `owned_scope`、`ScopeRef`、scope validation 和 Build ownership lease 全链路。
2. Lead 显式选择 child Profile；child Session 持久化该选择，`resume_session` 保持 Agent、Profile、Skills 与责任不变。
3. 运行时允许多个 Build 使用通用并发额度同时执行，不加入路径推断或专用冲突状态。
4. 委派准入在 child 创建前校验调用 Agent 对应的 target matrix、Profile、Skill 是否存在、直接父子关系和最大深度。普通 builtin 或用户自定义 Skill 不能扩张 Agent 工具权限；运行时保留的 lifecycle Skill 只能由正确身份/上下文注入，同名自定义 Skill 不能冒充。

### Wave 4 — Plan 文件与 Todo Discussion

1. 不创建 Plan 领域模块；Lead 通过 `plan-work` 和普通 file tools 创建/更新 `.archcode/plans/<safe-name>.md`。只要求文件是该目录的安全直接子级、以 `.md` 结尾且不可路径逃逸，不规定 slug 正则。
2. 在 `.archcode` 保护规则中只开放一个窄例外：非 Discussion 的 root Lead 可用 `file_write|file_edit` 写直接位于 `.archcode/plans/` 下的 Markdown；其他 `.archcode` 路径、Bash/AST 写入和所有 child 写入继续拒绝。
3. Discussion 继续由现有 `discussionSessionId` 绑定，但 root Agent 改为 Lead，并自动派生 `shape-todo`。
4. Discussion Lead 保留原 Shaper 的读取/搜索、Git、LSP、Web、Memory、`ask_user`、guarded Bash、更新 bound Todo，以及在 max depth 2 内委派 Explore/Librarian 的调查能力；结构化源码写入、Analyst/Build 委派、Goal、Automation 和工作资源创建必须在运行时拒绝。已知的修改性 Bash 继续由现有权限策略拒绝或询问，不新增只读 Shell 状态机。
5. Todo Ready 后仍创建一个新的普通 Lead Session，不复用 Discussion Session。

### Wave 5 — Goal 授权与 Analyst Final Review

1. 将 `create_goal` 硬切为严格 `{ objective }` 输入。用户直接明确要求持续执行时，objective 必须精确匹配完整 fresh user input；旧空输入不兼容。
2. 增加 Lead 建议路径：`ask_user` 使用一个问题，将完整 objective 作为正文，并设置 `preset: "goal_authorization"`、`custom: false` 且不传 `options`；Runtime 生成固定的“开启 Goal / 不启动 / 调整目标”动作，模型不能通过调换显示文案伪造授权。`create_goal({ objective })` 只核对当前 Session、当前 Execution 中这次被暂停并恢复的 `ask_user` 正文与 objective 精确一致，且返回答案等于 Runtime 拥有的开启动作。复用现有 question/HITL 记录，不新增 GoalProposal、授权 token、授权状态或跨 Execution 消费协议；没有当前有效确认时重新询问。
3. Discussion Session、既无合法 fresh direct request 又无当前有效 `ask_user` 确认、目标不匹配或已有未完成 Goal 时，`create_goal` 确定性拒绝。
4. 保留现有 Goal continuation：active 且 runnable 的 Goal family 在 child 完成、HITL 恢复或进程重启后继续驱动同一个 root Lead，直到 complete、真实 blocked、paused 或 budget-limited；不新增 Goal workflow engine。
5. 删除 Reviewer 完成门禁，改为 direct child Analyst；当 active Goal 委派 `analyst + deep + [goal-review]` 时，运行时自动绑定当前 Goal instance/generation，模型不能提供或伪造该绑定。
6. `update_goal(complete)` 只接受在最后一次 ArchCode 已知成果写入之后创建并绑定当前 Goal instance/generation 的 fresh review Analyst；其 completed 输出首个非空行必须严格为 `VERDICT: APPROVED`。只有尚无 completed 审查输出、最新 Execution 因中断或重启未完成时可以 resume；任一 completed 的 `CHANGES_REQUESTED`、空输出或格式错误、后续 ArchCode 已知成果写入、Goal generation 变化、active Build/child 或来源不匹配都会终结本轮审查并要求新建 Analyst。review Analyst 的只读 Explore/Librarian 委派不使审查失效。
7. 不新增 reviewGeneration、Review state、filesystem watcher、Plan link 或自动 remediation；Lead 通过 `review-work` / `run-goal` 驱动 fix -> fresh review。第一阶段的“成果未再修改”只覆盖 ArchCode 运行时已知写入，不声称检测外部编辑器或其他进程的文件修改。

### Wave 6 — Surfaces、删除旧链与整体收口

1. 更新 Protocol、Server、Web、Prompt snapshots、Agent descriptors、Config editor、Session/child 展示和 Todo 文案，使用户只看到新架构。
2. 子 Session 在 UI/API 中可观察 Agent、Profile、Skills、父子关系、状态、结果和 HITL 来源；普通输入、纠正、停止始终进入 Lead，不增加 Primary Agent selector。
3. Visual 仅保留本计划与架构文档中的未来说明；生产代码不得注册 Visual Agent/Profile/route/UI fallback。
4. 删除旧 definitions、scope/lease、Reviewer/Shaper/Plan 专用分支和所有旧语义测试；更新根 `AGENTS.md`，不保留 legacy 目录、export、schema 或兼容错误恢复。

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部满足；任何一项缺少自动化证据或真实流程证据都算 `NOT_DONE`。

### AC-01 — Agent 与配置完成硬切

- 运行时 Agent catalog 精确等于 `lead|analyst|build|explore|librarian`；Visual 不在 catalog。
- 新配置只接受必填 `principal|deep|fast` Profiles；缺失项、未知 Profile、旧 `agents` 配置均 strict failure。
- 新 Session 创建为 Lead；旧 `engineer|plan|reviewer|shaper` 身份或仍含旧 owned-scope 字段的 Session 文件被明确拒绝，未被转换或静默加载。
- 生产代码不存在旧 Agent definition、alias、fallback selection 或双轨 DTO。

### AC-02 — Profile 解析唯一且不泄漏

- 普通、Discussion、Automation 和 Goal continuation root Lead 默认使用 `principal`；Session override 整体替换该绑定。
- 跨 provider override 的最终 options 只来自被选模型、variant 和合法 override，不含 principal Profile options。
- Analyst 只能 `deep`，Explore/Librarian 只能 `fast`，Build 只接受 `deep|fast`；非法组合在 child 创建前拒绝。
- child 的 Profile 写入持久 Session/Execution 摘要；resume 后保持不变。
- 用户可在 Session UI/API 为 root Lead 选择其他已配置模型、variant 和 options；该 override 整体替换 principal binding，清除后恢复 principal。

### AC-03 — 委派有界分层、严格且无 scope 系统

- `delegate` 只接受 Wave 3 的六个字段，任一旧 `owned_scope` 输入被 strict schema 拒绝。
- target/depth 精确成立：普通 Lead -> Analyst/Build/Explore/Librarian（max depth 3），Analyst -> Explore/Librarian（max depth 2），Build -> Explore（max depth 2），Discussion Lead -> Explore/Librarian（max depth 2）；Explore/Librarian 不能委派。
- Analyst/Build/Discussion 的 delegation core tools 仅能操作自己的 direct children；family cancel 仍只有 Lead 拥有，跨 root resume/cancel 必须拒绝。
- 合法的两个并行 Build 能同时进入 running；不存在 Build lease、路径 overlap admission 或单 active Build guard。
- 非法 target/Profile、不存在的 Skill、冒充保留 lifecycle Skill、越深 child 和跨 root resume 全部在产生副作用前拒绝；合法用户自定义 Skill、Analyst -> Explore/Librarian、Build -> Explore 和 Discussion -> Explore/Librarian 均有成功测试。
- 生产源码不存在 `ScopeRef`、`ownedScope`、`BuildOwnershipLease` 或等价兼容实现。

### AC-04 — Role/Skill/Plan 边界成立

- Role Prompt 只包含稳定身份、责任、工具边界、禁止项和输出合同；orchestration/planning/review 方法来自相应 Skill。
- core workflow Skills 包含 Wave 2 固定的六个核心职责；研究、分析和审查能力有行为证据，但不以精确 Skill 文件数量、名称或删除 `codemap` 作为验收条件。
- 工具权限矩阵证明 Lead 继承 Engineer、Analyst 覆盖 Plan/Reviewer、Build/Explore/Librarian 保持现有能力、Discussion 保持 Shaper 调查能力；除本计划明确列出的删除项外不存在静默减配。
- 普通 Lead、active Goal、Todo Discussion 的有效 lifecycle Skill 分别由现有 Session/Goal/Todo 事实派生，没有 mode/phase 状态字段。
- Skill 增删不能改变任何 Agent 工具集合，architecture test 对每个 Agent 的权限矩阵做精确断言。
- 普通 `review-work` 默认使用一个 Analyst，并允许其组合多个相关审查 Skills；只有独立性或风险确有需要时才增加 Analyst，普通复审可由 Lead 选择 resume 或 fresh Session，不产生 Review 状态。
- 非 Discussion root Lead 可用结构化 file tools 创建和编辑 `.archcode/plans/` 下安全的直接子级 `.md` 文件；Build/Analyst/Explore/Librarian、Discussion Lead、Bash/AST 和其他 `.archcode` 路径全部拒绝，不存在额外 slug 正则。
- Protocol、Store、API 和 Goal 中不存在 planId、planPath、Plan status 或 Plan registry。

### AC-05 — Todo Discussion 入口和限制完整保留

- Web 的“进入讨论”能创建或恢复 bound root Lead Session，并展示为 Discussion，而不是普通执行 Session。
- Discussion 可读取/搜索/询问并用 `project_todo_update` 更新当前绑定 Todo；不能通过输入参数选择其他 Todo。
- Discussion 保留原 Shaper 的读取/搜索、Git、LSP、Web、Memory、`ask_user`、guarded Bash，以及 Explore/Librarian 委派和 direct-child resume；结构化 source write、Analyst/Build 委派、create/update Goal、Automation/工作资源创建在工具投影与执行入口拒绝，已知修改性 Bash 继续走现有权限策略。
- Todo 标记 Ready 后创建全新的普通 Lead Session；该 Session 具有普通 Lead 能力且不继承 Discussion 限制。

### AC-06 — Goal 授权不可伪造，且不依赖 Plan

- `create_goal` 只接受严格 `{ objective }`；直接明确的用户持久执行请求能以完整原文创建 Goal，旧空输入、普通请求、模型自拟 objective 或过期 fresh input 不能创建。
- Lead 建议 Goal 时，`ask_user` 的单个问题正文是完整 objective，三个选项依次表达开启、不启动、调整且禁止 custom；label 可本地化。`create_goal.objective` 只接受当前 Session、当前 resumed Execution 中对应正文完全一致且答案等于该调用第一个选项 label 的结果。其他答案、objective 不一致、其他 Session/Execution 或历史回答均拒绝；HITL 自身负责中断和重启恢复，不新增可消费授权对象。
- Discussion Lead 永远不能创建 Goal。
- 有/无 Plan 均能创建并运行 Goal；Plan 文件不会自动创建 Goal，Goal schema 不保存 Plan 引用。
- active runnable Goal 在 child 完成、HITL 回答和进程重启后继续同一个 root Lead；paused、budget-limited、complete 和真实 blocked 不被错误续跑。

### AC-07 — Goal final review 新鲜且无法绕过

- 只有当前 root Lead 的 direct `analyst + deep + [goal-review]` child 可作为完成凭证；普通 Analyst、旧 Reviewer、其他 Profile/Skill、间接 child、其他 root 和伪造 Goal binding 均拒绝。
- review Analyst 尚无 completed 输出且最新 Execution 未完成时，可以因中断或重启 resume；一旦产生 completed 输出，本次审查尝试即终结。空输出、格式错误和 `CHANGES_REQUESTED` 均不能完成 Goal，也不能 resume 后改写为批准。
- 首个非空行严格为 `VERDICT: APPROVED`，Goal generation 未变化，review 创建后没有 ArchCode 已知成果写入，且 family 无 active Build/child 时，同一次 `update_goal` 才能完成 Goal；review Analyst 委派并完成只读 Explore/Librarian 合法，不会使审查失效。
- 任一 ArchCode 已知成果写入、Goal 编辑或非批准 completed review 后都必须创建新的 Analyst Session；不使用 filesystem watcher，也不把外部文件修改宣称为已覆盖证据。
- Goal/Session 中不存在 Reviewer receipt、Review state、reviewGeneration、Plan link 或自动 remediation 状态。

### AC-08 — 用户面、硬切审计与全仓验证

- Config UI 只编辑 Profiles；root Lead Session 可选择并清除模型 override；Session/UI 只显示新 Agent 名称，child Profile/Skills/状态/HITL 来源可检查；不存在 Primary Agent 切换和 Visual 假入口。
- 自动化集成覆盖三条真实流程：普通 Lead -> 多 child 协作；Todo Discussion -> Ready -> 新 Lead；ask_user 授权 Goal -> Build -> `CHANGES_REQUESTED` -> fix -> fresh `APPROVED` -> complete。
- 真实浏览器验收至少覆盖 Profile 配置保存、root Lead 模型 override 选择/清除、Todo“进入讨论”、Ready 后进入新 Lead，以及 Session 中 child Agent/Profile/Skills/状态可见；刷新后结果一致且 console 无新增错误。
- 对生产源码的固定搜索确认旧 Agent ID、per-Agent config、owned-scope/lease、Reviewer/Shaper/Plan runtime 和 Visual registration 为零；测试只可为 strict rejection 引用旧输入，历史文档不计。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- fresh 独立 Analyst 按 AC-01 至 AC-08 复核最终实现，结论为 `VERDICT: APPROVED` 且无未关闭 finding。

## Non-goals

- 不实现 Visual、多模态附件、浏览器视觉 QA 或 Visual fallback。
- 不新增 ULW 命令、Plan/Review/Workflow 状态机、Agent marketplace、开放式递归团队或自动 worktree；固定浅层再委派不属于非目标。
- 不迁移旧配置/Session，不保留旧字段、旧名称、兼容 parser、feature flag 或双轨 UI。
- 不把 task scope、Plan 进度或 review 结果复制成新的持久领域对象。

## Completion Rule

只有 AC-01 至 AC-08 全部有可复查证据、全仓验证通过、旧路径删除且 fresh Analyst 最终批准，才能将本 Goal 判定为完成。实现过程中的进度和证据写入独立 progress 文档，不回写本计划的验收定义。
