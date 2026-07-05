# ArchCode 产品需求文档(PRD)— Architect Workbench

> **You architect. AI codes.**
> ArchCode 是把架构意图转化为受监督、跨项目 AI 编码执行的**自托管 AI 工程工作台**。

**术语**:本文档中的"架构师"指** ArchCode 的用户**(资深工程师/技术 lead,见 §2),不是 AI agent。文档里的"AI""agent"指 ArchCode 编排的编码执行者。

**本文档是 PRD(产品需求)** —— 定义"做什么、为谁做、为什么、成功标准"。
**配套技术设计在 `docs/workbench-refactor/TDD.md`** —— 那里定义"怎么实现"(类型/schema/路由/组件)。
**状态**:产品规格,描述完整产品意图。实施按 5 阶段(先 Goal 后 Loop)分步,由用户根据本 PRD 拆任务执行。Phase 2 Goal 语义以 §5.2 为当前实现边界。

---

## 1. 定位

### 1.1 一句话

**ArchCode 是资深工程师/架构师把架构意图转化为受监督 AI 编码执行的自托管工作台。**

市场版本:**You architect. ArchCode runs the AI engineering loop.**

### 1.2 不是什么

- 不是 IDE(不与 Cursor 竞争"编辑器内写代码")
- 不是 CLI(不与 Claude Code/Codex 竞争"终端 agent")
- 不是"更好的自动补全"(不与 Copilot 竞争)
- 不是云端自主工程师(不与 Devin/Factory 竞争"派 ticket 给远程 AI")
- 不是 app builder(不与 Lovable/Bolt 竞争"ship 产品")

### 1.3 是什么

**"架构师如何用 AI 完成软件工作"** 的工作台。产品不是"更快的 coding agent",而是"把意图转化为受监督 AI 编码执行的工作台"。

核心转变:**改变用户是谁** —— 不是"写代码更快的人",而是"设计意图并监督执行的人"。

---

## 2. 目标用户

### 2.1 用户画像

**资深工程师 / 架构师 / 技术 lead**,具备以下特征:

- 手上管理 3-10 个代码库,有些是生产系统,有些是实验项目
- 不想(也不应该)亲自写每一行代码,但必须掌控方向和质量
- 需要在自己的基础设施里运行(自托管、BYOM、代码不出域)
- 需要"合上笔记本,工作继续;回来看到机器可检证据,决定 merge/retry/escalate"
- 需要给重复性维护工作(CI triage、PR babysit、依赖更新)设定"自动跑但有人审门"的循环

### 2.2 非目标用户

- 想写代码更快的个人开发者(用 Cursor/Claude Code)
- 想完全自动化、派 ticket 给 AI 的团队(用 Devin/Factory)
- 想不写代码直接 ship 产品的非技术用户(用 Lovable/Bolt)
- 只用 IDE 的初学者(用 Copilot)

### 2.3 核心痛点

| 痛点 | 现状 | ArchCode 解决 |
|---|---|---|
| 多项目 AI 编码没有统一指挥台 | 每个仓库开一个 Claude Code/Cursor tab,context 割裂 | 跨项目 Mission Control,一处看全部 |
| AI 说"我做完了"但不可信 | 模型自评,无独立验证 | 机器可检 Done 条件 + 独立 Reviewer + 默认拒绝 |
| 长任务不敢放手跑 | 怕 token 烧穿、怕跑飞、怕回来不知道发生了什么 | token Budget 护栏 + kill switch + 审计日志 + run-log |
| 重复性维护工作占精力 | 每天手动看 CI、triage PR、查依赖 | Loop 自动跑,人审门控风险,State 持续积累 |
| 代码不出域 | 云端 AI 工程师 SaaS 黑盒 | 自托管 + BYOM + 全透明可审计 |
| 合上笔记本工作就停 | 终端 agent 是 session-scoped | 持久 server + SSE 推送 + 工作继续 |

---

## 3. 核心交互

### 3.1 典型使用流程

```
1. 架构师设计意图 → Goal(不可变 Done 条件 + 独立 Reviewer)
2. ArchCode 分解 → plan / build / review 任务
3. AI agents 执行 → 架构师不写代码
4. 架构师监督 → Web UI 显示进度,审批关键操作,审查证据
5. 架构师合上笔记本 → 工作继续,token Budget 护栏,SSE 推送通知
6. 回来审查 → Reviewer 提供机器可检完成证据,架构师决定 merge/retry/escalate
```

### 3.2 三个使用场景

**场景 A:复杂功能开发(Goal)**
架构师描述"给 auth 模块加 refresh token 轮转",设定 Done 条件(`tests_pass` + `typecheck_pass` + `spec_compliance`),审批门在 plan 完成后。ArchCode 自主分解 plan→build→review,架构师在 plan 完成时审查方向,合上笔记本,回来看到 Reviewer 的机检证据,决定 merge。

**场景 B:重复性维护(Loop)**
架构师创建 daily-triage Loop,设定 schedule(每天 9:00)、budget(每日 100k tokens)、approvalPoints(破坏性操作必须人审)。Loop 每天扫 CI/issue/commit,报告高优先级项,小 fix 自动提 PR(人审后 merge),大问题 escalate。架构师每天看 5 分钟报告,不用盯。

**场景 C:随手问(Session)**
架构师开一个顶层独立 Session(不归属任何 Goal/Loop),问"这个函数怎么用"或"帮我 grep 一下 X 在哪用",AI 回答。轻量,无仪式。

---

## 4. 功能需求

### 4.1 三层原语:Session / Goal / Loop

| 原语 | 定义 | 终止条件 |
|---|---|---|
| **Session** | 一次对话 + 工具执行,架构师掌控 | 架构师说停就停 |
| **Goal** | Session + 机器可检 Done 条件 + 独立 Reviewer + 失败换新上下文重试 + **显式 phases**(plan→build→review) | Done 条件全 true,或重试上限耗尽 |
| **Loop** | Goal/Session + 调度 + 跨 run State + Budget | 被杀 / 预算耗尽 / 自清理 / 人审挂起 |

**三条铁律**(来自社区失败案例):
1. **Done 条件锁死**:运行前锁定,运行中不可变。完成判定走机器可检,不走人类主观判断。
2. **Reviewer ≠ Implementer**:Maker/Checker 非协商。Reviewer 默认拒绝,必须用证据说服它放行。
3. **Loop ≠ 自主改进项目**:Loop = 自动化你本来就会做的重复性维护。把 Loop 当"让 agent 自由改进代码库"是 $47K 失控案例的根源。

**Goal phases**(显式,持久化到 `goal.json`):
- Goal 分三个 phase:`plan` → `build` → `review`
- phase 字段持久化,可测试、可恢复、UI 可可视化进度
- `approvalPoints` 是 **phase 转换门**:Goal 状态机在 phase 切换时检查 → 命中则调 HITL `approval` → 等用户决策 → 放行或拒绝 phase 切换
- `after_plan` = plan→build 门;`before_complete` = review→completed 门;`on_destructive_op` = build phase 内破坏性操作的工具 guard(详见 §4.3)
- **这不是 Workflow 的 8-stage FSM**——只有 3 个 phase,且 phase 是 Goal runner 内部进度,不是顶层状态机节点。Goal 顶层状态机仍是 draft→locked→running→verifying→reviewed→completed/failed/escalated

**Session 层级**:Goal 下有一个主 session(orchestrator,架构师对话在这里),主 session 下有子 session(plan/build/review/explore/librarian,各自独立 store)。简单任务直接用顶层独立 Session,不需要 Goal。

**Loop 不是 Goal 超集**:Loop 是调度容器,可跑 Session(简单重复任务)或 Goal(复杂重复任务带 Done + Reviewer)。

### 4.2 Done Conditions:混合两层

**Layer 1:机器可检(7 种 machine + 1 HITL)**:
- `tests_pass` / `typecheck_pass` / `lsp_clean` —— 代码质量
- `file_exists` / `grep_contains` / `grep_empty` —— 产物/内容检查
- `command_succeeds` —— **万能逃生口**(任何条件都能用一条 shell 命令表达)
- `user_confirmed` —— HITL 审批(**唯一非机器 check**,走 HITL `approval` kind)

**Done 条件谁生成**:AI(orchestrator/plan)可生成所有 kind 包括 `command_succeeds`,但**用户 `lock` 确认后才生效**。安全由三层保证:(1) 用户 lock 确认 (2) Reviewer 独立验证(Reviewer ≠ 生成 doneConditions 的 agent) (3) `command_succeeds` 的 bash guard(限制破坏性命令)。`goal.json` 记录 `author`(生成者)和 `lockedBy`(锁定者)。竞品先例:Factory Missions 的 AI orchestrator 生成 Validation Contract,用户审批计划,独立 fresh validator 验证;Castor 的 AI orchestrator 生成 done_conditions,自动验证器执行。

**Layer 2:AI 判断(可选)** —— 1 种:
- `spec_compliance` —— Reviewer 读 spec + 代码 + 跑工具,判断实现是否匹配 spec。复杂 Goal 用,简单 Goal 不用。

**为什么是混合**:纯 AI 自判不可靠(Steinberger/SonarSource 警告"slop machine";Claude Code `/goal` evaluator 官方承认"不调工具,只能读对话")。纯硬编码不够(需要 maker/checker split + AI 判断 spec 符合度)。Castor 的固定 enum 是有效先例。

**Goal 状态机**:draft → locked → running → verifying → reviewed → completed(全 true)/ failed → retry(fresh session)/ escalated(重试耗尽)。**`reviewed` 是 `done` 的前置** —— orchestrator 不能跳过 Reviewer。Goal 内部有 3 个 phase(plan→build→review),`approvalPoints` 是 phase 转换门(不是独立状态机节点)。

**Reviewer day-one 强制**:Goal 核心价值就是 locked Done 条件 + 独立 Reviewer 验证。没有 Reviewer 的 Goal 退化为 Session(用 Session 即可)。Phase 1 起 Reviewer **强制**,orchestrator 不能跳过。

### 4.3 HITL:横切关注点

**3 种 kind**,各自有机器可强制的语义区别(不是纯语义分类):

| kind | 语义 | 机器强制点 | 整合的现有能力 |
|---|---|---|---|
| `question` | agent 主动要信息,回答回流到对话 | 无选项或有选项(现有 `ask_user` 已支持 options/multiple/custom),回答回流对话上下文 | 替代 `ask_user` 工具 + 现有 workflow interaction 的 `decision`/`preference`/`clarification` 三种 kind(结构相同,区别纯语义,合并) |
| `approval` | 某个门控层需要人审时,HITL 呈现 yes/no 给用户并拿回决策 | 呈现 approve/deny/approve_always 选项,拿回用户决策 | **被两个独立调用方调用**:(1) Goal phase 转换 guard(详见下文 approvalPoints)(2) 现有 tool permission guard(单次工具调用时调,guard 返回 `outcome:"ask"` → permission 模块调 HITL `approval` → 拿回决策 → 放行/拒绝/持久化)。HITL 只管"呈现+拿决策",不管"判断要不要问"(调用方的事)和"deny 后做什么"(调用方根据返回值处理) |
| `review` | 架构师批量审查产物,outcome 决定 Goal 走向 | outcome 是 `DONE` / `NOT_DONE`,驱动 Goal 状态机 | **新能力**,现有代码无对应 |

**为什么不是 4 种(没有单独的 `decision` kind)**:`decision` 和 `question` 的结构完全相同(都可以有 options + recommendedOption + rationale),区别只在 agent 怎么用答案——这是 prompt 层语义,不是 runtime 层。机器无法强制区分的,不应该分成两个 kind。agent 想表达"这是分叉决策",在 prompt 里说,不需要单独 kind。

**两个独立的门控层**(都调 HITL `approval`,但触发时机和判断逻辑完全不同):

| 门控层 | 触发时机 | 谁判断"要不要问" | 谁执行 | 现有/新增 |
|---|---|---|---|---|
| **Goal approvalPoints** | Goal phase 切换(plan→build, review→completed) | Goal runner 的 phase transition guard | Goal runner 拦截 phase 切换 → 调 HITL `approval` → 拿决策 → 放行/拒绝 phase 切换 | **新增**,Goal 系统的一部分 |
| **Tool permission** | 单次工具调用(file_write/bash 等) | tool guard(workspace/sensitive-file/bash-classifier/read-before-edit)返回 `outcome:"ask"` | permission 模块调 HITL `approval` → 拿决策 → 放行/拒绝工具执行/approve_always 持久化 | **现有,不变** |

**HITL 架构:不合并现有 service**。保留 `PermissionService`(tool permission 安全边界)+ `AskUserService`(已有 ask_user)不动。新增 `HitlService` 只管 Goal approvalPoints 和 review kind 的 queue + respond + cancel。`HitlService` 复用现有 deferred Promise + SSE 推送 + 超时/abort 安全 resolve 模式,但是独立 service。

**HITL 持久化:Phase 2 durable project-scoped queue**。pending/resolved/cancelled/timeout approval records 持久化到项目工作区,server restart 后 pending records 仍可见。旧进程内 Promise 不恢复;runner recovery 会暂停受影响 Goal 或通过 deterministic approval key 复用 existing pending record。Dashboard/Web 只展示 redacted `displayPayload`,不展示 raw payload。

**approvalPoints 是 Goal 系统的产品规则**:
- 架构师在 Goal 配置里声明 `after_plan` / `before_complete`
- Goal runner 在 phase 切换时检查这些点 → 命中则调 HITL `approval` → 等用户决策 → 放行或拒绝 phase 切换
- **`on_destructive_op` 不是 approvalPoint**——它是 tool guard 的默认配置,在 build phase 内单次工具调用时触发(见下文)
- **这不是 tool permission**——tool permission 管的是"这次工具调用能不能跑",approvalPoints 管的是"这个 phase 能不能过"

**`on_destructive_op`:tool guard,不是 approvalPoint**:
- `file_write` 覆盖现有文件、`bash` 执行 rm/git push --force 等,tool guard 判断破坏性 → 返回 `outcome:"ask"` → permission 模块调 HITL `approval`
- **Path denylist**(借鉴 loop-engineering `safety.md`,Goal/Loop 必须 NEVER 自动编辑,必须人审):
  ```
  .env / .env.* / /secrets/ / /credentials/ / /*_key / /*_secret
  .terraform/ / k8s/production/ / /migrations/(除非显式 migration loop)
  auth/ / payments/ / billing/
  ```
- 自动 merge 策略:默认禁止。允许时——注释/文档 typo OK,行为变更 NOT OK,依赖升级 NOT OK
- 这些在 tool guard 配置里声明,permission 模块强制拦截,不靠模型自觉

**agent 运行时主动请求 —— 软约束,prompt 鼓励**:agent 遇到不确定时调 HITL `question` kind 问用户。

三个触发源(Goal approvalPoints / tool permission / agent 主动)最终都走 HITL 的 3 种 kind 呈现给用户,但**触发判断在各自调用方,不在 HITL**。HITL 只管被调用后呈现+拿决策。

**统一 Approval Queue**:全局 Dashboard 集中(跨项目/Goal/Loop)+ Goal 详情就地,两端都能操作。每条 HITL 指向来源 session,点击跳转。

**HITL 是与 Goal 平级的服务**,不是 Goal 的子模块。Goal 的 done-checker 依赖 HITL 回答 `user_confirmed`。HITL 可在任意 session(主或子)弹出。HITL **不合并**现有 `PermissionService`/`AskUserService`——它们保持不变,HITL 是新增的独立 service。

### 4.4 6-agent 架构(4 core + 2 ancillary)

| 角色 | 类型 | 职责 | 关键约束 |
|---|---|---|---|
| **orchestrator** | core | 拥有 Goal,委派,决策,与架构师对话 | 全工具 + 委派 |
| **plan** | core | 想清楚要做什么 | 只读 + lsp + web_fetch |
| **build** | core | 实现代码 | 读写工具 |
| **reviewer** | core | 默认拒绝,用证据判完成 | 只读 + lsp + 跑测试 + `goal_check_done`,**独立 session store** |
| **explore** | ancillary | 代码库检索 | 只读 grep |
| **librarian** | ancillary | 外部文档/库检索 | web_fetch + MCP |

**工具集在 agent 定义里硬编码** —— orchestrator **不能**在委派时修改子 agent 工具集。这是安全边界,不是装饰。

**Reviewer 的核心差异化**:
- **强制**(orchestrator 不能跳过)
- **独立 session store**(不共享 Build 的,避免被带偏)
- **能跑工具**(lsp_diagnostics / tests / grep / git_diff / goal_check_done)—— 核心差异化 vs Claude Code `/goal` evaluator(不调工具,只读对话)
- **默认拒绝 + 5 点检查清单**(全部通过才 APPROVE):
  1. Scope —— 只改了相关文件,没碰 denylist,没有无关 diff
  2. Intent —— 改动确实针对声明的目标
  3. Tests —— **实际跑测试**(不信 implementer 声称"测试过了")
  4. No cheating —— 没禁用测试/跳过断言/注释掉检查
  5. Risk —— medium 以上风险即使测试过了也建议人审

**其他 persona** 作为 `delegate` 参数(product manager / spec writer / critic 等),影响 system prompt 语气,不影响工具集。

### 4.5 Workflow 退役

**决策:彻底删除,无 fallback**。

删除:3 个硬编码 workflow type、8-stage flow、7 个 workflow 角色 agent、8 个 workflow 工具、Workflow FSM guards、PipelineStepper/StateTab UI。

**8 个硬约束迁移**(不丢弃,迁移到新原语):
- Tool permissions per role → agent definition 工具集硬编码
- Transition graph validity → **Goal phase 转换 guard**(plan→build→review 显式 phases,approvalPoints 是转换门)
- Artifact prerequisites → Goal `doneConditions: [file_exists]`
- User approval gate → HITL `approval` + Goal `doneConditions[user_confirmed]`
- Critic retry limit → Goal `retryPolicy.maxRetries`
- Unresolved interactions block → HITL pending check + Goal gate
- No concurrent workflows → Goal session binding
- Stage completion recording → **Goal phase 持久化**(`goal.json` 记录 `currentPhase`,UI 可视化进度)

### 4.6 Loop 预设库(可选起点,不强制)

7 个预设作为快捷起点,不是硬编码分类:
- `daily_triage` —— 每日 CI/issue/commit triage,报告为主
- `pr_babysitter` —— PR watch/status/comment,可选交给 fix Goal;不 merge/rebase/approve/force-push
- `ci_sweeper` —— CI 失败最小修复
- `dependency_sweeper` —— 依赖/漏洞更新带人审门
- `post_merge_cleanup` —— merge 后清理
- `changelog_drafter` —— changelog 自动起草
- `issue_triage` —— issue 去重/打分/建议标签

用户可选预设(加载默认 phases/gates/budget)或完全自定义。Runtime 不依赖预设 enum 做代码分支。

### 4.7 Web UI:Mission Control

**主导航(跨项目优先)**:
- **Dashboard**:跨项目 Mission Control —— Active Goals / Active Loops + budget 仪表 / 全局 Approval Queue / 近期活动
- **Projects**:点进项目看 Goals / Loops / Sessions / Memory

**Goal 详情 tabs**:Overview(Done 条件 + 进度)/ Plan / Build / Review / Chat(主 session 对话)/ Sessions(子 session 列表 + retry 链)

**Loop 详情 tabs**:Config / Live Status(预算仪表)/ Run History / State(可编辑)

**Approval Queue**:集中(全局)+ 就地(Goal 详情)两端,每条指向来源 session。

---

## 5. 优先级与分阶段

按 **MVP 思想**开发:每个阶段交付一个可用的用户价值,不是按 loop-engineering readiness levels(L0-L3 是 Loop 成熟度模型,不是产品开发顺序)。**先做 Goal,再做 Loop**——Goal 是核心价值(架构师画蓝图 → AI 执行 → 机检证明完成),Loop 是 Goal 的重复执行,需要 Goal 先跑通。

### 阶段 1:Goal MVP(最小可验证)

**目标**:能跑通一个完整 Goal = 验证"架构师设计意图 → AI 执行 → 机检证明完成 → 架构师审查"核心闭环。

- 三层原语:Goal/Session(HITL 跟着 Goal 一起做,因为 approvalPoints + done `user_confirmed` 依赖它;Loop 暂不做)
- Done Conditions 7 种 machine + 1 HITL kind(Layer 1)
- HITL 3 种 kind(question/approval/review)+ 统一 Approval Queue(新增 HitlService,不合并现有 PermissionService/AskUserService)
- 6-agent 定义(orchestrator/plan/build/reviewer/explore/librarian),工具集硬编码
- **Reviewer day-one 强制**(orchestrator 不能跳过,`reviewed` 是 `done` 前置)
- Reviewer 默认拒绝 + 5 点检查清单
- Goal 状态机:draft→locked→running→verifying→reviewed→completed/failed/escalated + 显式 phases(plan→build→review)
- Goal 执行:lock → orchestrator 自主分解 → 委派 plan/build/reviewer → done check → retry(fresh session)
- approvalPoints:`after_plan` / `before_complete`(Goal phase 转换门);`on_destructive_op` 是 tool guard(不是 approvalPoint)
- `goal_check_done` 工具
- AI 可生成 Done 条件(包括 `command_succeeds`),用户 lock 确认后生效;`goal.json` 记录 author + lockedBy
- Workflow 删除(code 一次性删,用户数据 `.archcode/workflows/` 保留只读)
- Web UI:Goal 列表 + 详情(Overview/Plan/Build/Review/Chat/Sessions)、Approval Queue(集中+就地)、项目导航
- **Dashboard**(跨项目 Mission Control):Active Goals + Approval Queue(REST 初始快照 + SSE 增量;遍历 `ProjectRegistry.list()` + 各项目 `.archcode/goals/` 文件聚合)

### 阶段 2:Goal 完善(日常可用)

**目标**:Goal 体验完整,架构师可日常依赖 Goal 做真实工程工作。

- retry/fresh-context retry 完整:`retryPolicy`/`retryState` 持久化 `maxRetries`、`backoffMs`、`nextRetryAt` 和 exhausted escalation;到期 retry 可在 runner/service 重建后恢复。
- `spec_compliance` Done 条件由 Reviewer 在 `goal_check_done` 下产生结构化逐 criterion 证据;不保存 raw LLM 输出,不加单独 spec agent/model/config。
- Reviewer 验证是硬边界:`goal_check_done` 仅 Reviewer review session 可用;外部 verdict 只有 `DONE` / `NOT_DONE`,其中 `NOT_DONE` 生成 Operator 修复上下文并进入现有 failed/retry/escalated 流程。
- Goal artifacts 是当前 canonical Markdown 文件:`plan.md`,`build.md`,`review.md`,`spec-compliance.md`,`approvals.md`,`budget.md`,`retry-log.md`,`final-report.md`;不做 artifact version/revision/latest 指针。
- Approval Queue 完整:durable、project-scoped、全局 Dashboard + 就地列表同步;Web/Dashboard 使用 redacted `displayPayload`,不展示 raw payload。
- Goal budget 基础:per-Goal token 上限 + warning/hard pause;只统计 token,不做价格/cost accounting。
- Goal memory 接通 Plan/Build/Review prompt,且与 Project memory 隔离;不自动 promotion/transfer。
- Phase 2 不新增 `.archcode.json` budget/retry schema 字段或默认值;budget/retry 是 Goal 创建输入和持久化 Goal state。
- Legacy workflow runtime/tool/routes 已移除;Goal/HITL/artifact API 是当前实现路径。

### 阶段 3:Loop MVP(可跑通)

**目标**:Loop 第一次可跑——架构师能设定"定期跑某任务",自动执行 + 报告。先跑 Session,再跑 Goal。

- Loop 三层原语:Schedule + Cross-run State + Budget 基础
- Loop 可跑 Session(简单重复任务)或 Goal(复杂重复任务带 done + reviewer)
- LoopScheduler:`interval` + `manual`(cron/trigger 留阶段 5)
- Loop 预设库 7 个(作为快捷起点,不强制)
- run-log JSONL 持久化
- 跨 run state(state.json source of truth + state.md 只读视图)
- Web UI:Loop 列表 + 详情(Config/Live Status/Run History/State)
- Dashboard 增加 Active Loops 区块

### 阶段 4:Loop 完善(日常可用)

**目标**:Loop 可日常依赖做重复性维护工作,有护栏不怕跑飞。

- Budget 护栏:throttle/hardStop 早退 + stagnation circuit breaker
- kill switch(全局 + per-loop)
- 碰撞检测(acting_on 字段 + 优先级)
- Superseded/current Phase 4 简化:旧稿里的 L1→L2 毕业、noise <20%、readiness score 只保留为未来 advisory 参考,不是当前 runtime gate
- Phase 4 当前 runtime 护栏:Budget hardStop/throttle、kill switch、collision guard、GitHub.com + GitHub Actions 状态读取
- 这些护栏是 pre-run/tool guard/runtime checks,不是第二套 permission system,也不替代现有 tool permission/HITL approval pipeline;Loop 仍只是调度/state/guardrail 容器,实际执行层是 Session/Goal + tools
- Loop 预设库 BudgetSpec 默认值(来自 loop-engineering cost registry)
- Loop 详情 UI 完整(budget 仪表、run-log 可视化、state 编辑器)

### 阶段 5:进阶

**目标**:无需人盯的 unattended Loop 完整能力。拆必需 + 可选两部分。

**Phase 5a 候选方向**(不属于 Phase 4 承诺):
- `cron` + `trigger` 调度(on_commit/on_pr/on_ci_fail)
- 跨 loop 协调、队列、同分支节流、maxConcurrent
- git worktree 隔离执行

**Phase 5b 候选方向**:
- 用户自定义 pattern
- Loop 自清理
- readiness score(Web UI badge),未来 advisory 指标,不是当前 gate

**External integrations**(Phase 4):只接 GitHub.com + GitHub Actions,让 pr_babysitter / ci_sweeper / issue_triage 等预设能读取状态和评论。GitHub Enterprise、GitLab、Bitbucket、CircleCI、Jenkins、OAuth、GitHub App、浏览器安装授权留后续。

---

## 6. 成功标准

### 6.1 产品级成功标准

| 标准 | 衡量方式 |
|---|---|
| 架构师能跨项目监督 AI 编码工作 | Dashboard 一屏看全 active goals/loops/approvals |
| 架构师能合上笔记本工作继续 | 持久 server + SSE,回来看到完整 run-log + evidence |
| AI 不能虚假完成 | Done 条件机器可检,Reviewer 独立 + 能跑工具 + 默认拒绝 |
| AI 不能 token 烧穿 | Budget hardStop + kill switch + stagnation breaker |
| 重复性维护可委派给 AI | Loop 跑 triage/fix/verify,人审门控风险 |
| 代码不出域 | 自托管 + BYOM + 全透明审计 |
| 长任务可恢复 | Session 持久化 + Goal/Loop state git 可跟踪 |

### 6.2 差异化验证(vs Claude Code/Cursor/Devin)

| 维度 | ArchCode | 竞品 |
|---|---|---|
| Done 条件 | 机器可检 + Reviewer 跑工具 | Claude Code:evaluator 不调工具,只读对话 |
| 跨会话 state | 项目内 git 可跟踪,state.md 人类可读 | Claude Code:session-scoped 7 天过期;Routines 云端黑盒 |
| Budget | 结构化代码强制(throttle/hardStop) | Claude Code:ad-hoc 文本 |
| Maker/Checker split | 独立 agent + 独立 store + fresh-context retry | Claude Code:固定 evaluator 模型自检 |
| 自托管 | ✅ | Devin/Factory:❌ 云端 SaaS |
| 谁拥有意图 | 架构师设计,AI 执行 | Devin:AI 决定 |

---

## 7. 约束

### 7.1 产品约束

- **自托管优先**:单进程部署是当前模型,不引入独立 worker(v3 视扩展)
- **BYOM**:每个 agent 角色可配不同模型,未配置 fail-fast
- **代码不出域**:不依赖云端 AI 工程师 SaaS
- **Talk in chinese, code in english**(含注释)

### 7.2 设计约束

- **Done 条件运行前锁定,运行中不可变**(铁律 1)
- **Reviewer ≠ Implementer,独立 session store**(铁律 2)
- **Loop ≠ 自主改进项目**(铁律 3)
- **工具集在 agent definition 硬编码**(安全边界)
- **Workflow 彻底删除,无 fallback**
- **Config schema 用 Zod `.strict()`**,改 schema 必须同步更新 README.md config 文档

### 7.3 技术约束(细节在 TDD)

- Runtime:Bun(不是 Node)
- TypeScript strict mode,ES2022,bundler module resolution,import 不带 `.js` 扩展
- Test runner:`bun:test`,colocated `<name>.test.ts`
- 自定义错误类:extend Error,typed constructor,`this.name = "ClassName"`
- Barrel exports via `index.ts`
- Prefer Bun-native APIs over `node:*`(除非 Bun 无替代)

---

## 8. 反范围(不做什么)

### 8.1 产品反范围

- ❌ 不做"AI 写代码更好"(不与 Cursor/Claude Code 竞争编辑/补全)
- ❌ 不做"自主 AI 工程师"(不与 Devin 竞争"派 ticket 给 AI")
- ❌ 不做"终端体验"(不与 Warp/Claude Code 竞争 CLI)
- ❌ 不做"ship 产品"(不与 Lovable/Bolt 竞争 app builder)
- ❌ 不做"loop 自主改进项目"(误用,不是功能)

### 8.2 功能反范围

- ❌ 不做 cron/trigger 调度(Phase 5a 必需,非反范围,但不在 Phase 1-4)
- ❌ 不做用户自定义 pattern(Phase 5b 可选,预设库已足够起步)
- ❌ 不做独立 worker 进程(单进程足够)
- ❌ 不把缺失 model pricing 当零成本。provider model pricing 是可选 metadata;缺失时 USD budget enforcement 不可用。
- ❌ Phase 2 不做 checkpoint/rollback/rerun 功能
- ❌ Phase 2 不做 artifact versions/revisions/latest 指针
- ❌ Phase 2 不做 Safe/Balanced/Brave approval modes
- ❌ 不做 headless / daemon 部署模式(用户自行部署到 always-on 主机)
- ❌ 不做 OpenHands 式训练 critic 模型(研究阶段,成本高)
- ❌ 不做 Kiro EARS notation + property testing(太正式,IDE 中心)
- ❌ 不做 Workflow 渐进迁移(全删无 fallback)
- ❌ 不做 state.md 双向同步(state.json 是 source of truth,state.md 只读视图)
- ❌ 不做 AI merge/rebase/approve/force-push PR。PR Babysitter 只 watch/status/comment,可选交给 fix Goal。
- ❌ 不做 AI `git push` / `git merge` / `git rebase` / `git reset --hard`(bash guard 拦截,人审)
- ❌ Phase 4 不支持 GitHub Enterprise、GitLab、Bitbucket、CircleCI、Jenkins、OAuth、GitHub App 或浏览器安装授权。
- ❌ 不引入 Mission 原语(保持 Session/Goal/Loop 三层,后续视需要评估)

---

## 9. 竞争格局

### 9.1 2026 产品格局:7 类已占,第 8 类空白

| 类别 | 口号 | 占据者 | ArchCode 适配 |
|---|---|---|---|
| Agent Control Plane | "OS for agents" | OpenHands, MS Agent 365 | 中 |
| Spec-Driven Dev Env | "Plan before code" | Kiro, Augment Intent | 强 |
| Cloud Agent Queue | "派 ticket → 合 PR" | Codex Cloud, Cursor Cloud, Devin | 弱 |
| Terminal ADE | "终端即 IDE" | Warp, Cline 2.0, Claude Code | 中 |
| App Builder / Deploy | "ship 产品" | Totalum, Lovable, Bolt | 超出范围 |
| Agent Governance | "SOC 2 for agents" | MS Agent 365, OpenHands | 采购类别 |
| Multi-Agent Workspace | "AI 团队指挥中心" | Augment Cosmos, Factory | 强 |
| **Architect Workbench** | **"You architect. AI codes."** | **无** | **最佳——名字本身编码了这个定位** |

### 9.2 为什么竞争者无法占据

- **Claude Code / Codex CLI**:开发者本地工具,重力在终端+单 repo 交互
- **Cursor**:IDE,重力在编辑器+亲手写代码
- **Devin / Factory**:云端自主工程师 SaaS,黑盒,不可自托管
- **OpenHands**:agent control plane,重力在跑 agent,不是架构师工作流
- **Kiro**:spec-driven IDE,最接近但 EARS 太正式,仍是 IDE 中心

### 9.3 Goal/Loop 不是独家

**重要事实**:Claude Code 也有 `/goal` 和 `/loop`,且概念**不是 Anthropic 发明**。
时间线:社区(Huntley Ralph, 2025-07)→ OpenAI Codex `/goal`(2026-04-30)→ 社区命名 Osmani(2026-06-07)→ Anthropic Claude Code `/goal`(2026-06 中,迟到)。

**ArchCode 差异化在工程深度,不在"有没有"**:
1. 机器可检 Done 条件(Reviewer 跑工具,不只读对话)
2. 跨会话 git 可跟踪 state(不是 session-scoped 7 天过期)
3. 结构化 Budget(代码强制,不是 ad-hoc 文本)
4. 显式 Maker/Checker split + fresh-context retry
5. 自托管(vs Routines 云端黑盒)
6. 可编程原语(Protocol types + Config schema)vs CLI 命令

---

## 10. 风险与缓解(产品级)

| 风险 | 严重度 | 缓解 |
|---|---|---|
| AI 虚假完成 | S1 | 机器可检 Done 条件 + 独立 Reviewer + 默认拒绝 + 能跑工具 |
| Infinite fix loop | S1 | `retryPolicy.maxRetries` + 超限 escalate |
| Token burn | S1 | Budget hardStop + kill switch + stagnation breaker + 心跳超时 pause |
| Reviewer theater(Reviewer 形同虚设) | S1 | 强制独立 session store + 工具集硬编码 + 默认拒绝 prompt + 5 点检查清单 |
| Compaction 丢 Done 条件 | S2 | Done 条件在 `goal.json` 持久化,不在对话上下文 |
| Cognitive Surrender("loop 会处理"逃避思考) | S2 | UI 强制展示 last summary + run-log + 架构师必须 review escalate |
| Comprehension debt spiral | S2 | 每次 run 产 summary + run-log;UI 强制展示 |
| Over-reach(Loop 擅自大改) | S2 | Phase 4 用 tool profile、approvalPoints、collision guard 和 kill switch 限制风险;L2 minimal-fix 是未来 advisory |
| 多 Loop 碰撞 | S3 | Phase 4 用 collision guard 阻止已知目标冲突;队列、同分支节流、maxConcurrent 是 Phase 5 候选方向 |
| Escalate 后无人看 | S3 | `waitedMs` 超期 UI 红标 + 通知 |
| HITL 断线残留 | S2 | 复用 deferred 超时/abort 安全 resolve |
| Workflow 删除回归 | S2 | `.archcode/workflows/` 保留只读(不删用户数据),runtime 不再读写 |

---

## 11. 配套文档

- **技术设计(TDD)**:`docs/workbench-refactor/TDD.md` —— Protocol 类型、Config schema、Server 路由、Scheduler 实现、Web UI 组件、触点清单
- **loop-engineering 借鉴分析**:TDD §15 —— 借鉴什么/不借鉴什么/ArchCode 优势
- **AGENTS.md**:项目约定、命令、架构、测试模式

---

## 12. 已决策项(实现时参考)

以下在 TDD 里有推荐答案,设计阶段已全部决策锁定:

1. **Reviewer 是新增 agent** —— 新建 `reviewer` agent 定义,工具集硬编码(read-only + lsp + goal_check_done 内部白名单执行),独立 session store(决策 2026-06)
2. **state.md 只读视图** —— state.json 是 source of truth,state.md 是生成视图,不做双向同步。用户编辑 state 通过 UI form(JSON-backed)或 `PATCH /loops/:id/state` API(决策 2026-06)
3. **L0 起步范围** —— Phase 1 只做 Goal(不做 Loop)。Goal 单独有价值且风险低。Loop 留 Phase 3(决策 2026-06)
4. **Workflow 用户数据保留只读** —— `.archcode/workflows/` 目录保留,runtime 不再读写,不删用户数据。迁移工具后续提供(决策 2026-06)
5. **预设 pattern 的 BudgetSpec 默认值** —— 用 loop-engineering cost registry 的数字作为起点,实现时按实际调整(决策 2026-06)
6. **Goal phases 承认** —— Goal 有显式 phases(plan→build→review),持久化到 goal.json,approvalPoints 是 phase 转换门(决策 2026-06)
7. **Reviewer day-one 强制** —— Phase 1 起 Reviewer 强制,不分阶段(决策 2026-06)
8. **HITL 不合并** —— 保留 PermissionService + AskUserService 不动,新增 HitlService。Phase 2 使用 durable project-scoped queue;旧 live Promise 不恢复,但 pending record 可通过 deterministic key 复用(Phase 2 实现更新,2026-07)
9. **command_succeeds AI 可生成** —— AI 可生成所有 Done kind(含 command_succeeds),用户 lock 确认后生效。安全由"用户 lock + Reviewer 独立验证 + bash guard"三层保证。goal.json 记录 author + lockedBy(决策 2026-06)
10. **Dashboard 留 Phase 1** —— 遍历 ProjectRegistry.list() + 各项目 .archcode/goals/ 文件聚合,REST 初始快照 + SSE 增量,不需新存储(决策 2026-06)
11. **Phase 3 Loop 允许 action loop** —— 允许 Loop 跑 Goal(可改代码),靠 Reviewer 强制 + approvalPoints + 基础 budget 兜底。Phase 4 补完整护栏(throttle/hardStop/stagnation/kill switch)后才真正可无人看(决策 2026-07)
12. **Phase 5 拆候选方向** —— cron/trigger、跨 loop 协调、队列、worktree、自定义 pattern、自清理、readiness score 都是 Phase 4 之后再评估,不是当前承诺(决策 2026-07,Phase 4 文档更新 2026-07)
13. **Phase 4 加第一批 external integrations** —— 只支持 GitHub.com(PR/issue)+ GitHub Actions 状态 connector,让 pr_babysitter / ci_sweeper / issue_triage 等预设可读取状态和评论。Phase 3 只本地预设可用(决策 2026-07,Phase 4 文档更新 2026-07)
14. **不引入 Mission,但留占位** —— 保持 Session/Goal/Loop 三层。TDD 留"未来扩展点:Mission 原语"占位节,后续单个 Goal 不够大功能场景再评估(决策 2026-07)
15. **Workflow 硬切迁移** —— Phase 1 同步删 code + 6-agent 立即 required。用户数据 `.archcode/workflows/` 保留只读。ProjectContext refactor 是高风险区,需扎实 acceptance test(决策 2026-07)
16. **Budget pricing 边界** —— provider model pricing 是可选 metadata;缺失 pricing 时 USD budget enforcement 不可用,不能当零成本。token/iteration 护栏仍可用(决策 2026-07,Phase 4 文档更新 2026-07)
17. **AI 自治边界** —— AI 可 commit 到本地,人 push + 开 PR。AI 永不 merge/rebase/approve/force-push。bash guard 拦截 git push/merge/rebase/reset --hard。Phase 4 connector 只做 GitHub.com/GitHub Actions 的状态、评论和可选 fix Goal handoff(决策 2026-07,Phase 4 文档更新 2026-07)
18. **self-hosted 不加 headless 模式** —— 用户自行部署到 always-on 主机,ArchCode 不做 headless/daemon 模式,文档指引即可(决策 2026-07)
