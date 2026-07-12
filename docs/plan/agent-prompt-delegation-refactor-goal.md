# Agent Prompt Delegation Refactor Goal

## Goal Create Input

`useWorktree: true`

## Objective

只重构 ArchCode 七个 Agent 的模型可见 prompt 内容，使它们准确识别当前用户意图，并以“理解 → 调研 → 实现 → 验证 → 完成”的证据闭环工作。采用 OMO 风格的积极委派：只有严格定义的简单任务直接处理；Engineer 或 Goal Lead 对每个新的非简单工作 scope 负责通过一次充分的根调研门，并把综合后的证据传给下游；Plan、Build、Reviewer 必须复用充分的上游证据，只对会改变结论的具体缺口继续委派 Explore 或 Librarian；实现阶段仅由有 Build 委派能力的 Engineer 或 Goal Lead 将无文件冲突、无接口冲突、无先后依赖的工作单元并发委派；父 Agent 始终负责综合、验证和最终结论。本 Goal 只能修改 prompt 文案、prompt 拼装及其确定性测试，以及本次新建的 Goal/Progress 文档；不得修改既有历史文档或任何 runtime、状态机、工具执行、权限、并发、hooks、schema、API、持久化及其他产品功能。

## Acceptance Criteria

以下 AC-01 至 AC-12 是锁定验收条件。全部满足且独立 Reviewer 逐项给出证据后才能 `DONE`；任一条件缺失、互相冲突、只有口头声明或没有代码/测试/文档证据，必须 `NOT_DONE`。

### AC-01：当前轮意图门

每轮依据当前用户消息和必要的直接对话上下文识别 `answer/report/review`、`diagnose`、`change/build/fix`、`monitor/wait`。前两类只读，不自动修改；第三类实现并验证；第四类保持活动直到用户给定终止条件。用户仅补充上下文、确认既有方案或说“继续”时，必须结合上一轮已确认意图，不能机械要求出现特定动词。Engineer 完整 prompt 测试必须证明这些规则同时存在且无相反规则。

### AC-02：简单任务有唯一边界

只有同时满足以下六项才可直做：单一局部交付；目标文件/符号/命令已知或最多一次本地搜索可定位；只涉及一个模块且不改变公共协议、schema、状态机、生命周期或跨模块架构；不依赖外部库行为、竞品、时效资料、官方文档或远程源码；没有两个可独立并行的调研或实现单元；一次针对性检查或命令即可验证。任一项不满足即为非简单任务，不能因模型自认为熟悉而降级。表驱动 structural policy examples 必须记录代表场景、必需 prompt clauses 和 guard clauses，至少覆盖：已知文件单行修改直做；跨 workspace 先调研；外部 API 任务先 Explore+Librarian；两个独立实现单元进入并发委派。该确定性测试只证明完整 prompt 发出了对应规则，不得声称仅凭字符串断言验证了模型实际路由行为。

### AC-03：非简单任务先过调研委派门

Engineer 或 Goal Lead 对每个新的非简单工作 scope 在实质结论或第一次依赖性源码修改前通过一次根调研门：没有同一 scope 的当前、直接、覆盖完整且已验证证据时，启动 2–4 个不重复的后台调研委派；至少一个 Explore；只要决策依赖外部库/API、当前版本、官方文档、竞品、远程源码或 issue/PR 历史，至少一个 Librarian。完全由本地代码决定时可全部使用不同角度的 Explore。独立调研应尽早启动，不得等待一个完成后才启动下一个；父 Agent 可继续不重复且不依赖结果的只读工作，但依赖调研结论的修改必须等待结果收集和综合。综合后的证据必须通过委派 envelope 向下游复用；Plan、Build、Reviewer 仅在发现会改变结论的具体证据缺口时继续委派最小必要调研，不得为了仪式重复同一搜索。完整 prompt 测试必须证明根协调者的调研门、下游证据复用、纯本地任务不机械调用 Librarian、外部事实任务不能跳过 Librarian。

### AC-04：调研可行动且可停止

每个调研委派必须写明独立搜索角度、要解锁的下游决策、搜索范围、排除范围和证据格式。Explore 支持 `quick | medium | thorough`：quick 做少量定位；medium 覆盖定义、主要调用方和测试；thorough 覆盖跨模块调用链、配置、测试、历史和反例。Explore 输出事实、绝对路径及行号/符号、未知项和覆盖范围。Librarian 按概念/实现/历史/综合研究分类，优先官方资料和固定 commit permalink，输出版本或日期、来源等级、冲突及未确定项。满足任一条件即停止搜索：已有直接证据支持下一步；来源开始重复；连续两轮无新增有效信息；剩余未知不会改变实现或结论。

### AC-05：实现按独立性并发

调研后将工作拆为原子单元。仅 Engineer 或 Goal Lead 负责实现编排：两个或以上文件 ownership 不重叠、无公共接口冲突、无先后依赖的单元默认并发委派给 Build；会修改同一文件、同一公共接口或有依赖关系时必须顺序执行。Plan 与 Reviewer 只能返回 ownership/dependency 建议，Build 只能把额外本地证据缺口委派给 Explore；这些角色的完整 prompt 不得要求启动实现 child。Build 委派必须声明文件或模块 ownership，并禁止回滚、覆盖用户或其他 Agent 的修改。Engineer 可直接实现无法合理拆分的核心工作；Goal Lead 始终只协调、不直接修改源码。structural policy examples 必须包含一个可并发场景和一个共享接口、必须串行的场景，并断言 Engineer/Goal Lead 完整 prompt 中存在相应规则和禁止项。

### AC-06：委派输入完整且复用 child

所有可委派父角色的 prompt 或 `delegate` 描述必须要求六项输入：原子 `Task`；带成功标准的 `Expected outcome`；`Context and evidence`；`Scope ownership and non-goals`；`Must do / must not do`；`Verification and output`。探索委派至少包含 Task、Expected outcome、Context、Scope、Evidence。失败修复、追问和验证反馈优先使用原 `session_id` resume，不无故新建 child。persona、skills、context 和 metadata 不得被描述为可以改变硬编码工具权限。

### AC-07：父 Agent 验收 child

child 自报完成不构成证据。父 Agent 必须检查实际交付物、scope、约束、diff、诊断和测试结果，发现失败时将具体证据反馈给原 child 并要求修复，之后重新验证。最终结论必须综合所有 child 结果并处理冲突；仍在运行且会影响结论的 child 未完成时不得宣称完成。完整 prompt 测试必须包含上述父级责任和禁止项。

### AC-08：Engineer 与 Build 端到端闭环

公共或角色 prompt 明确循环：检查证据 → 选择最小有效行动 → 执行 → 验证 → 根据结果调整，直到用户结果完成或遇到必须新增用户授权的真实 blocker。Bug fix 优先建立失败基线并修根因，不顺手重构或修无关失败。TDD 使用务实规则：Bug、状态机、协议、核心逻辑优先测试先行；文档、简单配置、机械重构可先修改再验证，不得为了形式制造低价值失败测试。完成前检查最终 diff，先跑最窄相关验证，再按风险扩展；跳过验证必须有无法自行消除的具体 blocker。

### AC-09：Plan、Reviewer、Explore、Librarian 可直接消费

Plan 只给一个推荐方案，包含 evidence、scope/non-goals、ordered file-level steps、verification、risks、Build/Reviewer handoff。Reviewer 对声明保持怀疑但对 verdict 中立；Goal review 逐条输出 acceptance criterion → evidence → pass/fail，任一必需条件无证据即 `NOT_DONE`；普通 Review 不调用 Goal finalization，按严重度输出可行动 findings，纯风格偏好不能单独阻塞 Goal。Explore 和 Librarian 保持 terminal read-only，输出遵守 AC-04。

### AC-10：Goal Lead 只改静态 prompt

Goal Lead role prompt 必须保留当前 Goal authority、`goal_manage` 合法动作、Reviewer finalization、`reviewGeneration`、block/resume/retry 和 continuation 恢复语义，只优化模型可见的组织方式，并加入“读取已注入的 durable Goal snapshot → 找当前瓶颈 → 委派 → 综合证据 → review/block/retry”协调循环。本 Goal 不得修改 `packages/agent-core/src/goals/`、Goal 状态、transition、continuation、reminder、review receipt 或任何运行时注入逻辑。现有 Goal lifecycle 与 continuation 测试必须原样通过；允许更新的测试只能验证新的静态 prompt 内容，不能改变运行时期望。

### AC-11：Prompt 组成和测试完成

重写公共 Guidelines，加入意图、证据、执行循环、范围、错误和终止契约；面向模型的 identity 不再输出 `using the X prompt profile`；Librarian 标题改为 `## Role: Librarian`；Explore 设置 `includeMemoryInPrompt: false`，其他 Agent Memory 行为不变。所有七 Agent 必须有完整 system prompt 合约测试，按 intent、delegation gate、role boundary、execution loop、verification、stop condition 组织；删除只锁定旧措辞且不能证明有效结构的断言，同时保留工具权限、delegate targets 和 Goal authority 硬边界测试。禁止项测试至少证明：只读角色无源码修改授权；Goal Lead 不直接实现；Reviewer 不信 child 自报完成；简单任务不强制委派；根协调者的非简单新 scope 不能跳过调研门；Plan、Build、Reviewer 不重复充分的上游调研且不收到实现 child 指令。确定性单元测试只验证模型可见 prompt 的组成、必需规则、禁止规则和角色能力匹配；模型是否遵循路由属于单独的 prompt eval，不得由字符串包含测试虚假宣称。

### AC-12：严格 prompt-only 范围和最终验证

生产代码只允许修改以下模型可见内容：`packages/agent-core/src/prompt/**` 内的 prompt builder/section 文案；`packages/agent-core/src/agents/definitions/*.ts` 内的 `rolePrompt`、`promptProfileId` 相关模型文案和 `includeMemoryInPrompt`；`packages/agent-core/src/tools/builtins/delegate.ts` 内的 tool `description`、schema `.describe(...)` 文案和 child prompt 文本模板。允许同步修改上述内容的 colocated tests。不得修改既有历史文档，也不得修改这些文件中的执行分支、输入输出 schema 结构、tool traits 或副作用逻辑。

除上述 allowlist 外不得修改任何生产代码，尤其不得修改 `packages/agent-core/src/goals/**`、`packages/agent-core/src/agents/query/**`、delegation/session execution、store、tools execution、permissions、hooks、config、protocol、server、web、API、持久化和并发实现。不得新增、删除或重命名 Agent；不得新增原语或配置项；不得改变工具列表、工具权限、delegate targets、最大深度、最大并发、Reviewer authority、Goal lifecycle 或现有行为。提示词可以要求 Agent 积极委派，但不得通过本 Goal 修改 delegate runtime 来强制执行。

以下命令全部退出码为 0：`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check`。最终 `git diff --name-only` 中除本 Goal 文件和用户明确要求的 `docs/plan/agent-prompt-delegation-refactor-progress.md` 外，只能出现上述 prompt/test allowlist 文件；任何既有历史文档或功能逻辑变化均为 `NOT_DONE`。Reviewer 必须逐个 diff hunk 确认生产代码变更仅影响模型可见 prompt。字面审计确认活动 prompt 不存在 `## Goal Role: Librarian`、空洞 profile identity、与当前轮意图门冲突的自动实现规则、或声称 persona 可改变工具权限的文案。Reviewer 最终 receipt 必须逐项列出 AC-01 至 AC-12 的证据位置，不能用整体测试通过替代逐项验收。
