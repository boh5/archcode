# ArchCode 最近工作问题综合修复 Plan Goal

> 本文覆盖 2026-09-03 对 ArchCode 最近 Todo、Session、Plan 和实际运行记录的综合审计，以及 PR review 暴露的同一状态投影容量缺口。它取代此前只覆盖 Compression 与 Skill tools 的窄范围版本。实施完成不能以“代码已改”或“基本可用”判定；AC-01 至 AC-11 必须逐项提供决定性证据。

## Goal

在不限制用户 Provider、Model、Profile 配置的前提下，修复最近工作暴露出的 Runtime 可靠性、Plan 生成、上下文压缩、Session/HITL 交互和 Todo 导航展示问题，使一次 Todo Work 能够可靠执行、及时停止确定性错误循环、产生可信子 Agent 结果，并让用户能够看见和恢复正在进行的工作。

## Complete Issue Register

| ID | 优先级 | 已确认问题 | 完成后的可观察结果 |
| --- | --- | --- | --- |
| I-01 | P0 | 同一 Execution 创建 Goal 后，Active Skill 仍停留在 `orchestrate-work`，没有切换到 `run-goal` | 紧邻的下一 model boundary 自动切换生命周期 Skill |
| I-02 | P0 | `skill_read` / `skill_list` 的模型可见说明和错误 hint 不足，模型反复构造 `/`、`:first`、`invalid`、`PLACEHOLDER` 等参数 | 首次调用与错误恢复都要求从实际成功结果复制字段，并提供不依赖某个固定 Skill 的调用顺序示例；严格校验仍保留 |
| I-03 | P0 | 现有 DoomTracker 只拒绝第三个连续相同调用，交错错误可重复几十轮且 Execution 继续 | 同一规范化调用第三次得到同一确定性错误后，当前 Execution 失败并停止 |
| I-04 | P0 | 最近 11 个 Completed 子 Agent 中有 4 个无 final answer，另有至少 4 个只输出 Tool/DSML 协议残片 | 没有可信最终报告的子 Agent 不得显示 Completed，父 Agent 收到明确失败 |
| I-05 | P1 | 一个 Plan 在单模型步骤中生成约 4 分 12 秒、输出 13,616 tokens 并一次写入约 30KB，过程是黑盒 | 用 `plan-work` Prompt/模板约束短而完整的 Plan，不引入分布式生成框架 |
| I-06 | P1 | Dynamic Compression 被全局 Todo、Reminder 和 settled child link 阻塞，最终只能越过 85% 后由 Hard Compact 兜底 | 已结算历史可在 85% 前形成 dynamic compression block，当前状态仍可恢复 |
| I-07 | P1 | HITL 暂停时模型说明藏在默认折叠 Work 内，Question/Permission 决策单占据大量空间且整卡不可折叠；已回答但投递失败的 `requiresInspection` 又被误当成 Pending，重新锁住 Composer | 暂停 Work 默认可读，Work 与决策单可以独立折叠；Inspection 明确展示但不再索要用户输入，手动折叠在当前路由生命周期内保持 |
| I-08 | P2 | 左侧没有 Running Todo 入口，仍处于 Idea 的 Discussion 正在运行时难以返回；Running 行的屏幕阅读文本会泄漏更旧 Session 的 `Failed` 状态 | 导航显示由真实 Session 活动推导的 Running Todo，点击回到确定的运行 Session；视觉与无障碍状态统一为 `Working` |
| I-09 | P2 | Todo display lead 与塑形模板冲突，列表出现重复的 `Outcome`、以 localhost URL 为标题，或错误剥掉合法标题 `C#` 中的井号 | display lead 来自具体内容，新模板强制具体标题；结构标题、独立 URL 和合法 ATX closing hashes 被准确区分 |
| I-10 | P1 | Current Context 每个 model boundary 注入完整 Session Todos 和最新 direct children，但 `todo_write`、child handoff 与历史直接子 Session 数量没有写入上限，DCP/Hard Compact 均无法回收这部分 | 在 Tool schema、Store/Persistence 和 child admission 设置固定 UTF-8/count 上限；越界拒绝且不落盘，Prompt 不截断，已有 child 的 resume 不占新名额 |

以下两项作为横切约束处理，不另建产品子系统：

- **成本失控：** 七个根 Session 累计约 2,120 万 tokens、475 次 Tool call、109 次失败。它是 I-01 至 I-06 的综合后果；完成证据必须证明错误循环、假完成、超长 Plan 和压缩失效各自被关闭，不新增成本计费服务。
- **checkout 隔离风险：** 审计时 UI Work 位于包含无关营销 Skill 工作的分支。本文实施必须从明确基线进入独立 worktree，不能把该风险误写成已确认的产品默认策略变更。

Cloud Coding Agent 是独立的产品 Idea，不属于本次缺陷修复。

## Verified Baseline

### Runtime 与 Skill

- Session `9c4f5418-92e8-4521-891f-e4259d258c65` 中 `create_goal` 成功，但 27 个 Prompt Trace 始终是 `orchestrate-work + execute-plan`，没有 `run-goal`；65 次 Tool call 中 59 次失败，累计约 111.7 万 tokens，最终由用户取消。
- 该 Session 出现 16 次 `skill_read({"name":"run-goal","resource":"/"})`，以及多组携带 `/`、`first`、`new`、`PLACEHOLDER` 的 `skill_list`。
- `ConfiguredAgent` 当前在 Execution 启动时只计算一次 Active Skills；`DoomTracker` 只比较紧邻上一条调用，且命中后只结算单个 Tool error，不终止 Execution。
- 最近 Completed 子 Agent 的持久化记录真实存在 `<NO_FINAL>` 和只含 `<invoke>` / DSML Tool 协议片段的最终文本；当前 child terminal settlement 没有建立“Completed 必须有可信报告”的门禁。

### Plan 与 Compression

- `.archcode/plans/c8fd3231-8414-4492-b704-fb91a8393e10.md` 的生成瓶颈是模型一次构造巨大写入参数，不是磁盘写入；用户已决定只用 Prompt/Skill 约束解决，不引入多人并行写 Plan。
- Session `5cb937fe-4c5a-45f9-94d5-31d22f99a4c4` 的 dynamic compression 确实被调用：一个范围因 settled child links 和 active Todos 被拒绝，另一个不含 child link 的范围仍因全局 Todos 和未消费 Reminder 被拒绝。
- `collectProtectedRefsForRange()` 当前把所有 active Todos 和未消费 Reminders 伪锚定到任意 `range.startRef`；child relationship 已另存于 `childSessionLinks`，历史 delegate Tool 消息不是其 authority。
- Canonical transcript 与 Dynamic Compression 的 model projection 本来就是分离的；85% Hard Compact 是最后安全边界，不应承担常规压缩职责。

### UI 与 Todo

- `ExecutionWorkstream` 只有 `running` 默认展开；HITL `suspended` 在刷新或重进时不会默认展开。Tool 前 commentary 留在 Work 内，只有 `final_answer` 在 Work 外显示。
- `SessionComposerDock` 在 pending HITL 时最多占 `min(78dvh, 640px)`；`HitlCard` 只有 operation details/note 局部折叠，没有 Question/Permission 整卡 disclosure。
- 已回答但响应投递失败的 HITL 进入 `requiresInspection` 后仍沿用 pending disclosure/锁定路径；用户即使手动收起，后续 render 也会重新展开。
- `ProjectTodoNavigator` 只有 Needs you 与 lifecycle 分组；`In progress` 是 Todo lifecycle，不是实时 Running。
- Running 行的无障碍文案直接消费 Todo 关联历史中的 `operationalState`，可能在视觉上运行时朗读旧的 `Failed`。
- `projectTodoDisplayLead()` 当前选择任意第一个 Markdown heading，而 builtin shaping template 第一项正是通用的 `## Outcome`；简单清理尾部 `#` 还会把 `# C#` 误解析成 `C`。

## Locked Architecture Decisions

### 1. Provider-neutral contracts

- 不修改 `~/.archcode/config.json`，不指定或限制任何 Model/Profile，不加入 Provider/model 特判。
- Tool schema、Prompt、终态校验和错误分类必须对所有用户配置走同一条路径。
- 真实回归使用当前配置只证明当前环境可运行，不宣称一次回归覆盖所有模型。

### 2. Lifecycle Skill 与普通 Skill 分离

- 普通/显式 Active Skills 继续遵守一个逻辑 Execution 内的不可变 package snapshot；文件变化不能让正在运行的 Execution 漂移。
- 每个 model boundary 只根据最新 Goal 状态选择 root Lead 的保留生命周期槽：无 active Goal 使用 `orchestrate-work`，active Goal 使用 `run-goal`。
- `get_goal` / `update_goal` 的 State activation、Goal notice 与生命周期 Skill 选择读取同一最新 Goal 状态；不改变 Execution loaded-tool refs。

### 3. 确定性错误循环终止

用 Query Loop 内一个小型 `RepeatedFailureTracker` hard cut 当前 pre-execution Doom 行为，不新建策略服务、配置或持久字段：

- `tools/errors.ts` 提供一个封闭、fail-open 的确定性错误 code allowlist。v1 精确包含：`TOOL_UNKNOWN`、`TOOL_SCHEMA_INVALID_INPUT`、`TOOL_BEFORE_HOOK_INVALID_INPUT`、`TOOL_NOT_ALLOWED`、`TOOL_FILE_OUTSIDE_WORKSPACE`、`PATH_OUTSIDE_WORKSPACE`、`TOOL_WEBFETCH_INVALID_URL`、`TOOL_SKILL_NOT_FOUND`、`TOOL_SKILL_RESOURCE_NOT_FOUND`、新拆分的 `TOOL_SKILL_RESOURCE_PATH_INVALID`、`TOOL_SKILL_INVALID_NAME`、`TOOL_SKILL_CATALOG_CHANGED`、`TOOL_SKILL_TARGET_NOT_ALLOWED` 和 `TOOL_SKILL_RESOURCE_BINARY_UNSUPPORTED`；未列出的 code 一律不累计。
- `TOOL_PREPARE_INPUT_FAILED` 与通用 `TOOL_SKILL_INVALID` 明确不在 allowlist；`SkillPackageResourcePathError` 改发单义的 `TOOL_SKILL_RESOURCE_PATH_INVALID`，而 `SkillValidationError` 继续使用非累计的 `TOOL_SKILL_INVALID`。删除无生产 emitter 的兼容 reader `TOOL_INPUT_SCHEMA_INVALID`、`TOOL_BEFORE_HOOK_SCHEMA_INVALID`，以及 `skill_read` 中不可达的 `TOOL_SKILL_PATH_INVALID` 映射；不为旧 code 新建 emitter 或保留别名。
- 明确排除 permission confirmation、timeout、cancel/abort、network/HTTP、进程、binary download、LSP、通用 `execution` 和 unknown error；“存在稳定 code”本身不代表确定性。
- signature 精确等于 `toolName + canonicalInput + errorCode`；不同 input 或不同 error code 不合并。
- 计数范围是整个逻辑 Execution；同一 `toolName + canonicalInput` 一旦成功，清除它此前的失败计数。不存在任意滑动窗口。
- 每次 Query Loop 启动或从 HITL/child suspension 恢复时，从当前 Execution 的 canonical `toolBatches` 按 model step、Tool call `ordinal` 重建 tracker；并行调用的完成先后不参与排序。
- 第三次相同 signature 的调用照常结算真实 Tool error；当前 batch 的其他调用也按真实结果全部结算。随后追加明确的 Execution error，将当前 Execution 标为 `failed`，不得进入下一 model boundary。
- 删除旧的“第三个连续调用执行前被合成为 `TOOL_DOOM_LOOP`、之后继续运行”路径及其行为测试；无兼容双路径或墓碑测试。

### 4. Child Completed 必须有可信最终报告

- Query Loop 继续负责识别 `final_answer` 与 `finalOutputStepId`；`delegation/final-output.ts` 集中提供 child final classifier，输入是该 child 当前 Execution 的 canonical assistant outputs 与 `finalOutputStepId`，不是孤立 final 字符串。`SessionExecutionManager` 必须在 `AgentResult` 返回后、append canonical `execution-end` 之前调用它。
- delegated child 只有在 proposed status 为 completed、`finalOutputStepId` 指向非空 `final_answer`，且 whole-response classifier 不判为 Tool-control-only 时才能写入 Completed。queued-child chain、child link、parent 和 reminder 只能消费门禁后的 canonical terminal record。
- Tool-control-only 是一个有限、与 Provider 名称无关的 grammar，不做“像不像自然语言”的语义猜测。普通 control document 必须整体由一个或多个 ASCII `<invoke>` / `<tool_call(s)>` / `<function_call(s)>`，或全角 `｜DSML｜` 对应 control tag 及其 parameter 节点组成；parameter value 只允许出现在 parameter scope；最外层可有一对 Markdown code fence；必须至少出现一个 control tag。grammar 外存在任何顶层正文就不属于普通 control document。
- 本次 `会</｜DSML｜tool_calls>` 属于单独、可判定的 contextual closing-tail：词法为 `[^<]*` 后紧跟一个或多个全角 DSML closing control tag 并到达输入末尾，而且同一 Execution/run 的紧邻前一个 assistant output 必须是普通 control document或独立的全角 DSML parameter-only fragment。parameter-only fragment 精确指一个或多个完整 `<｜DSML｜parameter ...>...</｜DSML｜parameter>` 节点加空白、没有其他顶层字符。缺少此前置证据时，相同 final 字符串按正文通过；因此普通正文偶然引用 closing tag 不靠长度或语义猜测被误杀。
- parser 与固定 corpus 同文件维护；corpus 必须原样包含前一步 `<｜DSML｜parameter name="m0007">let me try grep.app search</｜DSML｜parameter>`、下一步 `会</｜DSML｜tool_calls>` 的事故顺序，并覆盖多段连续 envelope、嵌套 parameter、无前置 evidence 的同一 closing-tail、纯空白、正常技术报告、正文内 ASCII/fullwidth inline tag、正文加 fenced protocol 示例。不得在 Provider adapter 或 Session UI 各写一套正则。
- 不满足时 child 直接写入 `failed`，error 使用稳定 code-prefixed message：`[CHILD_FINAL_MISSING] ...` 或 `[CHILD_FINAL_PROTOCOL_ONLY] ...`。Execution、child link、同步 delegate payload、background output 和 terminal reminder 保留相同 code/message；现有 Protocol string 字段不伪装成新的 typed object。
- 不自动重试、不伪造摘要、不把空文本当成功。
- 该校验只收紧 delegated child 的交付契约，不禁止 root Session 合法的 Tool-owned terminal completion。

### 5. Plan 只做 Prompt/Skill 约束

- 修改 `plan-work` 与唯一 Plan 模板，不做分布式 Plan writer、分段状态机、Plan service、流式文件协议或多 Agent 并行写同一文件。
- 默认 Plan 不得整段复述 Todo/证据，不贴大段推测代码；保留目标、关键 owner/接口、顺序、风险和可判定验收。
- Prompt 要求以“完成实施所需的最短篇幅”为默认：每节必须支持实现决策或验收，删除背景复述、过程流水账和未被采用的方案。它不设置 Runtime 强制截断或跨所有模型的全局字符上限。
- 12,000 个 Unicode 字符仅是本次约 30KB/13,616-token 事故 fixture 的受控回归 ceiling，用来证明当前配置下输出已显著收敛；不是用户配置、产品拒绝阈值或对任意 Provider 的保证。
- Research 可以委派，唯一 Lead/Discussion 负责一次性整合并原子写入唯一 Plan。

### 6. 当前状态与历史压缩分离

- `ConfiguredAgent` 在既有 Current Context 里以确定性 JSON 投影完整 Session Todos 和最新 direct child 状态；结构化转义防止内容破坏 Prompt。
- “完整”指固定写入容量内不截断：每个 Session 最多 32 个 Todo，完整 Todo JSON 最多 24 KiB；每个 parent 最多 64 个唯一 direct child，已有 child 的 resume 不增加计数。direct-child `sessionId` / `executionId` 由 Runtime 生成，`agentName` 只允许实际可委派的 `analyst | build | explore | librarian`，`profile` 只允许 `deep | fast`，link `status` 必须属于固定 enum，title 必须非空且最多 80 个 Unicode code points（以 `Array.from` 计数）。这些真实写入域已经给完整投影确定上界；不再为系统生成 ID、Todo 单项字段、title bytes、objective 或 Skills 叠加与本问题无关的限制。
- Todo public schema、Runtime reducer、Protocol guard/reducer 与 Session persistence 复用同一容量事实；新 child 在创建 Store、写 link 或运行模型之前 admission。任何越界都显式失败且不产生部分状态，不在 Prompt projection 静默丢条目，也不增加迁移、fallback 或旧 reader。
- 这是明确的 hard cut：只读扫描当前 39 个 Session 时，最大值为 6 个 Todos、3 个唯一 direct children、732 bytes Todo JSON，均未触线；但任何更旧或外部损坏的超限 Session 将在 cold-load 时直接失败。本次接受该后果，不提供迁移或兼容 reader。
- 完整后代树继续由 `list_agents` 读取；Reminder 继续由 `auto_inject`、`wait_for_reminder`、Goal model-context 各自消费。
- Compression 删除 child link、全局 Todo、全局 Reminder 对任意历史范围的 veto；pending/running Tool、unknown result、latest tail、`<protect>` 与真实当前约束仍受保护。
- Canonical messages、nested compression lineage 与 85% Hard Compact 保持原 authority。

### 7. UI 复用现有状态 owner

- Work/HITL 使用已确认的“双层独立 disclosure”：HITL 暂停的相关最新 Work 默认展开；Question/Permission 决策单默认展开但可按 `hitlId` 收成一行摘要；两个 disclosure 的手动状态互不覆盖。
- Running 导航是由 Session inventory、family runtime 和 HITL 投影派生的实时视图，不是新 Todo lifecycle，也不写回 Todo 状态。
- Running 只接纳 `archivedAt === undefined && status !== "rejected"` 的 Todo；其唯一 live predicate 是权威 family activity 属于 `running | resuming | stopping`。`waiting_for_human`、failed、timed_out、max_steps、cancelled 和 completed 不属于 Running。新的单一 navigation derivation 必须替换/拒绝现有会混入 attention/failed 的 active helper，不保留替代 predicate。Needs you 对同一 Todo 优先，命中时不在 Running 重复显示。
- 多个 live Session 以 `session.updatedAt` 降序、`sessionId` 字典序升序选唯一目标；该 comparator 由一个 presentation helper 复用。
- Todo display lead 仍是 content-derived presentation，不增加持久化 title 字段。canonical derivation hard cut 当前“首个任意 heading”逻辑：忽略 fenced code，优先具体 H1；随后跳过 builtin shaping template 的有限结构标题/字段标签、`<Todo title>` 占位和独立 http(s) URL，选择第一条具体正文；不存在具体候选时唯一 fallback 是 `Untitled Todo`，不保留旧 renderer 或第二 fallback。新 shaping template 与 `shape-todo` 主体必须直接要求以具体 `# 标题` 开头。
- UI 修改遵循 `design-system/MASTER.md`、对应 page override 和当前有效 prototype；真实浏览器渲染才是视觉验收证据。

## Ordered Implementation Plan

### Step 0：隔离实施基线、联合交付边界并固化复现

- Runtime/UI 修复最初必须以当时 canonical `origin/main` 的精确 SHA 在独立 worktree 实施，并以该隔离 checkout 证明它没有从营销改动派生。若网络或 canonical ref 无法验证，停止实施并报告，不能猜 base。
- 用户随后明确要求把隔离实现提交到当前 `codex/add-marketing-skills` 分支，因此最终 PR 是有意的联合交付：仅允许已知营销 Skill commit、Runtime/UI commit 及其 review remediation；最终 scope audit 必须排除第三类无关改动。不得再把“最终 PR 不含营销文件”写成验收条件。
- 记录安装版 `archcode` 的 `/api/bootstrap`；Plan 文档可以作为只读输入带入，隔离实现证据与最终联合 PR 的 scope 证据分别记录。
- 把上述 Session 统计转成只读回归 fixture 或测试输入；测试不得依赖用户当前 `.archcode/runtime` 文件持续存在。
- 产出 issue-to-test trace matrix，I-01 至 I-10 每项必须对应 owner、实现步骤和 AC。

### Step 1：修复 Goal/Skill model-boundary 契约

- 在 `packages/agent-core/src/agents/configured-agent.ts` 分离静态 Active Skills 与 root Lead lifecycle slot；每个 `resolveModelBoundary()` 使用最新 Goal 选择 lifecycle Skill，再生成当次 Prompt/Trace。
- 在 `packages/agent-core/src/prompt/compiler.ts` 的 Active 区明确说明正文已经加载，不应再次 `skill_read` 同一入口。
- 更新 `skill-read.ts`、`skill-list.ts` 和 `agents/model-tool-projection.ts` 的最终模型可见 Description/字段说明：
  - 先调用 `skill_list({})`，从成功结果逐字复制一个 current-Agent `name`，再以仅含该 `name` 的 `skill_read` 读取入口；Description 不硬编码可能不属于当前 Agent、可能被同名覆盖或没有对应资源的具体 Skill。
  - resource 只能复制入口 Resources 的精确相对路径，禁止 `/`、`SKILL.md` 和猜测路径。
  - `skill_list({})` 是固定首屏示例；target 示例只能由 model-call-local 允许的 `agent_type` enum 动态选择，且仅在该 target 对当前 Agent 合法时展示，不能硬编码 `build` 或任何不一定可用的目标。首屏省略 cursor，后续只复制上一成功页的 `nextCursor`。
  - 明确禁止 `/`、`:first`、`first`、`new`、`invalid`、`PLACEHOLDER`。
- 为非法 resource、缺失 resource、malformed/stale cursor 返回 Tool-specific hint 和保留原作用域的准确重试 JSON；不得建议创建只读 Skill 文件或构造新 cursor。
- 将 `SkillPackageResourcePathError` 从多义 `TOOL_SKILL_INVALID` 拆为 `TOOL_SKILL_RESOURCE_PATH_INVALID`；`SkillValidationError` 保留原 code 且不进入重复失败 allowlist。

### Step 2：重构重复失败与 child terminal gate

- 在 `packages/agent-core/src/agents/query/loop.ts` 用 post-settlement `RepeatedFailureTracker` 替换当前 pre-execution `DoomTracker`，按锁定的 closed allowlist、logical-Execution、3-hit、success-clear 规则终止 Execution；恢复时从 canonical Tool batch 顺序重建。
- 复用现有 Registry/Tool batch finalized result，不让 Tracker 绕过权限、执行或结果 finalization，也不在 Tool Registry 中承载 Execution policy。
- 在 `packages/agent-core/src/delegation/final-output.ts` 实现唯一 whole-response classifier；`session-execution-manager.ts` 在 canonical `execution-end` 前执行 gate，再由既有 settlement 流同步 child link status、parent Tool result、background output 和 reminder 的单一失败事实。
- 增加空 final、纯空白、ASCII envelope、全角 DSML、相邻 envelope、nested parameter、有/无前置 control evidence 的 closing tail、正文内 inline tag、正常报告内含协议代码块、root Tool terminal，以及 queued-child 不因无效 final 启动下一段等回归。

### Step 3：约束 Plan 输出而不建立新框架

- 更新 `packages/agent-core/src/skills/builtin/plan-work/SKILL.md` 与 `assets/plan-template.md`，写入最短可实施篇幅、禁止大段复述、唯一 writer 和验收优先规则；不加入 Runtime 硬截断或全局字符上限。
- 保留 `apps/web/src/routes/project-todo-detail.tsx` 当前 `/skill use plan-work` 协调入口；除非测试证明它没有加载该 Skill，否则不增加第二份 Plan Prompt。
- 用导致事故的代表性 fixture 和当前配置执行一次 Plan 生成，记录 wall time、模型输出 tokens、最终 Unicode 字符数和写入次数，并按 AC-05 的内容 rubric 验收；时间只作观测，不写跨 Provider 的固定延迟 SLO。

### Step 4：修复 Dynamic Compression ownership

- 从 `compression/protection.ts` 删除 child-link map、全局 Todo/Reminder helper 及其 state input；保留区间内真实未结算内容保护。
- 列出所有 protected kind 的生产 emitter matrix；删除本轮失去 emitter 的 `subagent_link`、`todo`、`reminder`，若同次审计证明其他 kind 也无 emitter，也从常量、严格 schema、parity/行为测试中 hard cut。
- 在 Current Context 增加固定写入容量内完整 Session Todo 和 latest direct-child JSON；按第 6 节在现有 Tool schema、Store/Persistence 与 child admission 设置容量，不新建 DTO、缓存、Runtime State manager 或第二套 Agent Tree。
- latest-direct-child 投影复用系统生成的 `sessionId` / `executionId`、固定 `agentName` / `profile` / `status` 和非空、最多 80 code-point 的 title；加上 64 条上限后正常写入路径已有确定上界。Execution 入口及每次 model boundary 都 fail closed 校验，不增加第二套 aggregate reservation 或无关字段限制。
- Compression owner 只证明 block commit 与 store 状态深相等；Todo/child 可见性和三种 Reminder delivery 分别由自己的 owner-local 测试证明。

### Step 5：完成 Work/HITL 双层折叠

- 以现有 `.archcode/plans/c8fd3231-8414-4492-b704-fb91a8393e10.md` 的已确认交互为细化依据，但最终实现和验收仍受本文 AC-07 约束。
- 先同步 `design-system/pages/session.md` 与 `design-system/prototypes/session.html`，再修改 `ExecutionWorkstream.tsx`、`SessionComposerDock.tsx`、`HitlCard.tsx` 及相关滚动/focus owner。
- 覆盖实时暂停、刷新重进、Needs-you 深链、root/child owner、多 pending request、SSE 更新、用户手动 override、follow-latest、历史阅读锚点、键盘和窄屏；另以投递失败 fixture 证明 `requiresInspection` 不再算 Pending、不锁 Composer，并证明用户手动收起 Inspection 后普通 rerender/remount 不会自动重新展开。

### Step 6：增加 Running Todo 导航

- 在现有 Web projection 层以权威 Session family activity 的 `running | resuming | stopping` 产生唯一的 `RunningTodoNavigationItem` 视图；不复用会混入 attention/failed 的 `sessionInventoryIsActive()`，不写回 Protocol/Server/Todo lifecycle。
- eligibility 先排除 `archivedAt !== undefined` 或 `status === "rejected"` 的 Todo；历史 linked Session 即使仍报告 live 也不能把它们带回 Active navigation。
- `ProjectTodoNavigator.tsx` 在 Needs you 后显示 Running 分组；无权威数据时不显示伪空状态，无条目时隐藏整组。
- 同一 Todo 多个 live Session 只显示一行，按 `updatedAt desc, sessionId asc` 选择目标；Todo 只要命中 Needs you 就从 Running 排除，避免跨组重复；Direct Session 排除。
- Running 行的视觉和 screen-reader 状态统一来自当前 live predicate，固定朗读 `Working`；更旧 failed/terminal Session 不得覆盖该文案。
- 同步 `design-system/pages/todos.md` 与 `design-system/prototypes/todos.html`，并验证桌面导航和窄屏 drawer。

### Step 7：修复 Todo display lead 契约

- 同时更新 `shape-todo/SKILL.md` 主体与 `references/todo-shaping-template.md`，直接要求保存内容第一行是具体、可辨认的 `# <Todo title>`；`Outcome` 等只作为二级结构标题。
- 在 `project-todo-presentation.ts` 实现单一 Markdown-aware derivation：忽略 fenced code；优先不在 skip set 的 H1，否则选择第一条不在 skip set 的具体正文，最后回落到 `Untitled Todo`。skip set 是 builtin template 中精确、大小写不敏感的结构标题和字段标签，加 `Todo shaping template`、`<Todo title>` / `Todo title`；独占一行且能解析为 http(s) URL 的内容单独跳过。不得用“任意冒号行”或模糊关键词猜测。
- 删除 `project-todo-navigation.ts`、`selected-todo-shell.tsx`、`project-todo-detail.tsx` 等调用方现有的局部 `||` title fallback；所有 Todo label（含 accessibility copy）只消费该 helper 的唯一非空结果。
- 增加中英文 Markdown、`## Outcome`、URL 后有说明、URL-only、placeholder-only、字段标签无正文、fenced code、无 heading、空内容、长 Unicode、合法带空白 ATX closing hashes 与 `# C#` 的测试；closing marker 只在标题正文后先有空白时剥除，不新增 title 字段、不迁移 schema、不为旧格式保留另一套 renderer。

### Step 8：集成、真实回归和文档收口

- 更新 `AGENTS.md` 中 Active Skill boundary、child completion、重复失败、Compression state projection 和 UI projection 的当前架构事实。
- 按依赖顺序完成 targeted tests，容量测试必须覆盖 exact-limit、limit+1、越界不落盘和已有 child resume；再执行 `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check`。
- 用 PATH 选中的安装版/新构建产物验证 `/api/bootstrap` 和真实 UI；对 Session/Todos 当前 prototype 与产品逐状态对照。
- 输出 before/after 统计：相同失败 signature 最大次数、失败前模型边界数、child 假 Completed 数、Plan 字符数/写入次数、dynamic block commit、Work/HITL 与 Running UI 状态。

## Dependencies And Parallel Boundaries

- Step 0 必须最先完成。
- Step 1 与 Step 2 都修改 Agent run/query contract，顺序实施并一起集成，不能交给两个 writer 并行改共享调用链。
- Step 3 可在 Step 1 的 Active Skill contract 稳定后独立实施。
- Step 4 先建立 Current Context authority，再删除 Compression veto。
- Step 5、Step 6、Step 7 在设计契约和共享 Todo presentation/projection 有交集；可以并行研究，产品文件修改必须由一个 UI owner 串行整合。
- Step 8 只在所有前置项完成后执行。任何真实回归不得复用已取消的 `9c4f...` Work 或在无关分支直接恢复它。

## Acceptance Criteria

### AC-01：Goal 后生命周期 Skill 立即切换

- 同一 Execution 第一个 Prompt 为 `orchestrate-work + execute-plan`；`create_goal` 成功后的紧邻 Prompt 为 `run-goal + execute-plan`。
- 第二个最终 System Prompt 含完整 `run-goal` body、不含 `orchestrate-work` body，Prompt Trace 与之相同。
- 普通/显式 Skill 文件在两个边界间改变时，本 Execution 的 body/trace 不变；Discussion、child Agent 和无 Goal root Lead 行为不变。

### AC-02：Skill Tool 首次调用和错误恢复无需猜测

- 从实际 `ResolvedToolSet.toAITools()` 检查 `skill_read` 的 `skill_list({}) -> 复制 name -> entry-first -> 复制 Resources path` 示例顺序；示例不得硬编码一个可能不属于当前 Agent、可能被同名覆盖或没有对应资源的 Skill。从 model-call-local projected descriptor 检查 `skill_list` 首屏/target/nextCursor 示例。
- `/` resource 的错误要求用同一个已复制 name 省略 resource 重读入口；猜测的缺失 resource 要求复制 Resources，不建议创建文件或编造另一个示例名称。
- `/`、`:first`、`invalid`、`PLACEHOLDER` 或 stale cursor 都安全失败，并给出删除 cursor、保留原 `agent_type` 的准确首屏 JSON；真实 `nextCursor` 分页不变。

### AC-03：第三次相同确定性失败终止 Execution

- fixture `A(error X), B(error Y), C(error Z), A(error X), B(error Y), C(error Z), A(error X)` 在第三个 A 真实结算后将当前 Execution 标为 failed，不发起下一模型调用。
- 当前 batch 的兄弟调用都有且只有一个真实 finalized result；不同 input/error code 不合并，只有两次不触发，同一调用成功后旧失败计数清零。
- 第二次 A 后通过 HITL 或同步 child suspension/resume，恢复后的第三次 A 仍终止同一 `executionId`；重建顺序固定为 model step 后 call `ordinal`，不受并行完成时序影响。
- 三次 permission confirmation timeout、bash/LSP/web timeout、cancel/abort、HTTP/network、generic execution 或未知 code 均不触发本门禁；allowlist 外 error 必须 fail open。
- 三次泛化 `prepareInput` 异常或 `SkillValidationError -> TOOL_SKILL_INVALID` 也不触发；`TOOL_SKILL_RESOURCE_PATH_INVALID` 的三次相同调用必须触发，以证明 code 拆分有效。
- 旧的 pre-execution synthetic `TOOL_DOOM_LOOP` 继续运行路径从生产代码和行为测试删除，无 fallback 或 tombstone test。

### AC-04：子 Agent 不再假 Completed

- gate 在 canonical `execution-end` append 之前执行；无 final、空白 final 写入 `[CHILD_FINAL_MISSING]` failed，whole-response parser 命中的纯 Tool/DSML control 写入 `[CHILD_FINAL_PROTOCOL_ONLY]` failed，queued-child 不启动下一段。
- child execution error、child link、同步 delegate payload、background output 和 reminder 显示同一 stable code/message；不要求新增 Protocol error object。
- 固定 corpus 中，紧邻两步 `<｜DSML｜parameter name="m0007">let me try grep.app search</｜DSML｜parameter>` → `会</｜DSML｜tool_calls>` 必须写入 `[CHILD_FINAL_PROTOCOL_ONLY]` failed；其他全角 DSML、多个连续 envelope、nested parameter 和仅 fenced protocol 也失败。没有前置 evidence 的同一 `会</｜DSML｜tool_calls>`、具有非空正常报告、正文内 inline tag、正文加 Tool XML/代码块的 child 为 Completed。
- root Session 的明确 Tool-owned terminal completion 保持现有行为；不自动生成摘要或重试 child。

### AC-05：Plan Prompt 约束短而完整

- 最终 Active `plan-work` body 和唯一模板明确要求最短可实施篇幅、禁止复述、唯一 writer，且关键 owner/接口、顺序/依赖、风险和可判定验收不得省略；没有 Runtime 硬截断或全局长度配置。
- 本次事故 fixture 在当前配置下只有一次最终文件写入，成品不超过 12,000 Unicode 字符；该数值只属于此 fixture 的回归证据，不成为其他 Plan 的拒绝阈值。
- 输出 rubric 全部通过：每个 scope issue 映射至少一个 AC；每个 AC 有 starting state、action/event、observable result 或明确命令；owner/interface、顺序/dependency、风险/control 齐全；没有 `TODO`、`TBD`、未决产品选择、完整 Todo 复述或大段源码。
- 没有新增 Plan service、生成状态、分段协议、多 Agent 并行 writer、模型配置或 Provider 分支；wall time 仅记录，不宣称跨模型固定 SLO。

### AC-06：Dynamic Compression 在 85% 前有成功路径

- 合法旧区间即使存在 settled delegate、child links、完整 Todos 和未消费 Reminders，也能提交 `compression.block_committed`。
- 压缩前后 canonical messages 逐字相同，`childSessionLinks`、Todos、Reminders 深相等；下一 Prompt 和 `list_agents` 仍能看到当前状态，Reminder 各 owner 的注入/消费语义不变。
- pending/running/unknown-result Tool、latest tail、protect tag 与当前仍有 emitter 的保护继续拒绝压缩。
- 当前 schema/parity 不再包含已删除的假 protected kinds；nested lineage 与 Hard Compact 测试保持通过。

### AC-07：Work/HITL 双层折叠可读、可操作

- Question 或 Permission 导致最新 Execution 暂停时，实时进入、刷新、重进和 owner 深链均默认展开对应最新 Work，Tool 前 commentary 可直接阅读。
- Question/Permission 决策单默认展开，可独立收起为一行，保留类型、摘要、Pending、展开入口和多请求位置；Composer 输入仍可见，HITL 状态不变。
- Work 与 card 的手动选择按 segment/`hitlId` 在当前路由生命周期保持；SSE 或 remount 不反复覆盖，解决请求后清理过期状态。
- 已回答但投递失败的 `requiresInspection` 卡片必须自动脱离 pending 折叠状态、默认展开并显示 `Inspection · Manual inspection`；它仍保留在 attention 区，但不得继续显示 Composer `Needs you`、阻止普通输入或锁住 slash command/Skill picker。
- 展开/收起不拉走历史阅读位置；follow-latest 仍近底部；最终 Agent response 始终在 Work 外。
- 产品与 `session.html` 在桌面、窄屏、键盘、focus、reduced-motion、root/child、多请求样例中通过真实浏览器 QA。

### AC-08：Running Todo 导航准确恢复工作

- Idea Discussion 的 family activity 为 `running`、`resuming` 或 `stopping` 时，其 Todo 出现在 Running；`waiting_for_human`、failed、timed_out、max_steps、cancelled、completed 和仅有 `In progress` lifecycle 均不出现。
- Ready、Done 等 lifecycle 只要有关联 live Session 也可出现，且 lifecycle 不被修改；Direct Session 永不进入 Todo Running。
- Rejected 或 Archived Todo 即使残留关联 live Session 也不得进入 Running。
- 同一 Todo 多个 live Session 只显示一行，按 `session.updatedAt` 降序、同 timestamp 时 `sessionId` 升序稳定选目标；activity 变化为 idle/terminal 后实时更新，不留下失效入口。
- Todo 命中 Needs you 时只出现在 Needs you，不在 Running 重复；Needs-you-only、failed-only fixture 的 Running 均为空。
- 无 Running 时隐藏整组；inventory/runtime/HITL 未权威就绪时不显示误导性空状态；桌面和窄屏 drawer 均可键盘操作。
- Running 行的无障碍状态固定朗读 `Working`；即使同一 Todo 有更旧的 failed/terminal Session，也不得让屏幕阅读器播报与视觉 live 状态矛盾的历史 `operationalState`。

### AC-09：Todo display lead 不再显示结构占位

- `shape-todo` Active body 与 builtin template 都直接要求生成内容第一行是具体 H1；`Outcome`、`Evidence` 等只作为文档结构。
- 对现有 `## Outcome` 文档，列表 lead 来自第一条具体内容而不是 `Outcome`；对 URL 开头且后有说明的 Todo，跳过 URL 并显示说明；普通具体 H1 保持优先。
- URL-only、placeholder-only、字段标签无正文、只有 fenced code 和空内容都显示 `Untitled Todo`；fenced code 内 heading 不参与候选。
- skip set 只包含计划列明的 builtin template 精确标签并大小写不敏感；算法仍为纯 presentation helper，80 字符 Unicode 截断稳定，不新增 ProjectTodo title 字段、schema 迁移或第二 renderer。
- 合法 ATX closing sequence 只在标题正文后存在空白时移除；`# <Todo title> #` 与 `## Outcome ##` 仍被跳过，而内容标题 `# C#` 必须保留 `C#`，不得把语言名误当 closing marker。

### AC-10：综合验证、成本边界与交付完整

- 同一确定性错误不可能跨过第三次后继续模型循环；回归 fixture 不再出现 27 个边界/59 个失败的失控路径。
- 受控 child fixture 的假 Completed 数为 0；本次 Plan 事故 fixture ≤12,000 字符且单次写入；Compression 在 hard threshold 前至少提交一个 block。
- Work/HITL、Running 和 title 的 prototype、产品实际渲染及交互证据齐全；不能用 DOM/CSS/截图推断代替实际浏览器操作。
- 全部 targeted tests、`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 退出码为 0。
- Runtime/UI 原始实现有以执行时 `origin/main` 精确 SHA 为 base 的独立 worktree 证据；最终联合 PR 只包含用户已批准的营销 Skill commit、Runtime/UI commit 与对应 review remediation，不包含第三类无关改动。
- 独立 Sol(max) Reviewer 检查 I-01 至 I-10、AC-01 至 AC-11、hard cut、owner 边界和过度设计；所有 blocking/high 与明显问题完成 fix -> review 闭环。

### AC-11：Current Context 权威状态有固定写入容量

- Todo 的 32-count 与完整 JSON 24-KiB exact-limit 均可写入，limit+1 分别满足以下结果：public Tool schema `safeParse().success === false`；Runtime reducer 抛错且 mutation 前后引用和值不变；Protocol guard 返回 `false`、Protocol reducer 返回 `{}`；cold-load 明确 reject。任何失败都不产生部分内存或磁盘 mutation。
- 第 64 个唯一 direct child 可以创建；第 65 个在 child Store、parent link、Agent activation 和模型运行前返回稳定 `TOOL_DELEGATE_SESSION_CAPACITY_REACHED`，磁盘与内存均无 child artifact。
- parent 已有 64 个唯一 child 时，resume 其中任一 child 仍成功，唯一 child 数保持 64；resume link 可以记录新的 Execution，但不被误算成新 child。
- 四种 delegated `agentName`、两种 `profile`、固定 `status` enums 与非空 title 的 80 Unicode code points（`Array.from`）通过；81 code points、空白 title、root Agent 名和未知 enum 值失败。`sessionId` / `executionId` 继续由 Runtime 生成，objective / Skills 保留既有 Delegation 合同，不新增与六字段 Current Context 无关的容量规则。Tool schema/admission 返回稳定错误且无 mutation；Protocol guard 返回 `false`、Protocol reducer 返回 `{}`；cold-load reject；Execution 入口或 model-boundary assertion 抛错且模型调用次数为 0。上述任一失败前后均无部分 child Store、link、内存或磁盘状态。Current Context 对 64 条合法状态仍输出全部六个字段的完整、确定性 JSON，没有 prompt-side truncation、摘要、第二个 aggregate gate、迁移或兼容 fallback。
- 当前 39 个 Session 的只读扫描未发现超限；验收同时明确接受历史/外部损坏超限快照 cold-load 失败且不迁移，不能把“当前数据没触线”误写成兼容保证。

## Non-goals

- 不修改用户 Model/Profile 配置，不针对 DeepSeek、OpenAI-compatible 或任何 Provider 建专用分支。
- 不把 Plan 生成改成多 Agent 分布式写作，不建立 Plan runtime state。
- 不改变 Dynamic Compression summary 算法、canonical transcript 或 85% Hard Compact。
- 不增加 Todo title 持久化字段，不把 Running 变成 lifecycle，不改变 HITL/Session Server 协议。
- 不把 Cloud Coding Agent、多租户、Runner/Sandbox/Workspace 架构并入本 Goal。
- 不顺手处理本次 issue register 之外的设计或重构。

## Risks And Controls

| 风险 | 控制 |
| --- | --- |
| 重复失败门禁误杀瞬时故障或合法轮询 | 只统计封闭 allowlist 中的确定性 code；其余 fail open；相同调用成功即清零 |
| Tool batch 触发时留下未结算兄弟调用 | 当前 batch 全部按真实结果结算后才终止，下一 model boundary 才被阻断 |
| 协议残片检测误杀技术报告 | 一个 whole-response grammar/parser 只识别完整 control-only 语言，不做自然语言 heuristic；固定正反 corpus 覆盖正文与代码引用 |
| Current Context 随 Todo/child 增长 | 在既有写入/admission owner 处执行 Todo count/aggregate 与 child count/title 上限；容量内保持 authority 完整与确定性 JSON，越界显式失败，不暗中截断 |
| hard cut 使历史或外部损坏的超限 Session 无法读取 | 当前 39 个 Session 的只读扫描最大 6 Todos、3 direct children、732-byte Todo JSON，现有数据未触线；仍明确接受超限 cold-load 失败，不提供迁移、截断或旧 reader |
| Plan Prompt 不能保证所有模型严格服从 | Tool/终态硬契约负责安全；Plan 长度只按用户确认采用 Prompt 约束，并用真实当前配置记录效果 |
| UI 三项共享 projection/presentation 文件 | 并行只做研究，单一 UI owner 串行整合，先契约/原型后产品 |
| 当前 In Progress UI Work 已取消且 Goal paused | 不恢复该 Session；核心 Runtime 修复后从独立 worktree 启动新 Work 回归 |

## Definition Of Done

只有当 I-01 至 I-10 均映射到已完成实现，AC-01 至 AC-11 全部有决定性证据，独立最终 Review 无 blocking/high，且没有 fallback、旧兼容路径、墓碑测试、模型特判或额外框架时，本 Goal 才算完成。任何一项缺证据都必须报告为 `NOT_DONE`，不能用总体测试通过替代。
