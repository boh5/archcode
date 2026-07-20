# Session Goal Runtime Hard-Cut Progress

本文件只记录 `session-goal-runtime-hard-cut-plan-goal.md` 的执行过程、证据和偏差；实施契约与验收标准仍以 plan-goal 文档为准。

## Status

- 当前阶段：完成
- Goal：complete
- 独立终审：`PASS`（最新 `sol(xhigh)`；AC-01 至 AC-08 全部通过，无剩余 P0/P1/P2）

## Execution Log

### 2026-07-19 — Baseline

- 确认工作树只有未提交的 plan-goal 文档，没有用户代码改动需要绕开。
- 遗留搜索确认旧 Goal 跨越 protocol types、Session `goalId/sessionRole`、Goal state/lifecycle/worktree/budget、Goal Lead、`goal_create/goal_manage`、Server Goal routes、Web Goal pages/sidebar/API。
- 锁定 hard cut：不读取旧 Goal 文件、不保留旧 URL/alias/fallback/双写；普通 Session 数据边界保持严格。
- 并行边界：SessionGoal 持久化领域、Agent/Tool/Prompt、Server/Web 产品面分别实施；主执行负责 ExecutionManager、continuation、review gate 与整合。

### 2026-07-19 — Domain And Product Hard Cut

- `SessionGoal` 与 `SessionGoalService` 已落地到 Session strict store；创建、编辑、暂停、恢复、清除、预算、Evaluator 与 Review 转移均由该 Service 单一持有。
- 正式 Agent 收敛为 7 个；`goal_lead`、Goal Create Skill、旧 `goal_create/goal_manage` 和 Goal 专属 Prompt/Tool 路径已删除。
- 新 `create_goal/get_goal/update_goal` 使用 Runtime 颁发的一次性 fresh-user-input capability；Engineer `complete` 仅产生 Review 请求，不能直接改为 complete。
- Server/Web 已删除 Goal list/detail/Inspector/route/API，改为 Session Goal 投影、Dashboard 聚合和 Composer progress row。
- 首次 typecheck 表明 protocol/web/server 已通过；剩余失败集中在 ExecutionManager 的旧 `goal_claim/stop_session_family` 分支与对应旧测试，正由 runtime coordinator 和 test cleanup 两个边界收口。

### 2026-07-19 — Runtime Coordination And Review Gate

- 新增高内聚 `session-goal/` runtime：Coordinator 只在 root family idle 后按 Tool Batch/HITL、Queue、Review、Remediation、Evaluator、Continuation 的固定优先级推进，不建立第二套 scheduler。
- Evaluator 复用 Reviewer 模型绑定但不创建 Agent/Session、不给工具；usage 经统一 LLM usage callback 计入整棵 Session family。
- 新增 Runtime-only `goal_review(reviewClaimId)` child provenance；`SessionExecutionManager` 仍是唯一执行 admission owner，并给 Goal Reviewer 固定只读验证工具投影。
- Review claim 绑定 instance/generation/contract/user cursor/source epoch/fingerprint/current attempt；Reviewer crash 使用同一 immutable claim 创建新的 child attempt，旧 receipt 永久失效。
- Reviewer accepted 只有 Runtime 能原子完成 Goal；rejected 原子进入 remediation，Engineer 修复终态后才允许重新 Evaluator/Reviewer。
- Goal family source fingerprint 覆盖 Git HEAD/index/非忽略内容；Reviewer 或 guarded Bash 修改源码会使当前审核失效。

### 2026-07-19 — Cross-domain And Product Closeout

- Worktree/cwd、HITL、Queue/Steer、child tree、预算和 Project Todo 已硬切到 Session owner；Todo 不再保存 Goal activation/resource ID，Automation 未新增 Goal action。
- Server 删除全部独立 Goal route；Session API 直接提供 edit/pause/resume/clear，Dashboard 只从 Session 列表投影 Goal。
- Web 删除 Goal list/detail/Inspector/Sidebar/API，新增 Composer progress row、Session badge 和 Dashboard 状态聚合。
- 活跃架构文档已切换到 Session Goal；旧 Workbench PRD/TDD 明确标为历史设计记录，不再宣称当前实现。
- 旧 Goal、Goal Lead、Skill、Tool、route、UI、fixture 与配置字段没有 adapter、fallback、redirect、双写或兼容 parser。

### 2026-07-19 — Validation Before Independent Review

- `bun run typecheck`：5/5 workspace 成功。
- `bun run test`：8/8 Turbo tasks 成功；Agent Core architecture lane `93 pass / 0 fail`。
- `bun run build`：typecheck、Vite 2674 modules、308 asset manifest 与 Bun binary pipeline 成功。
- `git diff --check`：成功。
- 生产源码和活跃文档精确搜索旧 `goal-create/goal_lead/GoalStateManager/GoalLifecycleService/GoalLeadContinuationService/goal_manage/reviewGeneration/goalId/sessionRole`：清理后无结果。
- 使用独立七 Agent 临时配置真实启动 Hono Runtime，成功监听 `http://localhost:4096` 并正常 graceful shutdown；没有读取或迁移旧 `agents.goal_lead` 配置。
- 真实浏览器验收未能执行：当前唯一内置浏览器客户端对 `localhost`、`127.0.0.1` 和本机 LAN 地址均返回客户端拦截。该缺口不能用组件测试冒充，留给独立 Reviewer 决定 AC-04/AC-07/AC-08 verdict。

### 2026-07-19 — Independent Review Fix Loop

- Review Gate 的 evidence 判定改为只接受 transcript 中可定位且与当前 claim 一致的实际 Tool evidence；拒绝模型伪造 ref，并把可重复 verification 收窄到 Bash/LSP/git diff 结果。
- 新增 review-scoped source monitor 与统一 `ReviewableSourceSet`：Git 覆盖 tracked 与非忽略 untracked，非 Git fail-closed 覆盖源码；write-restore、瞬时 create/delete、watch allocation/error/ambiguous event 均使 claim 失效，ignored cache 不误伤。monitor 在 claim 终态释放，不是常驻 workspace watcher。
- Coordinator 修复所有 continuation/Evaluator/Reviewer/remediation 的持久化失败恢复：有界退避，三次失败 blocked；HITL orphan、Runtime restart、review attempt replacement 和 remediation execution rebind 都只产生一个合法后继 Execution。
- Goal objective 收敛为严格单字符串：`create_goal` 无模型 objective 参数，直接消费 fresh 用户原话；edit 必选 `amend | replace`，前者机械追加且仅后文直接冲突覆盖，后者完整替换；超过 4,000 字符直接失败，不截断、不建来源账本。
- `session.goal_changed` 通过 protocol reducer、Session SSE 与 Web invalidation 传播 canonical snapshot；预算调低立即进入 `budget_limited`，调高/移除恢复 active。budget-limited 不可再 Pause；blocked Resume 重置连续 failure/no-progress 审计窗口。
- Worktree API、命名和测试 fixture 完成 Session-only 硬切：删除 owner type union，分支只使用 `archcode/session/*`；Web HITL scope 只允许 `project | session`，删除最后一个 Goal owner 表面。
- `SessionExecutionManager` 新增短生命周期 root-family control section，让 Review completion 与 direct/queued 用户输入共享一个线性化点；输入先到会使旧 Review 失效，Review 先取得控制权时后续输入等待其原子转移完成。最后一个 input mutation 释放后主动触发 Goal reconcile，避免形成静默 idle。新增 deferred 交错测试证明只启动一个用户后继 Execution。
- 真实 OS/Git 测试按仓库约束移入 `.integration.test.ts` lane，没有放宽 architecture gate 或增加测试例外。

### 2026-07-19 — Final Validation Evidence

- `bun run typecheck`：5/5 workspace 成功。
- `bun run test`：主执行最新两次全量运行各出现一个既有 Tool Output 并行态失败（第一次 `ToolOutputArtifactStore` 单行 artifact 用例，第二次 `Tool Output Plane real user stories` preview 用例）；对应文件隔离复跑全部通过。独立终审随后全量复跑为 `8/8 tasks / 0 fail`，Agent Core unit `2635/2635`；Goal 最新聚焦验证 `125 pass / 0 fail`。没有为追求绿灯引入 retry、fallback 或测试放宽。
- `bun run build`：typecheck、Vite 2674 modules、308 asset manifest 与 Bun binary pipeline 成功。
- Runtime recovery 测试通过真实 `acceptSessionMessage -> create_goal` 激活，在同一持久目录关闭 Runtime 1、启动 Runtime 2，只恢复一个 active continuation。
- 另用 repo 外临时 QA 驱动完成真正跨进程 Hono restart：seed 进程通过 `createServerApp + startServer` 启动于 PID `13967` / port `53115`，经公共 Runtime 激活并将同一 Session Goal 持久化为 active 后退出；recover 进程以同一 registry/workspace 启动于 PID `14496` / port `53162`，恢复后 family 为 running，100ms 后 continuation 仍严格为 `1`，随后 pause/shutdown。临时驱动不进入生产仓库，不形成测试专用 fallback。
- 真实模型 Prompt eval 命令：`ARCHCODE_PROMPT_LIVE_EVAL=1 bun run prompt:live-eval -- --manifest /private/tmp/session-goal-live-eval-manifest.json --home-dir /private/tmp/archcode-browser-qa.BwIBxL`；模型 `local:deepseek-v4-flash`；结果 `/private/tmp/session-goal-live-eval-results.json` 为 `14/14 pass`，覆盖激活正负/模糊边界、direct/parallel/serial 与 child terminal action。
- 临时七 Agent 配置 Runtime 真实启动，`GET /api/health` 返回 200，并正常 graceful shutdown。
- 内置 Browser skill 最终复试：新建浏览器页访问 `http://localhost:4096` 返回 `net::ERR_BLOCKED_BY_CLIENT`；`lvh.me` 别名无法回连宿主机。本机同刻 health=200。浏览器用户故事仍是外部证据缺口，未以组件测试替代。
- `git diff --check` 成功；生产源码扫描旧 `goal_lead/goal_create/goal_manage/goalId/sessionRole/GoalStateManager/GoalLifecycleService/GoalLeadContinuationService/reviewGeneration` 与旧 Goal owner/worktree 命名均为 0 matches。

### 2026-07-19 — Independent Final Review Verdict

- 独立 `sol(xhigh)` Reviewer 逐项复核 AC-01 至 AC-08；此前唯一 P1（用户输入与 Review completion 竞态）修复后，未发现剩余 P0/P1/P2 实现缺陷。
- PASS：AC-01、AC-02、AC-05、AC-06。
- 初次终审 `NOT_DONE`：AC-03 当时缺真正的跨进程 Hono server restart；AC-04/AC-07 缺强制真实浏览器 Review 循环与桌面/390px 用户故事；AC-08 因上述编译后二进制浏览器验收缺失不能通过。
- 补证后 Reviewer 独立重跑两个 OS 进程：seed PID `25363` / Hono port `53426`，recover PID `25568` / Hono port `53456`，两条命令均 exit 0，恢复 continuation exactly once；AC-03 更新为 PASS。
- 最终 AC 判定：AC-01/02/03/05/06 PASS；AC-04/07/08 仅因真实浏览器证据缺失而 `NOT_DONE`。实现层面没有剩余 P0/P1/P2。
- Reviewer 明确区分“代码已达到可交付状态”和“验收合同证据未齐”；没有降低验收标准，也没有把组件/集成测试冒充真实浏览器证据。

### 2026-07-19 — Real Browser QA And Runtime Fix Loop

- 更正此前“内置浏览器无法访问本地地址”的判断：源码 Hono `:4096` 根路径本就不提供开发 Web 页面；通过 Vite `:5173` 访问后，内置 Browser 能正常操作真实 UI。该问题是验收入口判断错误，不是 Browser 外部阻塞。
- 桌面浏览器完成自然语言自动激活、direct/Queue/Steer 修改、Pause/Resume、Stop、预算受限与移除限制、server restart 后 reload；390px 视口确认 Goal progress row 与控制按钮无明显溢出，浏览器 console error 为 0。
- 真实 Agent 修复临时项目 `math.ts`、运行 `bun test`、委派普通 Reviewer 并提交 `update_goal complete`。Runtime 创建了全新的 Goal Reviewer child，证明 Engineer 的完成声明没有绕过 Review Gate。
- 浏览器触发并证明 `Reviewer rejected -> Engineer remediation`：首次 Runtime Reviewer 因审核期间源码变化拒绝完成，Goal 保持 active；用户解除 blocked 后，Engineer 实际重跑 `bun test` 并创建新的 Runtime Reviewer attempt。
- 发现 Stop 与延迟 usage 结算竞态：Stop 先写 `paused` 会掩盖随后发生的预算耗尽。修复后 `budget_limited` 具有展示优先级，同时保留 latent pause/blocked 意图；提高或移除预算后回到原控制态，不会越权自动续跑。两种结算顺序均有回归测试。
- 发现 delegated child 的 terminal `submit_child_result` 已结束 Execution、但 Tool Batch 未归档，Runtime 会把同一 batch 复活为第三个 Execution。修复位于唯一 Tool Batch owner：终止结果、后续 skipped calls 与 `archivedAt` 原子持久化，QueryLoop 直接退出，不增加上层 special case。
- HITL 真实用户故事通过：新根 Session 通过自然语言激活 Goal，读取 `.env` 触发 session-owned Permission 卡；UI 显示等待状态，`Allow once` 后原 `file_read` 继续，随后进入 Reviewer。HITL 未建立 Goal owner 或专属通道。
- 第二次 Runtime Reviewer 的内容明确报告独立审核通过，但 Runtime 仍将其记录为 rejected；另发现用户未明确要求预算时模型仍能给 `create_goal` 设置 token budget。两条均违反锁定契约，已分别交由独立子 Agent 在 Review Gate 与 fresh-input capability owner 内修复，并要求聚焦回归测试。
- Reviewer 判决链根因不是 claim/fingerprint fence：Reviewer 使用了 `tool:functions.bash` 等工具名别名而非真实 `tool:<toolCallId>`，Gate 因证据不可定位而正确拒绝。真实缺陷是 terminal submit 后才校验，Reviewer 无法纠正，且 rejection reason 错用模型自称 passed 的摘要。修复后 terminal boundary 先用统一 proof collector 预检并返回当前 Session 的真实可用 refs，允许一次 structured correction；Gate 保留 fail-closed 二次校验并记录机器拒绝原因。
- 重启源码 Runtime 后，真实浏览器完成完整闭环：旧 Reviewer rejected；Engineer 按理由重读源码、重跑 `bun test`、重新提交 completion claim；全新 Reviewer 使用真实 refs 后 accepted；Runtime 原子写入 `Goal complete`。随后点击 Clear，progress row 与 Session badge 立即消失，Session transcript 和 workspace 修改保留。
- 首版预算授权修复能拒绝模型自设预算，但真实模型不断改用 2000、MAX_SAFE_INTEGER、1 重试；由于校验前已消费 fresh capability，Goal 最终无法创建。该结果证明“保留 model-controlled budget 数字再校验”仍是错误接口，已退回修复循环：授权失败必须零副作用，并优先从模型 schema 删除预算数值、由 fresh 原话确定性派生，类型层消灭预算幻觉。
- 最新完整浏览器流程后 `dev.logs(level=error)` 返回空数组。
- 全局配置仍有硬切前的 `agents.goal_lead`。已先备份为 `/Users/bo/.archcode/config.json.pre-session-goal-hard-cut`，再只删除该废弃字段，使真实编译后二进制能够按七 Agent strict schema 启动；未改动 provider、模型或其他设置。
- 预算接口完成第二次硬切：`create_goal` 模型输入严格为 `{}`，`update_goal.set_budget` 只包含 action；预算值或 removal 只从 immutable fresh 用户原话确定性派生。fresh capability 在同一个 ExecutionManager 临界区内 validate-then-consume，失败零副作用，并发/重复仍只允许一次成功。真实浏览器复验中无预算请求首次 `create_goal {}` 成功，Session API 明确 `hasTokenBudget=false`。
- 最终 390x844 Browser screenshot 中 progress row、objective、Edit/Resume/Clear 和 composer 全部可见，无水平溢出或控制遮挡；恢复桌面 viewport 后 console error 仍为 0。

### 2026-07-19 — Final Full Validation And Compiled Product

- `bun run typecheck`：5/5 workspace，exit 0。
- `bun run test`：8/8 Turbo tasks，exit 0；Agent Core unit `2644 pass / 0 fail`、integration `156 pass / 0 fail`、architecture `93 pass / 0 fail`。
- `bun run build`：typecheck、Vite 2674 modules、308 asset manifest、最新 `dist/archcode` 编译完成，exit 0。
- `git diff --check`：exit 0。
- 生产源码扫描旧 `goal-create/goal_lead/GoalStateManager/GoalLifecycleService/GoalLeadContinuationService/goal_manage/reviewGeneration/sessionRole/goalId` 无结果；旧完成计划文档中的历史术语保留为当时验收记录，不是活跃架构或兼容路径。
- 使用真实全局七 Agent strict config 启动最新 `./dist/archcode`，监听 `http://localhost:4096`；编译产物直接返回 embedded Web assets。Browser 打开真实 Dashboard 与持久 Session Goal，progress row/Session badge/controls 正确，Clear 通过 compiled API 生效，console error 为 0；QA 项目随后从全局 registry 删除，二进制 graceful shutdown 且 `activeSessions: 0`。

### 2026-07-19 — Final Xhigh Review Fix Loop

- 最新独立 `sol(xhigh)` 终审发现一个 P1：watch callback 已收到瞬时 source event、但异步 `containsEventPath()` 仍在分类时，旧 `dispose()` 只关闭 watcher/等待 mutation；最终 fingerprint 恢复原样时，Runtime 可能先 complete，迟到 invalidation 因 claim 已清除而失效。
- 修复严格位于 `SessionGoalReviewSourceMonitor`：登记所有已入场 path classification Promise；`dispose()` 幂等复用单一 Promise，固定执行 close watcher -> drain classifications -> metadata fence -> await invalidation mutation。classification rejection fail-closed，close 后新事件不再入场，无 sleep、上层特判或 fallback。
- 新增确定性 integration tests：pending classification 必须阻塞 terminal dispose，释放后 `source_event` invalidation/mutation 先完成；classifier rejection 与并发双 dispose 只失效一次、无 unhandled rejection。Monitor `9/9`、Coordinator `17/17`、typecheck `5/5`、diff check 通过。
- 主执行在该修复后两次全仓测试均只命中既有 Tool Output preview tail sentinel 偶发失败；对应文件隔离复跑 `3/3`。未增加 retry、放宽断言或改该无关模块。独立终审随后全仓复跑 `8/8`、source monitor `9/9`、architecture `93/93`，并确认该已知 flake 不阻塞本 Goal。
- P1 修复后重新 `bun run build` 成功；最新 `dist/archcode` 再次以真实七 Agent 配置启动，`GET /api/health` 返回 200，graceful shutdown 时 `activeSessions: 0`。
- 最终独立 verdict：AC-01 至 AC-08 全部 PASS，无剩余 P0/P1/P2，可以完成 Goal。

## Acceptance Evidence

- AC-01：PASS
- AC-02：PASS；real-model eval 14/14
- AC-03：PASS；automated + independently repeated cross-process real Hono server restart
- AC-04：PASS；真实 Browser 完成 rejected -> Engineer 重新读/测 -> 新 Reviewer structured correction/accepted -> Runtime complete
- AC-05：PASS
- AC-06：PASS
- AC-07：PASS；桌面与 390px 覆盖完整用户故事，reload/server restart/complete/Clear 均通过，console 0 error
- AC-08：PASS；typecheck/test/build/search/diff/compiled binary/browser 与最新独立 `sol(xhigh)` 终审全部通过

## Corrections And Risks

- 旧 Workbench PRD/TDD 内容与 hard cut 冲突，因此更正为明确的历史设计记录；当前实现只以本 plan、README、AGENTS 与活跃架构文档为准。
- 先前把 Hono API 根路径 404/拦截误判为 Browser 无法访问本地地址；实际 Web 开发入口是 Vite `:5173`，现已更正并用真实 Browser 补验，不再把该项当作外部阻塞。
- 第一版只做 claim/finalization fingerprint 会漏掉 Reviewer 写入后恢复原内容的 mutation；因此更正为 review-scoped 临时 source monitor + final fingerprint 双门禁，不引入常驻 watcher。
