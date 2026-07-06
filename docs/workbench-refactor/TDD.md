# ArchCode 技术设计文档(TDD)— Architect Workbench

> **本文档是 ArchCode 的技术设计(TDD)**,包含 Protocol 类型、Config schema、Server 路由、Scheduler 实现、Web UI 组件、触点清单等实现层细节。
> **配套的产品需求文档(PRD)在 `docs/workbench-refactor/PRD.md`** —— 那里定义"做什么、为谁做、为什么",这里定义"怎么实现"。
> 阅读顺序:先读 PRD(产品意图)→ 再读本 TDD(技术方案)。

**状态**:技术设计,描述完整实现方案。实施按 5 阶段(先 Goal 后 Loop)分步,由用户根据 PRD 拆任务执行。Phase 2 Goal 当前实现边界见 §11.2。
**取代**:`docs/plan/session-loop-goal-design.md`(本 TDD 是其超集+定位升级+Workflow 全退役决策)。
**约定**:Talk in chinese, code in english(含注释)。
**术语**:"架构师"指 ArchCode 的用户(见 PRD §2),不是 AI agent;"AI""agent"指 ArchCode 编排的编码执行者。

---

## 目录

1. [产品定位](#1-产品定位architect-workbench)
2. [三层原语:Session / Goal / Loop](#2-三层原语session--goal--loop)
3. [Done Conditions:混合两层](#3-done-conditions混合两层)
4. [HITL:横切关注点](#4-hitl横切关注点)
5. [6-agent 架构](#5-6-agent-架构4-core--2-ancillary)
6. [Workflow 退役](#6-workflow-退役)
7. [Config schema 重设计](#7-config-schema-重设计)
8. [Protocol 类型](#8-protocol-类型)
9. [Server 路由 + Scheduler](#9-server-路由--scheduler)
10. [Web UI:Mission Control](#10-web-uimission-control)
11. [分阶段路线(MVP,先 Goal 后 Loop)](#11-分阶段路mvp-思想先-goal-后-loop)
12. [风险目录与缓解](#12-风险目录与缓解)
13. [触点清单](#13-触点清单)
14. [不做什么](#14-不做什么)
15. [附录:loop-engineering 借鉴](#15-附录loop-engineering-借鉴)

---

## 1. 产品定位:Architect Workbench

### 1.1 一句话定位

**ArchCode 是资深工程师/架构师把架构意图转化为受监督 AI 编码执行的自托管工作台。**

更锋利的市场版本:**You architect. ArchCode runs the AI engineering loop.**

### 1.2 目标用户

**不是**"想写得更快的个人开发者"(那是 Cursor/Claude Code 的战场)。
**是**"管理多个代码库、需要委派真实工程工作给 AI、监督进度、审批关键操作、保留项目记忆、通过 Web 审查产物的资深工程师/架构师/技术 lead"。

用户画像:
- 手上有 3-10 个 repo,有些是生产系统,有些是实验项目
- 不想(也不应该)亲自写每一行代码,但必须掌控方向和质量
- 需要能在自己的基础设施里跑(自托管、BYOM、代码不出域)
- 需要能"合上笔记本,工作继续;回来看到机器可检证据,决定 merge/retry/escalate"
- 需要能给重复性维护工作(CI triage、PR babysit、依赖更新)设定"自动跑但有人审门"的循环

### 1.3 核心交互

```
1. 架构师设计意图 → Goal(不可变 Done 条件 + 独立 Reviewer)
2. ArchCode 分解 → plan / build / review 任务
3. AI agents 执行 → 架构师不写代码
4. 架构师监督 → Web UI 显示进度,审批关键操作,审查证据
5. 架构师合上笔记本 → 工作继续,Budget 护栏,SSE 推送通知
6. 回来审查 → Reviewer 提供机器可检完成证据,架构师决定 merge/retry/escalate
```

### 1.4 为什么这个定位能支撑一个产品(不是一个 feature)

| 错误思路(Feature 思维) | 正确思路(Product Idea 思维) |
|---|---|
| "我们有 token budget" | "架构师能合上笔记本,工作不会烧钱" |
| "我们有 certified compaction" | "架构师的 Done 条件能扛过 compaction" |
| "我们有 verification" | "架构师不亲自 review,AI 用证据证明完成" |
| "我们有 multi-agent" | "架构师指挥 plan/build/review,不写代码" |

Feature = "我们有 X"。Product Idea = "你是 Y,ArchCode 让你做 Z"。
Architect Workbench 改变的是**用户是谁**:不是"写代码更快的人",而是"设计意图并监督执行的人"。

### 1.5 2026 产品格局:7 类已占,第 8 类空白

| 类别 | 口号 | 占据者 | ArchCode 适配 |
|---|---|---|---|
| Agent Control Plane | "OS for agents" | OpenHands, MS Agent 365 | 中 |
| Spec-Driven Dev Env | "Plan before code" | Kiro, Augment Intent | 强 |
| Cloud Agent Queue | "派 ticket → 合 PR" | Codex Cloud, Cursor Cloud, Devin | 弱 |
| Terminal ADE | "终端即 IDE" | Warp, Cline 2.0, Claude Code | 中 |
| App Builder / Deploy | "ship 产品,不是 ship 文件" | Totalum, Lovable, Bolt | 超出范围 |
| Agent Governance | "SOC 2 for agents" | MS Agent 365, OpenHands | 采购类别 |
| Multi-Agent Workspace | "AI 团队指挥中心" | Augment Cosmos, Factory | 强 |
| **Architect Workbench** | **"You architect. AI codes."** | **无** | **最佳——名字本身编码了这个定位** |

**空白**:没有产品明确说"你是架构师,这是你的工作台,AI 在你的指挥下写代码"。ArchCode 的名字本身包含这个想法。

### 1.6 为什么竞争者无法占据这个位置

- **Claude Code / Codex CLI**:开发者本地工具,重力在终端+单 repo 交互
- **Cursor**:IDE,重力在编辑器+亲手写代码
- **Devin / Factory**:云端自主工程师 SaaS,黑盒,不可自托管,不透明
- **OpenHands**:agent control plane,重力在跑 agent,不是架构师工作流
- **Kiro**:spec-driven IDE,最接近但 EARS notation 太正式,仍是 IDE 中心
- **Augment Intent**:接近但无明确"架构师"定位

### 1.7 与 Goal/Loop 的关系(澄清:不是独家)

**重要事实**:Claude Code 也有 `/goal` 和 `/loop`,且 Goal/Loop 概念**不是 Anthropic 发明**。
时间线:社区(Huntley Ralph, 2025-07)→ OpenAI Codex `/goal`(2026-04-30)→ 社区命名(Osmani, 2026-06-07)→ Anthropic Claude Code `/goal`(2026-06 中,迟到)。

**ArchCode 的差异化在工程深度,不在"有没有"**:
1. **机器可检 Done 条件**:Reviewer 能跑 `bun test`/`grep`/`lsp_diagnostics`,不只是读对话。Claude Code `/goal` evaluator 官方文档:"It does not call tools, so it can only judge what Claude has already surfaced in the conversation."
2. **跨会话 git 可跟踪 state**:`.archcode/loops/{id}/state.md` + `state.json`,用户能手动 unstick。Claude Code `/loop` 是 session-scoped 7 天过期,Routines 是云端黑盒。
3. **结构化 Budget**:`maxIterationsPerRun`/`maxTokensPerDay`/`throttleAtPct`/`hardStopAtPct`,代码强制。Claude Code 是 ad-hoc 文本。
4. **显式 Maker/Checker split + fresh-context retry**:独立 agent 定义 + 独立 session store + 每次重试换新上下文。Claude Code 是固定 evaluator 模型自检。
5. **Loop budget 早退**:`throttleAtPct: 80` → report-only;`hardStopAtPct: 100` → hard stop。
6. **自托管**(vs Routines Anthropic 云端)。
7. **可编程原语**(Protocol types + Config schema)vs CLI 命令。

### 1.8 反向验证:不是 Devin/Factory

| 维度 | Devin/Factory | ArchCode |
|---|---|---|
| 谁拥有意图 | Devin 的 AI 决定 | **架构师设计,AI 执行** |
| 透明度 | 黑盒 SaaS | **全透明、可审计** |
| 自托管 | ❌ | ✅(企业硬需求) |
| 模型控制 | 厂商锁定 | **BYOM,per-agent-role 配置** |
| 监督 | "委派后等待" | **持续监督 + 关键审批 + 实时观察** |
| 失败模式 | 不知道发生了什么 | **完整 session 树 + 审计日志 + retry/escalate 记录** |

Devin = "委派给远程 AI 员工"。ArchCode = "架构师在自己的基础设施里指挥 AI 团队"。不同产品类别。

### 1.9 不竞争什么

- 不争"AI 写代码更好"(Cursor/Claude Code 战场)
- 不争"自主 AI 工程师"(Devin 战场)
- 不争"终端体验"(Warp/Claude Code 战场)
- 不争"ship 产品"(Lovable/Bolt 战场)

### 1.10 竞争什么

**"架构师如何用 AI 完成软件工作"** —— 没人占据这个位置。
产品不是"更快的 coding agent",而是"把意图转化为受监督 AI 编码执行的工作台"。

---

## 2. 三层原语:Session / Goal / Loop

### 2.1 严格定义

| 原语 | 一句话 | 必备要素 | 终止条件 |
|---|---|---|---|
| **Session** | 一次对话,你掌控 | 对话上下文 + 工具执行 | 你说停就停 |
| **Goal** | Session + (1) 机器可检 Done 条件 (2) 独立 Reviewer (3) 失败换新上下文重试 | Done 条件**运行前锁定、运行中不可变** + Reviewer ≠ Implementer | Done 条件机检全 true,或重试上限耗尽 |
| **Loop** | Goal/Session + 调度 + 跨 run State + Budget | Schedule + 跨 run 持久 State + 预算上限 + 多层早退 | 被杀 / 预算耗尽 / 自清理 / 人审挂起 |

```
Session  ─── +Done+Reviewer+Retry ───►  Goal  ─── +Schedule+State+Budget ───►  Loop
```

### 2.2 三条铁律(来自社区失败案例)

1. **Done 条件锁死**:谁写不重要,**何时锁**才重要。运行前锁定,运行中不可变。完成判定走机器可检,不走人类主观判断。
2. **Reviewer ≠ Implementer(非协商 maker/checker split)**:Reviewer 默认拒绝,必须用证据说服它放行。同一 agent 实例自检 = 形同虚设(Reviewer theater)。
3. **Loop ≠ 自主改进项目**:Loop = 自动化你本来就会做的重复性维护/卫生工作。把 Loop 当成"让 agent 自由改进代码库"是最常见误用,也是 $47K 失控案例的根源。

### 2.3 Session 层级

**Goal 的 session 树**:
```
Goal
 └─ main session (orchestrator,架构师对话在这里)
     ├─ child session: plan (read-only + lsp + web_fetch)
     ├─ child session: build (read + write tools)
     ├─ child session: reviewer (read-only + lsp + bash readonly + git_diff + tests_run + goal_check_done,独立 session store)
     ├─ child session: explore (read-only codebase grep)
     └─ child session: librarian (external docs/MCP)
```

- **main session**:orchestrator 拥有,架构师在这里对话。Chat tab = main session 对话视图。
- **child sessions**:plan/build/review/explore/librarian,每个独立 session store。Sessions tab = 子 session 列表(retry 链 + 委派树)。
- **HITL 可在任意 session 弹出**,统一 Approval Queue,每条指向来源 session,点击进入该 session 上下文处理。

### 2.4 Loop 的澄清(不是 Goal 超集)

**Loop 是调度容器,可跑 Session 或 Goal**:
- Loop = Schedule + Cross-run State + Budget + (Session | Goal)
- 简单重复任务 → Session(无需 Done + Reviewer)
- 复杂重复任务 → Goal(带 Done + Reviewer)

例:每日 triage 报告用 Session 足够;每日依赖扫描+安全补丁用 Goal(`tests_pass` + `command_succeeds` Done 条件 + Reviewer 审)。

### 2.5 简单任务不需要 Goal

用户随时可以开一个**顶层独立 Session**(不归属任何 Goal/Loop),与 loop-spawned session 平级。保留"随便聊一句"的轻量体验。强制归属会增加创建摩擦。UI 用 `goalId?`/`loopId?` 可选字段区分。

---

## 3. Done Conditions:混合两层

### 3.1 为什么是混合(不是纯 AI,也不是纯硬编码)

- **纯 AI 自判不可靠**:Steinberger/SonarSource 警告"slop machine"。Claude Code `/goal` evaluator 官方文档承认"It does not call tools, so it can only judge what Claude has already surfaced in the conversation."
- **纯硬编码不够**:Osmani/Greyling 显示需要 maker/checker split + AI 判断。Castor 的 5 enum 是有效模式,但 spec 符合度判断仍需 AI。
- **结论**:Layer 1 机器可检(架构师选,Reviewer 跑)+ Layer 2 AI 判断(可选,Reviewer 读 spec+代码+跑工具)。

### 3.2 Layer 1:机器可检(7 machine + 1 HITL)

架构师在 Goal draft 阶段选择(AI 可生成),lock 后不可变。Reviewer 通过 `goal_check_done` 工具执行。

| kind | params | 机检实现 | 来源 |
|---|---|---|---|
| `tests_pass` | `{ command?: string }` | 跑 `bun test`(或指定 command),exit 0 | ArchCode 原生 |
| `typecheck_pass` | `{ command?: string }` | 跑 `bun run typecheck`,exit 0 | ArchCode 原生 |
| `lsp_clean` | `{ paths?: string[], severity?: "error" \| "warning" }` | `lsp_diagnostics` 无 error(或 warning) | ArchCode LSP |
| `file_exists` | `{ path: string }` | 工作区内文件存在 | Castor `files_exist` |
| `grep_contains` | `{ pattern: string, path?: string, minMatches?: number }` | ripgrep 匹配 ≥ minMatches | Castor `regex_in_file` |
| `grep_empty` | `{ pattern: string, path?: string }` | ripgrep 无匹配(如"无 TODO""无 console.log") | ArchCode 扩展 |
| `command_succeeds` | `{ command: string, timeoutMs?: number }` | 任意 shell 命令 exit 0(**通用 fallback**) | Castor `shell_returns_zero` |
| `user_confirmed` | `{ prompt: string }` | HITL `kind="approval"`,架构师确认(**唯一非机器 check**) | ArchCode HITL |

**`command_succeeds` 是万能逃生口**:任何无法用前 7 种表达的条件,都能用一条 shell 命令表达(如"curl health check 返回 200"、"mypy 无 error"、"git status 干净")。

### 3.3 Layer 2:AI 判断(可选,1 种 kind)

| kind | params | 执行 | 来源 |
|---|---|---|---|
| `spec_compliance` | `{ specPath: string, focusAreas?: string[] }` | Reviewer 读 spec + 代码 + 跑工具,判断实现是否匹配 spec | Factory.ai Review Droid / Augment Intent Reviewer |

- **可选**:简单 Goal(如"加个 util 函数")不需要。
- **复杂 Goal 必用**:如"重构 auth 模块保持向后兼容"——机检只能查测试通过,但 spec 符合度需要 AI 读 spec 对比实现。
- **默认拒绝 prompt**:Reviewer 必须被证据说服才放行,不是"看起来差不多就过"。

### 3.4 不做什么

- ❌ **不做 OpenHands 式训练 critic 模型**:研究阶段,成本高,不实际。
- ❌ **不做 Kiro EARS notation + property testing**:太正式,IDE 中心,不匹配 ArchCode 的 workbench 定位。

### 3.5 Goal 状态机

```
draft ──lock──► locked ──run──► running ──verify──► verifying
                                         │              │
                                         │   done all true
                                         │              ▼
                                         │          completed
                                         │
                                         │   any false + retry left
                                         ▼              │
                                       failed ──retry──► running (fresh session)
                                         │
                                         │   retry exhausted
                                         ▼
                                     escalated (等人审)
```

**Goal 内部 phases**(显式,持久化到 `goal.json`):
- Goal 分三个 phase:`plan` → `build` → `review`
- `phase` 字段持久化,可测试、可恢复、UI 可视化进度
- `approvalPoints` 是 **phase 转换门**:Goal runner 在 phase 切换时检查 → 命中则调 HITL `approval` → 等用户决策 → 放行或拒绝 phase 切换
  - `after_plan` = plan→build 门
  - `before_complete` = review→completed 门
  - `on_destructive_op` = build phase 内破坏性操作的 **tool guard**(不是 approvalPoint,见 §4.3)
- **这不是 Workflow 的 8-stage FSM**——只有 3 个 phase,且 phase 是 Goal runner 内部进度,不是顶层状态机节点。Goal 顶层状态机仍是 draft→locked→running→verifying→reviewed→completed/failed/escalated

- **`reviewed` 是 `done` 的前置**:Goal state machine 强制 Reviewer 通过才能进 `verifying`。Orchestrator 不能跳过 Reviewer。
- **lock 不可逆**:draft → locked 是单向。锁定后 Done 条件不可改,防止 agent 运行中偷改完成定义。
- **fresh-context retry**:每次 retry 创建新 session(不继承上次失败的上下文),避免失败上下文污染。retry 时 phase 重置为 `plan`。

### 3.6 Reviewer day-one 强制

Reviewer 从 Phase 1 起就**强制**(orchestrator 不能跳过,`reviewed` 是 `done` 前置)。没有 Reviewer 的 Goal 退化为 Session(用 Session 即可)。Goal 核心价值就是 locked Done 条件 + 独立 Reviewer 验证。

---

## 4. HITL:横切关注点

### 4.1 定位

HITL 是**与 Goal 平级的 peer service**,不是 Goal 的子模块。Goal 的 done-checker 依赖 HITL 回答 `user_confirmed` kind。HITL 可在任意 session(主或子)弹出,统一队列。

### 4.2 3 种 kind

| kind | 语义 | 机器强制点 | 整合的现有能力 |
|---|---|---|---|
| `question` | agent 主动要信息,回答回流对话 | 无选项或有选项(现有 `ask_user` 已支持 options/multiple/custom) | 替代 `ask_user` 工具 + workflow interaction 的 `decision`/`preference`/`clarification`(结构相同,合并) |
| `approval` | 某个门控层需要人审时,HITL 呈现 yes/no 并拿回决策 | 呈现 approve/deny/approve_always,拿回用户决策 | **被两个独立调用方调用**:(1) Goal 状态机的 transition guard(阶段切换时调,见 §4.3 approvalPoints)(2) 现有 tool permission guard(单次工具调用时调,guard 返回 `outcome:"ask"` → permission 模块调 HITL → 拿回决策 → 放行/拒绝/持久化)。HITL 只管"呈现+拿决策",不管"判断要不要问"(调用方的事)和"deny 后做什么"(调用方根据返回值处理) |
| `review` | 架构师批量审查产物 | outcome 是 `DONE` / `NOT_DONE`,驱动 Goal 状态机 | **新能力**,现有代码无对应 |

**为什么不是 4 种(无单独 `decision` kind)**:`decision` 和 `question` 结构相同(都可 options + recommendedOption + rationale),区别只在 agent 怎么用答案——prompt 层语义,不是 runtime 层。机器无法强制区分的不分两个 kind。

**关键澄清:`permission` 从来不是工具**。现有 permission 是 guard → DeferredPermissionService 基础设施:工具 guard(workspace/sensitive-file/bash 等)返回 `outcome:"ask"` → `ctx.confirmPermission()` → SSE `permission.request` → 用户 approve/deny/approve_always → 回流。LLM 从来不能"调用 permission"。HITL `approval` kind **被 permission 模块调用**(不是替代它)——permission 模块判断"要不要问"并调 HITL,HITL 只管"呈现+拿决策"。

`review` 是 PRD 新能力——现有代码无对应工具(workflow 的 propose/request_interactions 是"提议→批量问",不是"审查产物→verdict 驱动状态机")。

### 4.3 两个独立的门控层(都调 HITL `approval`,但触发时机和判断逻辑完全不同)

| 门控层 | 触发时机 | 谁判断"要不要问" | 谁执行 | 现有/新增 |
|---|---|---|---|---|
| **Goal approvalPoints** | Goal phase 切换(plan→build, review→completed) | Goal runner 的 phase transition guard | Goal runner 拦截 phase 切换 → 调 HITL `approval` → 拿决策 → 放行/拒绝 phase 切换 | **新增**,Goal 系统的一部分 |
| **Tool permission** | 单次工具调用(file_write/bash 等) | tool guard(workspace/sensitive-file/bash-classifier/read-before-edit)返回 `outcome:"ask"` | permission 模块调 HITL `approval` → 拿决策 → 放行/拒绝工具执行/approve_always 持久化 | **现有,不变** |

**Goal approvalPoints 是 Goal phase 转换门**(不是 tool permission):
- 架构师在 Goal 配置里声明 `after_plan` / `before_complete`
- Goal runner 在 phase 切换时检查这些点 → 命中则调 HITL `approval` → 等用户决策 → 放行或拒绝 phase 切换
- **这不是 tool permission**——tool permission 管"这次工具调用能不能跑",approvalPoints 管"这个 phase 能不能过"
- 现有 Workflow 的 `awaiting_user_approval → foreman_executing` 门就是这个模式的先例:enforcement 在 `guards.ts` `validateTransition()` check #6(阶段切换 guard),**零** tool-level permission 参与

**`on_destructive_op` 是 tool guard,不是 approvalPoint**:
- `file_write` 覆盖现有文件、`bash` 执行 rm/git push --force 等,tool guard 判断破坏性 → 返回 `outcome:"ask"` → permission 模块调 HITL `approval`
- **Path denylist**(借鉴 loop-engineering `safety.md`,Goal/Loop 必须 NEVER 自动编辑,必须人审):
  ```
  .env / .env.* / /secrets/ / /credentials/ / /*_key / /*_secret
  .terraform/ / k8s/production/ / /migrations/(除非显式 migration loop)
  auth/ / payments/ / billing/
  ```
- 自动 merge 策略:默认禁止。允许时——注释/文档 typo OK,行为变更 NOT OK,依赖升级 NOT OK
- 这些在 tool guard 配置里声明,permission 模块强制拦截,不靠模型自觉

**agent 运行时主动请求——软约束,prompt-encouraged**(第三个触发源,与上面两个门控层并列):
- agent 遇到不确定时主动调 `human_check` 工具
- system prompt 鼓励但不强制
- 用 HITL `question` kind,与硬约束使用相同队列、相同 UI

### 4.4 统一 Approval Queue

- **全局 Dashboard** 有集中 Approval Queue:跨项目、跨 Goal、跨 Loop 的所有 pending HITL
- **Goal 详情**有就地 Approval Queue:仅该 Goal 的 pending HITL
- 两端都能操作,操作一处另一处同步
- 每条 HITL 指向来源 session,点击进入该 session 上下文处理

### 4.5 复用现有 Deferred 模式(不合并 service)

**HITL 架构决策:不合并现有 service**。保留 `PermissionService`(tool permission 安全边界)+ `AskUserService`(已有 ask_user)不动。新增 `HitlService` 只管 Goal approvalPoints 和 review kind 的 queue + respond + cancel。`HitlService` 复用现有 deferred Promise + SSE 推送 + 超时/abort 安全 resolve 模式,但是独立 service。

**HITL 持久化:Phase 2 durable project-scoped queue**。pending/resolved/cancelled/timeout approval records 持久化到项目工作区 `.archcode/hitl-queue.json`。记录包含 projectSlug、goal/session scope、deterministic approval key、status、timestamps、decision payload 和 redacted `displayPayload`。

Server restart 后:
1. pending durable records 仍在 project-scoped/global list 中可见。
2. 旧进程内 Promise 不会魔法恢复;runner recovery 会把受影响 Goal 暂停或通过 deterministic key 复用同一 pending record。
3. 后续匹配的 Goal gate/tool approval 使用既有 pending record,不会创建重复 approval。

`PermissionService` / `AskUserService` 已是 session-scoped deferred Promise + SSE 推送模式。`HitlService` 复用 deferred 模式,但 durable queue 是 source of truth:
- `HitlService.request(sessionId, kind, payload, trigger)` → 持久化/复用 queue record → 推 `hitl.request` → 返回 live Promise
- `POST /api/projects/:slug/hitl/:id/respond|cancel` → 校验项目归属后 resolve live Promise 并更新 durable record
- 全局 `/api/hitl` 只做 dashboard 读取聚合;不做 by-id mutation
- API/Web 默认返回 redacted `displayPayload`,不暴露 raw payload

---

## 5. 6-agent 架构(4 core + 2 ancillary)

### 5.1 全景

| 角色 | 类型 | 工具集 | session store | 用途 |
|---|---|---|---|---|
| **orchestrator** | core | 全工具 + delegation + MCP | 自己的 | 拥有 Goal,委派,决策 |
| **plan** | core | read-only + lsp + web_fetch + grep + glob | 独立 | 想清楚要做什么 |
| **build** | core | read + write + edit + bash + lsp + ast_grep_replace | 独立 | 实现代码 |
| **reviewer** | core | read-only + lsp + git_diff + grep + glob + `goal_check_done`(内部白名单执行 tests_pass/typecheck_pass/command_succeeds) | **独立**(不共享 build) | 默认拒绝,用证据判完成 |
| **explore** | ancillary | read-only codebase grep + glob + grep | 独立 | 代码库检索 |
| **librarian** | ancillary | web_fetch + MCP(context7/grep.app/exa) | 独立 | 外部文档/库检索 |

### 5.2 关键不变量(承重)

**工具集在 agent definition 里硬编码**——orchestrator **不能**在 delegation 时修改子 agent 的工具集。这是 Workflow 原有的 tool permission boundary,迁移到 agent definition 层。这是**安全边界,不是装饰**。

### 5.3 Reviewer 的核心差异化

- **强制**:Orchestrator 不能跳过(`reviewed` 是 `done` 前置)
- **独立 session store**:不共享 Build 的 store,避免被 Build 的叙事带偏
- **能跑工具**:`lsp_diagnostics`/`grep`/`git_diff`/`glob` + `goal_check_done`(内部白名单执行 `tests_pass`/`typecheck_pass`/`command_succeeds`——Phase 1 不给通用 bash,只给 `goal_check_done` 工具,它内部按 DoneCondition kind 白名单执行)——这是**核心差异化**vs Claude Code `/goal` evaluator(不能跑工具,只能读对话)
- **默认拒绝 prompt**:必须被证据说服才放行
- **5 点检查清单**(借鉴 loop-engineering `loop-verifier/SKILL.md`,全部通过才 APPROVE,任一不过则 REJECT 或 ESCALATE_HUMAN):
  1. **Scope** — 只改了相关文件,没碰 denylist(§4.3),没有无关 diff
  2. **Intent** — 改动确实针对声明的目标,不是顺手改了别的
  3. **Tests** — **实际跑测试**(不信 implementer 声称"测试过了")。无法跑测试 → ESCALATE_HUMAN
  4. **No cheating** — 没禁用测试/跳过断言/注释掉检查/改测试期望值来通过
  5. **Risk** — medium 以上风险即使测试过了也建议人审(不自动 APPROVE)

  判决:`APPROVE` | `REJECT`(带理由) | `ESCALATE_HUMAN`(人审)

### 5.4 其他 persona 怎么办

Workflow 原有 7 角色(product/spec/critic/foreman/builder/reviewer/librarian)收缩到 4 core + 2 ancillary。其他 persona 成为 `delegate` 参数:

```
delegate(agent="plan", persona="product manager", task="...")
delegate(agent="plan", persona="spec writer", task="...")
delegate(agent="build", persona="critic", task="...")  // critic 作为 build 的 persona,不是独立 agent
```

persona 影响 system prompt 的语气和关注点,不影响工具集。

### 5.5 委派模型

- orchestrator 通过 `delegate` 工具委派
- `delegate(agent_type, persona?, task, context)` → AgentFactory → ConfiguredAgent(硬编码工具集 + 独立 store)
  - `agent_type`:orchestrator/plan/build/reviewer/explore/librarian(决定工具集)
  - `persona`:可选,影响 system prompt 语气(如 "product manager"/"spec writer"/"critic"),不影响工具集
- 子 agent 完成后 reminder 回到 orchestrator
- 深度限制:orchestrator(maxDepth=3)→ plan/build/reviewer(maxDepth=2)→ explore/librarian(maxDepth=1)

### 5.6 MCP 工具可见性

agent definition 的 `mcpTools` 字段声明可见的 MCP server:
- orchestrator: `["context7", "exa"]`
- librarian: `["context7", "grep.app", "exa"]`
- plan: `["context7"]`
- build/reviewer/explore: 无 MCP

MCP 后台加载,agents 在下次 `run()` 调用时看到新工具。

---

## 6. Workflow 退役

### 6.1 决策:彻底删除,无 fallback

用户明确指示:**"彻底重构!不要留 fallback"**。

- Workflow **code** 全删(代码、类型、工具、路由、UI 组件)
- Workflow **用户数据** `.archcode/workflows/` **保留只读**(不删用户数据,runtime 不再读写)
- 新 agent 系统取代现有 orchestrator/explore
- UI 全量重设计
- Config schema 重设计
- **不保留旧路径**,不做 v1 并存/v2 alias/v3 移除的渐进迁移
- 迁移工具后续提供(转 Workflow → Goal),不在 Phase 1 范围

### 6.2 删除范围

**完全删除**:
- `packages/agent-core/src/agents/workflow/`(整个目录:workflow-types.ts, state.ts, guards.ts, permissions.ts, tasks-format.ts, artifacts.ts, interactions-archive.ts, events.ts, linking.ts, index.ts + 所有测试)
- `packages/agent-core/src/agents/definitions/{product,spec,critic,foreman,builder,reviewer,librarian}.ts`(7 个 workflow 角色 agent 定义)
- `packages/agent-core/src/tools/builtins/workflow/`(8 个 workflow 工具:workflow_create, workflow_read, workflow_update_stage, workflow_propose_interactions, workflow_request_interactions, workflow_task_check, artifact_read, artifact_write)
- `apps/server/src/routes/workflow.ts`(如果存在)
- Web UI 的 `PipelineStepper`、`StateTab`、workflow query
- `.archcode/workflows/` 目录布局

**保留并迁移能力**(见 6.3)。

### 6.3 Workflow 8 个硬约束的迁移

Workflow 的 8 个硬执行点(prompt 不能替代的)迁移到新原语:

| Workflow 硬约束 | 迁移到 | 说明 |
|---|---|---|
| 1. Tool permissions per role | **agent definition 工具集硬编码** | plan/build/reviewer 各自工具集,orchestrator 不能改 |
| 2. Transition graph validity | **Goal phase 转换 guard**(plan→build→review 显式 phases,approvalPoints 是转换门) | 3 个 phase,不是 Workflow 的 8-stage FSM |
| 3. Artifact prerequisites | **Goal `doneConditions: [{kind:"file_exists"}]`** | 架构师声明"完成时必须有 spec.md"= Done 条件 |
| 4. Stage completion recording | **Goal phase 持久化**(`goal.json` 记录 `currentPhase`,UI 可视化进度) | phase 切换时更新 `currentPhase` 字段 |
| 5. Unresolved interactions block | **HITL pending check + Goal gate** | pending HITL 阻塞 Goal 进 `done` |
| 6. User approval gate | **Goal phase 转换 guard(approvalPoints)+ HITL `kind="approval"`** | approvalPoints 是 Goal phase 切换门(after_plan/before_complete),Goal runner 命中后调 HITL `approval`。不是 tool permission |
| 7. Critic retry limit | **Goal `retryPolicy.maxRetries`** | 通用重试上限,不绑定 critic stage |
| 8. No concurrent active workflows | **Goal session binding `goalId`** | session 与 Goal 1:1(主 session),并发 Goal 各自独立 session |

### 6.4 Workflow 装饰部分的去向

| Workflow 装饰 | 去向 |
|---|---|
| 3 hardcoded workflow types(research_only/quick_fix/full_feature) | **删除**——产品策略不属于 runtime core。架构师自己定义 Goal |
| 8-stage hardcoded flow | **收缩到 3 phase**(plan→build→review)——prompt 说"先 plan 再 build 再 review",Goal runner 持久化 `currentPhase` |
| 7 workflow role agents | **收缩到 4 core + 2 ancillary**,其他 persona 是 `delegate` 参数 |
| 6 accessor workflow tools | **删除**——Goal/Loop 有自己的 CRUD 工具 |
| Legal transition matrix | **删除**——Goal 只有 3 个 phase,不需要 8×8 转换矩阵,approvalPoints 是 phase 门 |
| Interaction archive | **HITL service 统一管理** |
| Handoff summary | **删除**——Goal 的 main session 对话即交接 |
| Compact formatter | **删除** |

### 6.5 Artifact 管理的去向

Workflow 的 `artifact_read`/`artifact_write` 语义已删除。Phase 2 使用 Goal-scoped canonical artifact manager 和 `goal_artifact_read`/`goal_artifact_write` 工具,只接受当前 Markdown 文件名:`plan.md`,`build.md`,`review.md`,`spec-compliance.md`,`approvals.md`,`budget.md`,`retry-log.md`,`final-report.md`。

Artifact storage 是 `.archcode/goals/{goalId}/artifacts/` 下的当前文件集合,没有 version/revision/latest 指针。Server 只暴露 list/read API 给 Web;Phase 2 Web UI 不提供 artifact editor。

---

## 7. Config schema 重设计

### 7.1 原则

- 保持 `.strict()` Zod
- Env expansion: `${VAR}`, `${VAR:-default}`(已有)
- 改 schema 必须同步更新 `README.md` config 文档(AGENTS.md 约定)

### 7.2 新 schema

```typescript
// packages/agent-core/src/config/schema.ts
archcodeConfigSchema = z.strictObject({
  // === 已有 ===
  provider: z.record(z.string(), providerSchema),    // required
  mcp: mcpConfigSchema.optional(),

  // === 重设计:agents ===
  // 必须为 4 core + 2 ancillary 全部配置 model(6 个全部 required)
  agents: z.strictObject({
    orchestrator: agentConfigSchema,
    plan: agentConfigSchema,
    build: agentConfigSchema,
    reviewer: agentConfigSchema,
    explore: agentConfigSchema,
    librarian: agentConfigSchema,
  }),

  // === 已有 ===
  memory: memoryConfigSchema.optional(),
});

// agent config(每个 agent 必须配 model)
agentConfigSchema = z.strictObject({
  model: z.string(),            // "provider:modelId"
  variant: z.string().optional(),
  options: modelOptionsSchema.optional(),
});
```

**注意**:`agents` 用 `z.strictObject` 强制 6 个 agent 全部必填,不是 `z.record` + enum(避免漏配)。未配置的 agent 实例化时 fail-fast,与现有"missing agent model config fails fast"一致。**无 `goals?` / `loops?` 节**——Goal/Loop 运行时创建,不进 config(见 §7.2.1)。Phase 2 也不新增 `.archcode.json` budget/retry defaults/schema 字段;这些值属于 Goal create input 和持久化 Goal state。

### 7.2.1 为什么 Goal / Loop 不进 config

**ArchCode 的现有模式:工作单元运行时创建,不配置预定义。**

现有 Workflow 从来不在 `.archcode.json` 里预定义——orchestrator 通过 `workflow_create(title, type)` 工具运行时创建,持久化到 `.archcode/workflows/{uuid}/workflow.json`。用户在和 AI 对话中决定"现在做一个 workflow",AI 调工具创建。

**Goal 保持同一模式**:
- 架构师在 main session 里说"我要做一个 Goal"
- orchestrator 调 `goal_create(title, doneConditions, retryPolicy, approvalPoints)` 工具
- Goal state 写到 `.archcode/goals/{goalId}/goal.json`
- 架构师调 `goal_lock` / `goal_run` / `goal_retry` 工具操作

**config 里预定义 Goal 模板没有意义**——Goal 是一次性工作单元,每个都不同。模板应该是 UI 层的快捷起点(Web UI 下拉选"bug fix 模板"自动填表),不是 config 层的静态声明。

**Loop 同样运行时创建**:
- 架构师在 Web UI 点"创建 Loop",填表(schedule/budget/pattern/approvalPoints)
- 调 `POST /api/projects/:slug/loops` API → 写到 `.archcode/loops/{loopId}/loop.json`
- Scheduler 启动时扫 `.archcode/loops/` 目录加载所有 Loop

**config 里预定义 Loop 的问题**:
1. Loop 需要运行时 pause/resume/kill,config 是静态的——冲突
2. Loop 的 crossRunState 在运行时持续更新,config 是启动时读一次的——两套数据源会打架
3. 架构师通过 UI 管理 Loop 生命周期,不是改 `.archcode.json` 然后重启 server

**唯一在 config 里的是 agent 配置**——因为 model/variant/options 是启动时解析的,未配置的 agent 实例化时 fail-fast。这是现有模式的延续,不是新增。

### 7.3 Agent 配置迁移

现有 `.archcode.json` 的 `agents.orchestrator` / `agents.explore` 配置保留。新增必须配置:`agents.plan` / `agents.build` / `agents.reviewer` / `agents.librarian`。**未配置的 agent 实例化时 fail-fast**,与现有"missing agent model config fails fast"一致。

### 7.4 Loop patterns 不硬编码

Loop 运行时创建时(通过 API,非 config)可带 `pattern` 字段——**只是快捷预设引用**。用户可以:
- 选预设(如 `daily_triage`)→ 加载默认 phases/gates/cost
- 选 `custom` → 完全自己定义 schedule/budget/approvalPoints
- 不选 → 等同 custom

预设库作为**可选起点**,不是强制分类。预设定义在 `packages/agent-core/src/loops/patterns/` 下,可读可改,但 runtime 不依赖 pattern enum 做代码分支(不像 Workflow 的 3 type 深埋在 core)。

---

## 8. Protocol 类型

### 8.1 原则

`packages/protocol` 零运行时依赖,纯类型。所有 SSE 事件类型 + state 类型在这里。

### 8.2 新增类型

```typescript
// packages/protocol/src/types.ts

// === Goal ===
export type GoalStatus =
  | "draft" | "locked" | "running" | "verifying"
  | "reviewed" | "completed" | "failed" | "escalated";

export type DoneConditionKind =
  // Layer 1: 机器可检(7 machine)
  | "tests_pass" | "typecheck_pass" | "lsp_clean"
  | "file_exists" | "grep_contains" | "grep_empty"
  | "command_succeeds"
  // Layer 1: HITL(1 kind,非机器 check)
  | "user_confirmed"
  // Layer 2: AI 判断(可选)
  | "spec_compliance";

// DoneCondition: discriminated union by kind(参数类型安全)
export type DoneCondition =
  | { id: string; kind: "tests_pass"; params: { command?: string }; required?: boolean }
  | { id: string; kind: "typecheck_pass"; params: { command?: string }; required?: boolean }
  | { id: string; kind: "lsp_clean"; params: { paths?: string[]; severity?: "error" | "warning" }; required?: boolean }
  | { id: string; kind: "file_exists"; params: { path: string }; required?: boolean }
  | { id: string; kind: "grep_contains"; params: { pattern: string; path?: string; minMatches?: number }; required?: boolean }
  | { id: string; kind: "grep_empty"; params: { pattern: string; path?: string }; required?: boolean }
  | { id: string; kind: "command_succeeds"; params: { command: string; timeoutMs?: number }; required?: boolean }
  | { id: string; kind: "user_confirmed"; params: { prompt: string }; required?: boolean }
  | { id: string; kind: "spec_compliance"; params: { specPath: string; focusAreas?: string[] }; required?: boolean };
// required default true;false = soft hint

export interface DoneResult {
  conditionId: string;
  passed: boolean;
  evidence: string;            // 机器输出或 AI 判断理由
  checkedAt: string;
}

export interface RetryPolicy {
  maxRetries: number;
  backoffMs: number;
  escalateOnFailure: boolean;  // true = 重试耗尽后 escalated,非 failed
}

export type ApprovalPoint =
  | "after_plan" | "before_complete";

export type GoalPhase = "plan" | "build" | "review";

export interface GoalState {
  id: string;
  projectId: string;           // slug
  title: string;
  status: GoalStatus;
  phase: GoalPhase;             // 当前 phase(plan/build/review),持久化
  doneConditions: DoneCondition[];   // lock 后不可变
  doneResults: Record<string, DoneResult>;  // conditionId → 最新结果
  reviewerAgent: string;        // 必须 ≠ executor,默认 "reviewer"
  retryPolicy: RetryPolicy;
  retryCount: number;
  approvalPoints: ApprovalPoint[];
  author: string;               // Done 条件生成者(orchestrator/plan/user)
  lockedBy?: string;            // 锁定者(user id)
  mainSessionId?: string;       // orchestrator session
  childSessionIds: string[];   // plan/build/review/explore/librarian
  lockedAt?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

// === Loop ===
export type LoopStatus =
  | "idle" | "running" | "paused" | "failed" | "killed";
// 注:recurring loop 不用 "completed"——用 killed(人杀)或 paused(预算/停滞)。
// "completed" 只用于 runKind="goal" 且 Goal 成功完成的 one-shot loop(如有)。

export type LoopPhase =
  | "triage" | "implement" | "verify" | "human_gate" | "state_write";

export type ScheduleKind =
  | "interval" | "cron" | "trigger" | "manual";

export interface ScheduleSpec {
  kind: ScheduleKind;
  intervalMs?: number;         // for "interval"
  cronExpr?: string;           // for "cron"
  trigger?: "on_commit" | "on_pr" | "on_ci_fail";  // for "trigger"
}

export interface BudgetSpec {
  maxIterationsPerRun: number;
  maxTokensPerRun?: number;
  maxTokensPerDay?: number;
  maxIterationsPerDay?: number;
  maxConcurrent: number;       // 跨 loop 协调
  throttleAtPct?: number;      // ≥80% 降级 report-only
  hardStopAtPct: number;       // ≥100% 强停
  stagnationLimit?: number;    // 连续 N 次 no-progress → abort(默认 3)
}

export interface LoopCrossRunState {
  lastRunAt?: string;
  nextScheduledAt?: string;
  runCount: number;
  todaySpend: { tokens: number; iterations: number; date: string };
  watchlist: WatchItem[];
  noise: string[];             // 已 triage、不再报告
  escalated: EscalatedItem[];
  killSwitch: boolean;         // per-loop pause
  actingOn?: string;           // 当前正在操作的 branch/PR id(碰撞检测用,spawn fix 前写,完成后清)
  notes: string;               // 人类可读备注
}

export interface WatchItem {
  id: string;
  description: string;
  priority: "high" | "medium" | "low";
  addedAt: string;
}

export interface EscalatedItem {
  id: string;
  description: string;
  reason: string;
  escalatedAt: string;
  waitedMs: number;            // 超期 UI 红标
}

export interface LoopState {
  id: string;
  projectId: string;
  patternId?: string;          // 引用预设,custom 则无
  title: string;
  status: LoopStatus;
  schedule: ScheduleSpec;
  budget: BudgetSpec;
  crossRunState: LoopCrossRunState;
  runKind: "session" | "goal";
  goalTemplateId?: string;     // runKind="goal" 时
  reviewerAgent: string;        // runKind="goal" 时,默认 "reviewer"
  approvalPoints: ApprovalPoint[];
  sessionIds: string[];        // 每次 run 一个 session
  currentPhase: LoopPhase;
  currentSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

// === HITL ===
// 3 种 kind:question(含选项)/ approval(工具 gate)/ review(批量产物审查)
// 无单独 decision kind:与 question 结构相同,区别纯语义(prompt 层)
export type HitlKind = "question" | "approval" | "review";

export interface HitlRequest {
  id: string;
  sessionId: string;           // 来源 session
  goalId?: string;
  loopId?: string;
  kind: HitlKind;
  prompt: string;
  payload: HitlPayload;        // kind-specific
  trigger: "approval_point" | "agent_request";  // 硬约束 vs 软约束
  status: "pending" | "resolved" | "cancelled" | "timeout";
  createdAt: string;
  resolvedAt?: string;
  response?: HitlResponse;
}

export type HitlPayload =
  // question:可无选项(自由文本)或有选项(结构化选择)。options 存在时可选 recommendedOption + rationale。
  | { kind: "question"; options?: Array<{ label: string; description?: string }>; multiple?: boolean; custom?: boolean; recommendedOption?: string; rationale?: string }
  // approval:permission 模块需要人审时调 HITL 呈现 yes/no。HITL 只呈现+拿回决策;
// deny→工具不执行 和 approve_always→持久化 是 permission 模块根据返回值做的,不是 HITL 的职责。
  | { kind: "approval"; action: string; context: Record<string, unknown> }
  // review:架构师批量审查产物。outcome 驱动 Goal 状态机(DONE→completed, NOT_DONE→failed/retry/escalated)。
  | { kind: "review"; artifacts: Array<{ path: string; description: string }> };

export type HitlResponse =
  // question:回答回流对话上下文。无选项→自由文本;有选项→选中的 label(或多选的 labels)。
  | { kind: "question"; answers: string[]; comment?: string }
  // approval:用户决策回传。HITL 只拿回 approved/approveAlways/comment;
// permission 模块根据这个值决定放行/拒绝/持久化 scope(approve_always → ProjectApprovalManager)。
  | { kind: "approval"; approved: boolean; approveAlways?: boolean; comment?: string }
  // review:outcome 驱动 Goal 状态机。
  | { kind: "review"; outcome: "DONE" | "NOT_DONE"; comment?: string };

// === Session 关联扩展 ===
// SessionFileSchema 新增:
//   goalId?: string;
//   loopId?: string;
//   sessionRole?: "main" | "plan" | "build" | "review" | "explore" | "librarian" | "standalone";

// === SSE 事件扩展 ===
export type GoalStreamEvent =
  | { type: "goal.state_change"; goalId: string; status: GoalStatus }
  | { type: "goal.done_check"; goalId: string; results: DoneResult[] }
  | { type: "goal.escalation"; goalId: string; reason: string };

export type LoopStreamEvent =
  | { type: "loop.run_start"; loopId: string; sessionId: string }
  | { type: "loop.run_end"; loopId: string; sessionId: string; outcome: string }
  | { type: "loop.phase_change"; loopId: string; phase: LoopPhase }
  | { type: "loop.budget_update"; loopId: string; spend: { tokens: number; iterations: number; date: string } }
  | { type: "loop.escalation"; loopId: string; item: EscalatedItem };

export type HitlStreamEvent =
  | { type: "hitl.request"; hitlId: string; sessionId: string; kind: HitlKind }
  | { type: "hitl.resolved"; hitlId: string };
```

---

## 9. Server 路由 + Scheduler

### 9.1 路由

遵循现有 `/api/projects/:slug/{resource}` 模式:

| Method | Route | 用途 |
|---|---|---|
| `GET` | `/api/projects/:slug/goals` | 列 Goal |
| `POST` | `/api/projects/:slug/goals` | 创建 Goal(draft) |
| `GET` | `/api/projects/:slug/goals/:id` | 读 Goal state |
| `PATCH` | `/api/projects/:slug/goals/:id` | 编辑 Goal(**draft only**,locked 后 409) |
| `POST` | `/api/projects/:slug/goals/:id/lock` | **锁定 Done 条件**(不可逆) |
| `POST` | `/api/projects/:slug/goals/:id/run` | 触发执行(创建 main session + 委派 + verify) |
| `POST` | `/api/projects/:slug/goals/:id/retry` | 手动重试(fresh session) |
| `POST` | `/api/projects/:slug/goals/:id/escalate` | 标记 escalated |
| `POST` | `/api/projects/:slug/goals/:id/cancel` | 取消(running → failed) |
| `GET` | `/api/projects/:slug/loops` | 列 Loop |
| `POST` | `/api/projects/:slug/loops` | 创建 Loop |
| `GET` | `/api/projects/:slug/loops/:id` | 读 Loop state |
| `POST` | `/api/projects/:slug/loops/:id/trigger` | 手动触发一次 run |
| `POST` | `/api/projects/:slug/loops/:id/pause` | 暂停调度 |
| `POST` | `/api/projects/:slug/loops/:id/resume` | 恢复调度 |
| `POST` | `/api/projects/:slug/loops/:id/kill` | kill switch |
| `GET` | `/api/projects/:slug/loops/:id/runs` | run history(JSONL) |
| `GET` | `/api/projects/:slug/loops/:id/state` | 读 crossRunState |
| `PATCH` | `/api/projects/:slug/loops/:id/state` | 手动编辑 state(unstick) |
| `GET` | `/api/hitl` | 全局 HITL 队列(支持 `?projectSlug=&goalId=&loopId=&status=` 过滤) |
| `GET` | `/api/projects/:slug/hitl` | 项目 HITL 队列(支持 `?goalId=&loopId=&status=` 过滤) |
| `POST` | `/api/hitl/:id/respond` | 响应 HITL |
| `POST` | `/api/hitl/:id/cancel` | 取消 HITL |

**全局聚合路由(Dashboard 首次加载)**:

| Method | Route | 用途 |
|---|---|---|
| `GET` | `/api/goals?status=active&projectSlug=...` | 跨项目所有 active goals,每项含 `projectSlug` + `projectName`,无需前端 join |
| `GET` | `/api/loops?status=active&projectSlug=...` | 跨项目所有 active loops,含 budget 聚合(今日已用/上限) |
| `GET` | `/api/activity?limit=50&projectSlug=...` | 跨项目事件流 REST 初始快照(分页),SSE 做增量推送 |

实现:走 `ProjectRegistry.listProjects()` → 遍历各项目 GoalState/LoopState/EventRing → 合并,无新建存储。`?projectSlug=xxx` 可过滤复用给 Projects 视图。

**SSE**:复用现有 `GET /api/events` 全局流——Goal/Loop session 的事件自动流出。无需新建 scoped SSE。Dashboard 的 Recent Activity 区块用 REST `/api/activity` 拿初始快照 + SSE `/api/events` 增量推送(符合现有 EventRing Last-Event-ID replay 机制)。

### 9.2 Scheduler

**新建** `packages/agent-core/src/loops/scheduler.ts`:

```typescript
class LoopScheduler {
  constructor(runtime: AgentRuntime) {}
  start(): void {
    // 启动:load all loops for all projects → register timers
    // setInterval(intervalMs) per "interval" loop
    // cron parser per "cron" loop (v2)
    // event subscription per "trigger" loop (v2)
  }
  registerLoop(loop: LoopState): void {}
  unregisterLoop(loopId: string): void {}
  pause(loopId: string): void {}
  resume(loopId: string): void {}
  triggerManual(loopId: string): Promise<RunResult> {}
  stop(): void { /* clearAllTimers, graceful shutdown */ }
}
```

**Boot 注入点**(`apps/server/src/main.ts`):
```typescript
const runtime = createRuntime(...);
const scheduler = new LoopScheduler(runtime);
scheduler.start();
runtime.scheduler = scheduler;
await bootServer(runtime, { scheduler });  // shutdown 时 scheduler.stop()
```

**v1 调度**:`"interval"` + `"manual"`。`"cron"` 与 `"trigger"` 留 v2。

### 9.3 Loop 单次 run 流程

`packages/agent-core/src/loops/runner.ts`:
```
1. budget_check_pre: 今日预算检查,超 throttle → 降级 report-only,超 hardStop → abort
2. collision_check: 读所有其他 loop 的 crossRunState.acting_on,
   如果与本次目标 branch/PR 匹配 → skip + log(借鉴 multi-loop.md)
3. triage: 委派 explore agent 扫项目 → 产出 watchlist
4. read_state: 加载 crossRunState,过滤 noise
5. run_kind:
   - runKind="session": 创建新 session → orchestrator 跑
   - runKind="goal": 创建新 Goal(从 goalTemplate)→ Goal 执行流程(§9.4)
   - action loop 在 state 写 acting_on: "branch-or-pr-id"(spawn fix 前写,完成后清)
6. verify (runKind="goal" 时): Goal 内置 Reviewer,跳过
7. human_gate: 风险路径触发 approvalPoints → HITL approval → 等响应
8. state_write: 更新 crossRunState + 追加 run-log JSONL + 清 acting_on
9. budget_check_post: 更新今日 spend,检查阈值
10. stagnation_check: 连续 N 次 no-progress → abort + escalate
```

每步通过 `SessionEventBridge` 流到全局 SSE,Web UI 实时可见。

**碰撞检测 + 优先级**(借鉴 loop-engineering `multi-loop.md`):
- 每个 action loop 在 spawn fix 前写 `acting_on: "branch-or-pr-id"` 到自己的 crossRunState
- spawn 前读所有其他 loop 的 crossRunState,如果 `acting_on` 匹配 → skip + log
- 优先级(冲突时低优先级让步):CI Sweeper(1)> PR Babysitter(2)> Dependency Sweeper(3,CI red 时暂停)> Post-Merge Cleanup(4)> Daily Triage(5,只报告)
- 真实教训:无碰撞检测时 CI Sweeper 14:02 spawn fix + PR Babysitter 14:07 spawn 另一个 fix,同 PR 烧 400k tokens(正常 80k),人解 45 分钟

### 9.4 Goal 执行流程

`packages/agent-core/src/goals/runner.ts`:
```
1. lock: Done 条件锁定(draft → locked),记录 lockedBy
2. run: 创建 main session(orchestrator)→ orchestrator 自主分解:
   a. phase=plan: delegate(plan, "分析需求,产出 plan") → plan session
   b. approval_point(after_plan): HITL approval → 等架构师批准 → 放行 plan→build
   c. phase=build: delegate(build, "按 plan 实现") → build session
      - build phase 内 tool guard 判断 on_destructive_op(file_write/bash 等)→ permission 模块调 HITL approval
   d. phase=review: delegate(reviewer, "审查完成度") → review session(独立 store)
   e. reviewer 跑 goal_check_done → doneResults 写入
3. verify: 所有 doneConditions 机检
   - 全 true + reviewer 通过 → reviewed → completed
   - 任一 false + retry left → failed → retry(创建新 main session,fresh context,phase 重置 plan)
   - retry 耗尽 → escalated(等人审)
4. approval_point(before_complete): review→completed 门,HITL approval
```

**orchestrator 自主分解 + 充分 HITL**:orchestrator 自己决定怎么拆任务,但在 `after_plan` / `before_complete` 等关键 phase 转换点和架构师充分讨论。`on_destructive_op` 是 build phase 内的 tool guard(不是 phase 转换门)。不是全自动,也不是手把手。

### 9.5 HITL service

**新建** `packages/agent-core/src/hitl/service.ts`(**不合并** `PermissionService`/`AskUserService`,它们保持不变):
```typescript
class HitlService {
  request(sessionId: string, kind: HitlKind, payload: HitlPayload,
          trigger: "approval_point" | "agent_request"): Promise<HitlResponse>
  respond(hitlId: string, response: HitlResponse): void
  cancel(hitlId: string): void
  listPending(projectSlug?: string, goalId?: string, loopId?: string): HitlRequest[]
}
```

复用现有 `PermissionService` / `AskUserService` 的 deferred Promise + SSE 推送 + 超时/abort 安全 resolve 模式。Phase 2 的 pending HITL records 由 durable project-scoped queue 持久化;旧进程内 Promise 不恢复,但后续 execution 可通过 deterministic key 复用 pending record。

### 9.6 Goal/Loop state 管理

**新建** `packages/agent-core/src/goals/state.ts` + `loops/state.ts`:
完全照搬 `WorkflowStateManager` 模式(被删前先抄):
- 构造器接 `workspaceRoot`
- `resolveContainedPath()` 路径安全
- `atomicWrite()` 持久化
- Zod `.strict()` 校验
- read → parse → mutate → re-parse → write

**State 原子性 + recovery-scan**:server 启动时扫描所有 Goal/Loop state:
- `status="running"` 且无活跃 session → 标 `failed`(并记 `lastError: "interrupted by server restart"`)
- `status="verifying"` 且无活跃 session → 标 `failed`
- 有 pending durable HITL 的 Goal → 标 `paused` 或等待 deterministic key 复用(按 runner recovery 语义)

存储路径:
```
.archcode/goals/{goalId}/goal.json
.archcode/goals/{goalId}/artifacts/{canonical-name}.md
.archcode/goals/{goalId}/memory/
.archcode/hitl-queue.json
.archcode/loops/{loopId}/loop.json
.archcode/loops/{loopId}/state.json          # crossRunState source of truth
.archcode/loops/{loopId}/state.md            # 人类可读视图(生成器,只读)
.archcode/loops/{loopId}/run-log.jsonl       # 每次 run 追加一行
```
Goal artifact files are canonical current Markdown files only; no version/revision/latest files are written. Goal memory is isolated from project memory at `.archcode/memory/`. HITL durable queue records redacted display payloads and project-scoped approval decisions.

**state.md 只读视图**:`state.json` 是 source of truth,`state.md` 在每次 `state_write` 阶段从 json 重新生成。用户编辑 state 通过:
- Web UI 的 State tab(JSON-backed form,调 `PATCH /loops/:id/state` API)
- 或直接编辑 `state.json`(然后 reload)
**不能编辑 `state.md`**——它是生成视图,编辑会被下次 `state_write` 覆盖。这避免双向同步复杂度。

### 9.7 Loop run-log(JSONL)

借鉴 loop-engineering `loop-run-log.md` 格式。每次 run 追加一行:
```json
{
  "runId": "uuid",
  "loopId": "uuid",
  "startedAt": "ISO",
  "endedAt": "ISO",
  "durationMs": 12345,
  "pattern": "daily_triage",
  "phases": ["triage", "implement", "state_write"],
  "itemsFound": 4,
  "actionsTaken": 1,
  "escalations": 0,
  "tokensEstimate": 52000,
  "outcome": "report-only|fix-proposed|escalated|no-op|failed",
  "readinessScore": 80
}
```

### 9.8 Budget 追踪 + 早退

`packages/agent-core/src/loops/budget.ts`:
- 每次 run 结束累加 `todaySpend.tokens` / `todaySpend.iterations`
- 跨日重置(date 字段判断)
- `throttleAtPct`(默认 80):达到 → 本次 run 降级为 report-only(不 implement)
- `hardStopAtPct`(默认 100):达到 → 强停本次 run + 标记 `paused`
- **stagnation circuit breaker**(借鉴 Steinberger):连续 `stagnationLimit`(默认 3)次 `outcome: "no-op"` → abort loop + escalate

Budget、kill switch、collision checks 是 Loop runtime 的 pre-run/tool guard/runtime guardrails,不是第二套 permission system,也不替代现有 tool permission/HITL approval pipeline。Loop 只决定是否/何时调度和何时停止;Session/Goal + tools 仍是实际执行层。

### 9.9 Kill switch

- **全局**:`runtime.scheduler.killAll()` API → scheduler 暂停所有 loop(运行时调用,不在 config 里——config 无 `loops` 节,见 §7.2.1)
- **per-loop**:`loopState.crossRunState.killSwitch` true → 该 loop 不调度
- **API**:Loop control routes are project-scoped under `/api/projects/:slug/loops/...`: `POST /api/projects/:slug/loops/:id/kill` sets killSwitch + aborts current run, and `POST /api/projects/:slug/loops/kill-all` activates project-wide global kill. There is no unscoped global `/api/loops/kill-all` route.
- 借鉴 loop-engineering `loop-pause-all` label

### 9.10 External Integrations(Phase 4+)

**新建** `packages/agent-core/src/integrations/`:

Phase 3 的 Loop 预设库 7 个里只有 daily_triage + changelog_drafter 纯本地可用,其余 5 个(pr_babysitter / ci_sweeper / dependency_sweeper / post_merge_cleanup / issue_triage)需要外部数据源。Phase 4 加第一批 connector 做最小闭环。

| Connector | 用途 | 依赖的 Loop 预设 | Phase |
|---|---|---|---|
| **GitHub.com** | PR 列表 / PR diff / issue 列表 / open PR review comments / post PR comment / 可选 fix Goal handoff | pr_babysitter / issue_triage / post_merge_cleanup | 4 |
| **GitHub Actions** | 最近 workflow run 状态 / 失败日志摘要 / rerun workflow run | ci_sweeper / dependency_sweeper | 4 |

**设计**:
- Connector 是 `IntegrationProvider` 接口,与 MCP server 同构(但不是 MCP,是内建轻量 client)
- Config 在 `.archcode.json` 加可选 `integrations` 节(Strict Zod):
  ```json
  "integrations": {
    "github": {
      "enabled": true,
      "tokenEnv": "ARCHCODE_GITHUB_TOKEN",
      "apiBaseUrl": "https://api.github.com",
      "defaultOwner": "archcode",
      "defaultRepo": "archcode"
    }
  }
  ```
- Connector 暴露 PR/issue/workflow 状态读取、评论、workflow rerun 等固定方法给 Loop triage 阶段调用
- **AI 自治边界**(见 §9.11):PR Babysitter 是 PR watch/status/comment + optional fix Goal,不 merge/rebase/approve/force-push
- Token auth 只从 env 解析:`integrations.github.tokenEnv` → `GITHUB_TOKEN` → `GH_TOKEN`;原始 token 不写入 Loop state/run-log/tool output

**v1 范围**:只接 GitHub.com(`https://api.github.com`) + GitHub Actions。GitHub Enterprise / GitLab / Bitbucket / CircleCI / Jenkins / OAuth / GitHub App / 浏览器安装授权留后续。

### 9.11 AI 自治边界

**原则**:架构师监督定位决定了 AI 的自治上限。AI 做事,人把关关键节点。

| 操作 | AI 可做 | 人必须做 | 说明 |
|---|---|---|---|
| 改代码(file_write / file_edit) | ✅ | — | build agent 的核心能力 |
| 跑测试 / typecheck / lint(bash,只读命令) | ✅ | — | Reviewer + build 都可跑 |
| `git add` + `git commit`(本地) | ✅ | — | AI 可提交到本地工作分支 |
| `git push`(推到远端 branch) | ❌ | ✅ | bash guard 拦截 `git push` |
| `git merge` / `git rebase` / `git reset --hard` | ❌ | ✅ | bash guard 拦截,危险操作 |
| 开 PR(GitHub API) | ✅(Phase 4+ 有 connector) | — | AI 可开 PR,PR 描述由 AI 写 |
| 批准 / merge / rebase / force-push PR | ❌ | ✅ | PR Babysitter 不做这些动作;Reviewer 存在的核心理由 |
| 开 issue / 评论(GitHub API) | ✅(Phase 4+ 有 connector) | — | AI 可开 issue + 评论 |

**实现**:
- `bash-classifier` guard 扩展:拦截 `git push` / `git merge` / `git rebase` / `git reset --hard` / `git checkout` 到其他分支 / `git tag -d` 等危险 git 命令,返回 `deny` 强制人审
- `git commit` 允许,但 commit message 里自动追加 `[archcode-auto]` 标记,便于事后过滤
- Reviewer 工具集(§5.1)不包含 `git commit`(只读 + lsp + goal_check_done),所以 Reviewer 不会改代码也不会提交
- connector 的 `createPR()` 只在 build phase 之后 + approvalPoint `before_complete` 通过后才调用

### 9.12 未来扩展点:Mission 原语(当前不引入)

**决策(2026-07)**:不引入 Mission 原语。保留 Session/Goal/Loop 三层。此处留占位,后续如果单个 Goal 不够用大功能场景再评估。

**背景**:Factory Missions(2026-04)证明"有序 Goal 序列 + 阶段门控 + 总体验收"对超大功能开发有价值。ArchCode 当前用"单个 Goal + orchestrator 自主分解 plan→build→review"处理大功能。如果后续 dogfood 发现单个 Goal 上下文累积影响质量(Factory 已证明单 session 累积是死穴),再评估引入 Mission。

**如果引入,Mission 的语义**:
- Mission = 有序 Goal 序列 + 阶段门控 + 总体验收
- 调度语义:Mission = 依赖触发(前一 Goal 完成 → 下一 Goal 启动),Loop = 时间触发(cadence 到了 → 启动),两种调度语义不能混
- 每个 Goal fresh context(per-stage fresh context 是 Factory 验证过的关键设计点)
- Mission 有独立 state(`.archcode/missions/{missionId}/mission.json`),记录阶段进度 + 验收条件 + Goal 依赖图

**当前替代方案**:用户手动开多个 Goal,在 Goal description 里写"这是 N 阶段大功能的第 K 阶段"。orchestrator 自主分解时知道全局上下文。不完美但够 MVP。

---

## 10. Web UI:Mission Control

### 10.1 主导航(从单项目改为跨项目优先)

```
Dashboard(跨项目 Mission Control)
 ├─ Active Goals(所有项目的 active goals)
 ├─ Active Loops(所有项目的 active loops + budget 仪表)
 ├─ Approval Queue(全局 HITL 队列)
 └─ Recent Activity(跨项目事件流)

Projects
 └─ {project}
     ├─ Goals
     │   └─ {goal}
     │       ├─ Overview(done conditions + 进度)
     │       ├─ Plan(plan session 视图)
     │       ├─ Build(build session 视图)
     │       ├─ Review(review session + doneResults)
     │       ├─ Chat(main session 对话)
     │       └─ Sessions(子 session 列表 + retry 链 + 委派树)
     ├─ Loops
     │   └─ {loop}
     │       ├─ Config(schedule/budget/approvalPoints)
     │       ├─ Live Status(current phase + budget 仪表)
     │       ├─ Run History(JSONL run-log)
     │       └─ State(crossRunState 编辑器)
     ├─ Sessions(顶层独立 session)
     └─ Memory
```

**Dashboard 数据模型(REST 快照 + SSE 增量)**:

| 区块 | 初始加载(REST) | 增量更新(SSE) |
|---|---|---|
| Active Goals | `GET /api/goals?status=active` | `goal.state_change` → invalidate ["goals"] |
| Active Loops | `GET /api/loops?status=active` | `loop.run_start` / `loop.budget_update` → invalidate ["loops"] |
| Approval Queue | `GET /api/hitl` | `hitl.request` / `hitl.resolved` → invalidate ["hitl"] |
| Recent Activity | `GET /api/activity?limit=50` | SSE `/api/events` 增量推送(EventRing Last-Event-ID replay) |

避免 N 次请求:Dashboard 首次打开只发 4 个全局聚合请求,不是按项目逐个拉 goals/loops。返回项带 `projectSlug` + `projectName`,前端无需二次 join。

### 10.2 Goal 详情 tabs

| Tab | 内容 |
|---|---|
| Overview | Done 条件列表 + 各条件机检结果(✅/❌)+ 进度条 + retry 链 |
| Plan | plan session 的对话/工具调用视图(只读回放) |
| Build | build session 的对话/工具调用/diff 视图 |
| Review | review session + doneResults + Reviewer 证据 |
| Chat | **main session 对话视图**(架构师与 orchestrator 对话) |
| Sessions | 子 session 列表 + retry 链 + 委派树 |
| Artifacts | 当前 canonical Markdown artifacts(只读,无版本/编辑器) |

### 10.3 Loop 详情 tabs

| Tab | 内容 |
|---|---|
| Config | schedule / budget / approvalPoints / pattern 编辑 |
| Live Status | 当前 phase + budget 仪表(tokens/iterations 已用/上限)+ throttle/hardStop 预警 |
| Run History | run-log JSONL 可视化(每次 run 的 outcome/tokens/duration) |
| State | crossRunState 编辑器(watchlist/noise/escalated/notes) |

### 10.4 Approval Queue

- **集中**(全局 Dashboard):跨项目、跨 Goal、跨 Loop 的所有 pending HITL
- **就地**(Goal 详情):仅该 Goal 的 pending HITL
- 两端都能操作,React Query invalidation 同步
- 每条 HITL 卡片显示:kind icon / 来源 session / Goal title / prompt / redacted `displayPayload`
- 点击 → 跳转到来源 session 上下文

### 10.5 新 store

- `apps/web/src/store/goal-store.ts`(vanilla Zustand,仿 session-store)
- `apps/web/src/store/loop-store.ts`
- `apps/web/src/store/hitl-store.ts`

### 10.6 新 API hooks

按现有 `["projects", slug, resource, ...id]` key 模式:
```
["projects", slug, "goals"] / ["goals", goalId]
["projects", slug, "loops"] / ["loops", loopId] / ["loops", loopId, "runs"]
["hitl"] / ["hitl", "project", slug]
```

### 10.7 SSE 事件处理

`global-sse.tsx` 的 `handleSSEEvent` 追加:
```
"goal.state_change" → invalidate ["goals", goalId]
"goal.done_check"   → update goal-store in-place
"loop.run_start"    → invalidate ["loops", loopId, "runs"]
"loop.budget_update"→ update loop-store in-place
"hitl.request"      → invalidate ["hitl"]
"hitl.resolved"     → invalidate ["hitl"]
```

### 10.8 MCP status(已有,保留)

`GET /api/mcp/status` + `useMcpStatusStore` + `GlobalSSEMcpStatusEvent` 保持不变。

---

## 11. 分阶段路线(MVP 思想,先 Goal 后 Loop)

按 **MVP 思想**开发:每个阶段交付一个可用的用户价值。对齐 PRD §5 的 5 阶段。**不套用 loop-engineering L0-L3**(那是 Loop 成熟度模型,不是产品开发顺序)。旧稿提到的 L1→L2→L3 只保留为未来 advisory 参考,不是当前 runtime gate。

### 阶段 1:Goal MVP(最小可验证)

**目标**:能跑通一个完整 Goal = 验证"架构师设计意图 → AI 执行 → 机检证明完成 → 架构师审查"核心闭环。

**阶段 1A:Protocol + Config 基础**
- Protocol 类型定义(§8):GoalState(含 phase/author/lockedBy)/HitlRequest/DoneCondition(discriminated union)/SSE 事件(LoopState 暂不定义)
- Config schema(§7):`agents` 用 `z.strictObject` 强制 6 agent(orchestrator/plan/build/reviewer/explore/librarian),无 `goals?`/`loops?` 节
- `SessionFileSchema` +`goalId?` +`loopId?` +`sessionRole?`

**阶段 1B:Agent 定义 + Workflow 删除**
- 6-agent 定义(orchestrator/plan/build/reviewer/explore/librarian),工具集硬编码
- Reviewer 工具集:read-only + lsp + git_diff + grep + glob + `goal_check_done`(内部白名单执行)
- **Reviewer day-one 强制**(orchestrator 不能跳过,`reviewed` 是 `done` 前置)
- Reviewer 默认拒绝 + 5 点检查清单
- **Workflow 删除**(§6,code 一次性删,用户数据 `.archcode/workflows/` 保留只读)
- delegate API:`delegate(agent_type, persona?, task, context)`

**阶段 1C:Goal runner + HITL**
- `GoalStateManager`(CRUD + lock + run + PATCH draft)
- `HitlService`(**不合并** PermissionService/AskUserService,新增独立 service)
- HITL 3 种 kind(question/approval/review)+ 统一 Approval Queue
- HITL Phase 1 起步可 in-memory;Phase 2 已替换为 durable project-scoped queue(见 §9.5/§11.2)
- State recovery-scan(启动时 running 无活跃 session → failed)
- `goal_check_done` 工具(7 machine + 1 HITL kind)
- AI 可生成 Done 条件(含 command_succeeds),用户 lock 确认后生效;goal.json 记 author + lockedBy
- Goal 状态机:draft→locked→running→verifying→reviewed→completed/failed/escalated + 显式 phases(plan→build→review)
- Goal 执行路径(§9.4):lock → phase=plan → approval_point(after_plan) → phase=build → phase=review → done check → retry(fresh session,phase 重置 plan)
- approvalPoints:`after_plan` / `before_complete`(phase 转换门);`on_destructive_op` 是 tool guard
- Goal retry(fresh session)
- 路由:Goal CRUD + PATCH(draft only)+ lock + run + retry,HITL CRUD + respond(支持 goalId/loopId 过滤)

**阶段 1D:Web UI**
- Goal 列表 + 详情(Overview/Plan/Build/Review/Chat/Sessions)
- Approval Queue(集中+就地,React Query invalidation 同步)
- 项目导航
- **Dashboard(跨项目 Mission Control)**:Active Goals + Approval Queue
  - REST 初始快照:遍历 `ProjectRegistry.list()` + 各项目 `.archcode/goals/` 文件聚合(无新存储)
  - SSE 增量:复用 `GET /api/events`

### 阶段 2:Goal 完善(日常可用)

**目标**:Goal 体验完整,架构师可日常依赖 Goal 做真实工程工作。

- retry 完整:Goal create/state 持有 `retryPolicy`;runner 持久化 `retryState.nextRetryAt`、last failure、scheduled/running/escalated attempt metadata。到期 retry 可在 runner/service 重建后恢复。
- `spec_compliance` Done 条件由 Reviewer 通过 Reviewer-only `goal_check_done` 记录逐 criterion 结构化证据;Reviewer 外部 outcome 只有 `DONE` / `NOT_DONE`。
- `NOT_DONE` 写结构化 Operator repair context,不保存 raw Reviewer/LLM 输出或 chain-of-thought;DONE 走 reviewed/completed 路径。
- Goal 详情 tabs 完整:Plan/Build/Review/Spec/Budget/Approvals/Retry/Final Report 读取当前 canonical Markdown artifacts,不只 chat 流。
- Artifacts 是 `.archcode/goals/{goalId}/artifacts/` 下当前文件:`plan.md`,`build.md`,`review.md`,`spec-compliance.md`,`approvals.md`,`budget.md`,`retry-log.md`,`final-report.md`;无 version/revision/latest 文件。
- Approval Queue 完整:durable、project-scoped、全局 Dashboard + 就地操作同步;API/Web 返回 redacted `displayPayload`,默认不暴露 raw payload。
- Goal budget 基础:per-Goal token 上限 + warning approval/hard pause;统计 token only(`inputTokens`/`outputTokens`/`totalTokens`),不做 pricing/cost accounting。
- Goal memory 接通 Plan/Build/Review prompt,存放在 Goal scope,与 Project memory 隔离;不 promotion/auto-transfer。
- `.archcode.json` 不新增 Phase 2 `goals`、budget 或 retry defaults/schema 字段;budget/retry 是 Goal 创建输入和持久化 Goal state。
- Legacy workflow runtime/tool/routes 已移除;不保留 fallback 或兼容层。

### 阶段 3:Loop MVP(可跑通)

**目标**:Loop 第一次可跑——架构师能设定"定期跑某任务",自动执行 + 报告。先跑 Session,再跑 Goal。

**Action loop 安全策略**:Phase 3 允许 action loop(可改代码),靠现有机制兜底——(1) Loop 跑 Goal 时 Reviewer day-one 强制(独立 session + 默认拒绝 + 工具白名单);(2) approvalPoints(before_complete)是破坏性操作的最后一道门;(3) Loop 基础 budget(tokens + iterations)防单次跑飞。Phase 4 上完整护栏(throttle/hardStop/stagnation breaker/kill switch)后才真正可无人看。

- Protocol 类型补充:LoopState/ScheduleSpec/BudgetSpec(阶段 1 未定义)
- Config schema **不加** `loops?` 节(Loop 运行时创建,见 §7.2.1,与 Goal 一致)
- `LoopStateManager`(CRUD + state.json + state.md 生成器 + run-log.jsonl)
- `LoopScheduler`:`"interval"` + `"manual"`(cron/trigger 留阶段 5)
- Loop run 流程(§9.3):budget_check → collision_check → triage → read_state → run_kind(Session 或 Goal)→ state_write
- Loop 可跑 Session(简单重复任务)或 Goal(复杂重复任务带 done + reviewer)
- Loop 预设库 7 个(daily_triage/pr_babysitter/ci_sweeper/dependency_sweeper/post_merge_cleanup/changelog_drafter/issue_triage),作为快捷起点
  - **Phase 3 只 daily_triage + changelog_drafter 完整可用**(纯本地,无外部依赖);其余 5 个预设需 Phase 4 external connector(见 §9.10)
- 跨 run state(state.json source of truth + state.md 只读视图)
- run-log JSONL 持久化
- 路由:Loop CRUD + trigger + pause + resume + runs + state
- Web UI:Loop 列表 + 详情(Config/Live Status/Run History/State)、Dashboard 增加 Active Loops 区块
- main.ts boot 注入 LoopScheduler

### 阶段 4:Loop 完善(日常可用)

**目标**:Loop 可日常依赖做重复性维护工作,有护栏不怕跑飞。

- Budget 护栏:throttleAtPct/hardStopAtPct 早退 + stagnation circuit breaker(stagnationLimit 默认 3)
- kill switch(全局 `runtime.scheduler.killAll()` API + per-loop crossRunState.killSwitch + API)
- 碰撞检测:acting_on 字段 + 优先级(CI Sweeper>PR Babysitter>Dependency>Post-Merge>Daily Triage)
- Guardrail boundary:Budget/kill/collision 是 pre-run/tool guard/runtime checks,不是第二套 permission system;现有 tool permission/HITL approvals 仍负责每次敏感工具调用和人审门
- Superseded/current Phase 4 简化:旧稿里的 L1→L2 毕业、noise <20%、readiness score 只保留为未来 advisory 参考,不是 runtime gate
- Loop 预设库 BudgetSpec 默认值(来自 loop-engineering cost registry:noop/report/action/daily_cap/early_exit)
- Loop 详情 UI 完整:budget 仪表、run-log 可视化、state 编辑器、phase 实时可视化

### 阶段 5:进阶

**目标**:无需人盯的 unattended Loop 完整能力。Phase 5 已确认交付完整 5a,再加安全 cleanup 子集。readiness/custom pattern 继续排除,只保留类型占位或未来讨论入口。

**Phase 5a 已确认范围**:
- `cron` 调度:5-field UTC expression,cron adapter 负责注册、next-fire 计算、restart catch-up,错过多次时只 enqueue 最新一次 missed run
- `triggers[]`:事件触发列表,支持 `on_commit` / `on_pr` / `on_ci_fail`;trigger polling 只读取 GitHub/CI 状态,按 `cadenceMs` 和 subject dedupe 入队
- 跨 loop 协调和持久队列:`LoopJobQueue` + `LoopJobCoordinator`,用 `dedupeKey`、`branchKey`、collision key 串行化同一分支/目标
- `maxConcurrent`:project coordinator 配置,默认 2,控制同项目并发 job 数。Server route 暂不提供 project-level 持久化 API,不能把 route body 的 `projectConfig` 当成有效配置
- git worktree 隔离执行:action loop 在 managed sibling root 下创建 worktree,session/tool cwd 使用 worktree,Loop state/run-log/queue 仍写 canonical workspace

**Phase 5 安全 cleanup 子集**:
- `cleanupPolicy`:允许 mark/pause、自定义 quiet/no-finding 阈值、显式 `deleteUnchangedWorktrees`
- `cleanupState`:记录 `cleanup_candidate`、`auto_paused`、`preserved`、`cleaned`、`cleanup_failed`、`expired_needs_review` 等状态
- 删除只限 manager 重新检查后确认无变化且策略显式允许的 managed worktree。changed、failed、expired、blocked、非托管或路径异常的 worktree 必须保留并要求审查

**明确排除的 Phase 5b/未来占位**:
- readiness score / readiness gate / readiness scheduler。协议和 state 仅保留 `readinessScore?: null` 兼容占位,不能出现非 null 分数、maturity scoring 或调度门控
- 用户自定义 pattern registry/profile/script/hooks/DSL。预设库仍是可选起点,当前不执行用户提供的 pattern 文件
- 自定义 tool profiles 和 auto-approval 模式。工具安全边界继续由 agent definition、固定 Loop tool profile allowlist、permission/HITL 管道承担

---

## 12. 风险目录与缓解

来自 loop-engineering failure-modes + 社区案例 + ArchCode 特定风险。

| 风险 | 严重度 | 触发场景 | 缓解 |
|---|---|---|---|
| **Infinite fix loop** | S1 | Reviewer 拒绝 → build 重试 → 再拒绝 | `retryPolicy.maxRetries` + 超限 escalate |
| **Token burn** | S1 | Loop 无人看跑;死浏览器 tab 不停 | Budget hardStop + 心跳超时自动 pause + kill switch |
| **Reviewer theater**(Reviewer 形同虚设) | S1 | Reviewer 与 build 共享 store → 被带偏 | 强制独立 session store + 默认拒绝 prompt + 工具集硬编码 |
| **State rot** | S2 | crossRunState 写错 → 基于错状态跑 | state.md 人类可读 + git 可审计 + `PATCH /state` API 手动 unstick |
| **Compaction 漏掉 Done 条件** | S2 | 长跑 Goal,compaction 把 Done 条件摘要丢了 | Done 条件在 `goal.json` 持久化,不在对话上下文里——compaction 不影响 |
| **Comprehension debt spiral** | S2 | Loop 跑久了,架构师不懂项目现状 | 每次 run 产 run-log + summary;UI 强制展示 last summary |
| **Self-improvement context poisoning** | S2 | bad suggestion 写入 memory | memory_write 已有 secret 拒绝;loop-write guard:禁止 loop 写 `knowledge/`,只写 `state.json` |
| **Over-reach** | S2 | Loop 擅自做大改动 | Phase 4 用 tool profile、approvalPoints、collision guard 和 kill switch 限制风险;L2 minimal-fix 是未来 advisory |
| **Parallel collision** | S3 | 多 loop 同分支并发改 | Phase 4 用 collision guard 阻止已知目标冲突;Phase 5 用持久队列、同分支节流、`maxConcurrent` 和 worktree 隔离降低并发风险 |
| **Escalation failure** | S3 | escalate 后无人看 → 永久挂起 | `waitedMs` 超期 → UI 红标 + 通知 |
| **Notification fatigue** | S3 | Loop 频繁 escalate | noise 列表 + 同类 issue 折叠 + 用户可调阈值 |
| **HITL 断线残留** | S2 | SSE 断线,pending HITL 永不 resolve | 复用现有 deferred 超时/abort 安全 resolve(approval timeout, question cancelled) |
| **Workflow 删除回归** | S2 | 删 Workflow 破坏现有用户数据 | `.archcode/workflows/` 目录保留只读(不删用户数据),但 runtime 不再读写;迁移工具后续提供 |

---

## 13. 触点清单

实现时按此追踪。

| 文件 / 目录 | 变更 |
|---|---|
| `packages/protocol/src/types.ts` | +GoalState(含 phase/author/lockedBy) +LoopState +DoneCondition(discriminated union) +ScheduleSpec +BudgetSpec +HitlRequest +SSE 事件 |
| `packages/agent-core/src/config/schema.ts` | `agents` 改 `z.strictObject` 强制 6 agent(orchestrator/plan/build/reviewer/explore/librarian),无 `goals?`/`loops?` 节(运行时创建) |
| `packages/agent-core/src/goals/` | **新建** types/state/runner/done-checker/retry |
| `packages/agent-core/src/loops/` | **新建** types/state/scheduler/runner/budget/patterns/coordination |
| `packages/agent-core/src/hitl/` | durable project-scoped queue + service(**不合并** PermissionService/AskUserService,新增独立 service) |
| `packages/agent-core/src/agents/workflow/` | **删除整个目录** |
| `packages/agent-core/src/agents/definitions/{product,spec,critic,foreman,builder,reviewer,librarian}.ts` | **删除 7 个 workflow 角色** |
| `packages/agent-core/src/agents/definitions/{plan,build,reviewer,librarian}.ts` | **新建 4 个 agent 定义**(orchestrator/explore 保留改造) |
| `packages/agent-core/src/tools/builtins/workflow/` | **删除整个目录**(8 个 workflow 工具) |
| `packages/agent-core/src/tools/builtins/goal-check-done.ts` | **新建** |
| `packages/agent-core/src/tools/builtins/human-check.ts` | **新建**(HITL 工具,3 种 kind:question 含选项 / approval 被 permission 模块调用来呈现+拿决策 / review 新能力) |
| `packages/agent-core/src/tools/builtins/loop-write-state.ts` | **新建** |
| `packages/agent-core/src/store/helpers.ts` | `SessionFileSchema` +`goalId?` +`loopId?` +`sessionRole?` |
| `packages/agent-core/src/projects/types.ts` | `ProjectContext` -workflow +`goalState: GoalStateManager` +`goalArtifacts` +`goalMemory` +`hitl: HitlService` |
| `packages/agent-core/src/projects/context-resolver.ts` | +工厂 +实例化 |
| `packages/agent-core/src/runtime.ts` | `AgentRuntime` +Goal/Loop CRUD +`scheduler: LoopScheduler` +`hitl: HitlService` |
| `apps/server/src/routes/goals.ts` | **新建** |
| `apps/server/src/routes/loops.ts` | **新建** |
| `apps/server/src/routes/hitl.ts` | durable project-scoped HITL 队列 + respond/cancel,支持 redacted display payload 和 goalId/loopId 过滤 |
| `apps/server/src/routes/workflow.ts` | **删除**(如存在) |
| `apps/server/src/app.ts` | -mount workflow,+mount goal/loop/hitl |
| `apps/server/src/main.ts` | +`new LoopScheduler(runtime).start()` 注入 + state recovery-scan |
| `apps/server/src/boot.ts` | +graceful shutdown `scheduler.stop()` |
| `apps/web/src/router.tsx` | 重设计:Dashboard + Projects + Goal/Loop 详情 |
| `apps/web/src/store/{goal,loop,hitl}-store.ts` | **新建** |
| `apps/web/src/api/{queries,mutations}.ts` | +goal/loop/hitl hooks |
| `apps/web/src/context/global-sse.tsx` | +goal/loop/hitl event case |
| `apps/web/src/components/features/` | +Goal/Loop/ApprovalQueue/Dashboard/GoalArtifacts 组件集;-PipelineStepper -StateTab(workflow) |
| `README.md` | config 文档同步(AGENTS.md 约定):6 agent 必填,无 goals/loops 节 |
| `AGENTS.md` | 更新 agent 架构表(6 agent)、工具表(删 workflow 工具,加 goal/hitl/loop 工具)、目录结构 |

---

## 14. 不做什么

- ❌ Phase 1-4 不做 cron / trigger 调度;Phase 5 已确认支持 cron 和 `triggers[]`
- ❌ Phase 5 不做用户自定义 pattern registry/profile/script/hooks/DSL。预设库已足够起步
- ❌ 不做独立 worker 进程(单进程足够,v3 视扩展)
- ❌ Phase 5 不做 loop-audit CLI、readiness score、readiness gate 或 readiness scheduler。`readinessScore` 只保留 null 兼容占位
- ❌ 不做 OpenHands 式训练 critic 模型(研究阶段,成本高)
- ❌ 不做 Kiro EARS notation + property testing(太正式,IDE 中心)
- ❌ 不做"loop 自主改进项目"(误用,不是功能)
- ❌ 不做 Workflow 渐进迁移(用户要求全删无 fallback)
- ❌ 不做 state.md 双向同步(state.json 是 source of truth,state.md 只读视图)
- ❌ 不把缺失 model pricing 当零成本。provider model pricing 是可选 metadata;缺失时 USD budget enforcement 不可用。
- ❌ Phase 2 不做 checkpoint/rollback/rerun 功能
- ❌ Phase 2 不做 artifact versions/revisions/latest 指针
- ❌ Phase 2 不做 Safe/Balanced/Brave approval modes
- ❌ 不做 headless / daemon 部署模式(用户自行部署到 always-on 主机,文档指引即可)
- ❌ 不争"AI 写代码更好"(不与 Cursor/Claude Code 竞争)
- ❌ 不争"自主 AI 工程师"(不与 Devin 竞争)
- ❌ 不争"终端体验"(不与 Warp/Claude Code 竞争)

---

## 15. 附录:loop-engineering 借鉴

### 15.1 借鉴什么

| loop-engineering 概念 | ArchCode 对应 | 说明 |
|---|---|---|
| 6 primitives + memory | §2 三层原语 + 现有 memory system | Automations→Schedule, Worktrees→(L3 可选), Skills→AGENTS.md+memory, Connectors→MCP, Sub-agents→6-agent, Goals→Goal 原语(loops 发现持续工作,goals 完成有界任务), State→crossRunState |
| L0-L3 readiness | §11 分阶段路线 | 对齐 |
| 7 patterns | §7.4 预设库(可选,不强制) | 作为快捷起点,不是硬编码分类 |
| STATE.md git-tracked | `.archcode/loops/{id}/state.md`(只读视图)+ `state.json`(source of truth) | state.md 人类可读 + git 可跟踪,state.json 机器读写 |
| loop-run-log.md JSONL | `.archcode/loops/{id}/run-log.jsonl` | 每次 run 追加一行 |
| loop-budget.md per-loop 限制 | `BudgetSpec` + on-exceed protocol(pause + log + escalate) | 代码强制,不是文档约定 |
| kill switch(loop-pause-all) | `killSwitch` 字段(全局 + per-loop)+ API | 代码强制 |
| stagnation circuit breaker(Steinberger) | `stagnationLimit`(默认 3 次 no-progress → abort) | 代码强制 |
| denylist for auto-merge paths | `approvalPoints` 默认(security/payments/auth 路径触发 `on_destructive_op`) | 配置驱动 |
| early_exit_required | `throttleAtPct`(80% 降级) | 代码强制 |
| maker/checker split 非协商 | §2.2 铁律 2 + §3.6 Reviewer day-one 强制 | 代码强制(独立 agent + 独立 store) |

### 15.2 不借鉴什么

| loop-engineering 概念 | 不借鉴原因 |
|---|---|
| CLI-first(loop-init/loop-audit/loop-cost) | ArchCode 是 Web UI first |
| GitHub Actions 作为 scheduler | ArchCode 有 in-process scheduler |
| Tool-specific starters(grok/claude-code/codex) | ArchCode 是 tool-agnostic,model 在 .archcode.json |
| 硬编码 pattern registry 作为唯一方式 | ArchCode 当前只用内置预设作为可选起点;用户自定义 pattern registry/profile/script/hooks/DSL 留未来评估 |
| STATE.md 手动维护 | ArchCode state.json 机器维护,state.md 是生成视图 |

### 15.3 ArchCode 相对 loop-engineering 的优势

- loop-engineering 是**文档+CLI 模式库**,包装现有工具(Grok/Claude Code/Codex)。ArchCode 是**统一产品**,原生 Goal/Loop/Session 原语 + Web UI + 持久 server + 多项目 + HITL。
- loop-engineering 依赖被包装工具的能力。ArchCode **拥有执行层**。
- loop-engineering 的 STATE.md 手动维护。ArchCode 的 state.json 机器维护,state.md 是生成视图。
- loop-engineering 无 HITL/审批门。ArchCode 有统一 HITL service + Goal approvalPoints(Goal 状态机阶段切换门)+ tool permission(单次工具调用门)两个独立门控层。
- loop-engineering 无 Reviewer 独立 agent。ArchCode 有强制 Reviewer + 独立 session store + 能跑工具。
