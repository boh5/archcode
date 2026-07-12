# 以 Work 为中心的持续交付 MVP

> 状态：产品方向假设。在进行任何运行时实现之前，必须先完成 MVP-0 验证。
>
> 日期：2026-07-12
>
> 本文档不取代 `docs/workbench-refactor/PRD.md`，也不授权进行全仓重构。它只记录一个候选产品模型、最小可行验证方案，以及正式投入这一方向前必须获得的证据。

> 历史约束：ArchCode 曾经构建、后来又退役过一套阶段门控的多 Agent Workflow。本方案不能以 Work 和 Phase 的名义重新建设同一套系统。第一次实验必须是现有原语之上的交互投影，而不是新的运行时原语。

## 1. 产品假设

ArchCode 当前是一个直接暴露 Session、Goal 和 Loop 的资源中心型工作台。候选演进方向是以 Work 为中心：用户只需要带来一件要完成的工作，并始终停留在一条连贯的对话中，由 ArchCode 共同澄清、规划并交付结果。

候选定位是：

> ArchCode 是一个常驻的 AI 产品工程工作台。你带来工作，ArchCode 与你共同澄清、规划和交付；你只参与关键决策，系统从最终结果中持续学习。

这是对现有“常驻工作台”定位的演进，不代表 ArchCode 要转型为无代码应用生成器、通用自动化平台或一人公司操作系统。

## 2. GStack 带来的启发

GStack 证明了：有明确立场的产品工程方法能够改善 Agent 的工作结果。值得学习的不是安装或复刻 GStack，而是把隐性的专家方法变成产品行为。

ArchCode 应该吸收：

- 实现之前先做产品发现；
- 阶段之间有清晰的交接；
- 从产品、设计、工程、QA、发布和复盘等不同视角审视工作；
- 区分机械性决策、品味决策和会改变方向的决策；
- 用独立上下文冷审需求简报或计划；
- 主动判断下一步应该使用什么方法；
- 使用浏览器和真实环境验证，而不是相信模型自述；
- 从已经完成的工作中沉淀经验。

ArchCode 不应该照搬：

- 暴露一大批斜杠命令；
- 只有人设差异、没有权限或上下文隔离的角色表演；
- 用一个超长上下文完成所有阶段；
- 强制简单任务走完整流程；
- 把文件系统中的 Markdown 当作唯一权威工作流状态；
- 静默替代用户的产品判断；
- 把输出量当成生产力指标。

## 3. 核心产品模型

候选的用户侧顶层对象是 `Work`。

一个 Work 代表一个边界明确的结果，例如：

- 研究一个产品决策；
- 增加一个功能；
- 调查并修复一个缺陷；
- 重构一个子系统；
- 审查并交付一个 Pull Request；
- 处理 Automation 发现的问题。

用户看到的是一条连续的 Work 对话。运行时可以在其下使用多个相互隔离的 Agent Session 和 Goal。

### 3.1 三个主要阶段

默认的产品阶段是：

```text
Discover -> Plan -> Deliver
                     |
                     v
                  Reflect
```

`Reflect` 是尽力而为的收尾协议，不是会阻塞完成的第四个阶段。

- `Discover` 降低对问题和目标结果的不确定性。
- `Plan` 降低对范围、方案、验收、验证和发布的不确定性。
- `Deliver` 实现、审查、测试并交付已经确认的结果。
- `Reflect` 对比最初意图、计划和实际结果，写入长期经验，并提出后续 Work 或 Automation。

产品用语采用 `Deliver` 而不是 `Build`，因为这一阶段还包含审查、测试、发布和非代码交付物。

### 3.2 Agent 决定阶段，运行时验证事实

以下内容描述的是验证通过后可能采用的目标模型。MVP-0 不会把阶段转换或阶段回执持久化为新的事实来源。

阶段不是僵硬的有向状态机。Work Lead 可以：

- 从任意阶段开始；
- 记录原因和假设后跳过某个阶段；
- 返回之前的阶段；
- 用新的阶段运行取代旧版本；
- 选择 Session 或 Goal 作为执行载体；
- 创建阶段内部步骤；
- 停止或取消整个 Work。

未来运行时只应约束持久性和真实性：

- 同一时间最多有一个主要 Phase Run 处于活跃状态；
- 阶段转换可持久化、可重放；
- 阶段完成必须提供结构化回执；
- 跳过阶段必须记录理由和假设；
- 实质性范围变化必须产生新的合同版本；
- Deliver 不能仅凭实现者的声明判定成功；
- 不可逆操作和长期 Automation 始终由用户控制。

原则是：

> Agent 决定下一步应该做什么，运行时记录并验证实际发生了什么，用户决定方向、品味和不可逆操作。

### 3.3 用 Phase Run 表达阶段回访

`PhaseRun` 只是用于思考阶段回访的概念模型，不是 MVP-0 的存储类型。

一个 Work 可以多次回到同一阶段：

```text
Discover v1
  -> Plan v1
  -> Deliver attempt 1
  -> Plan v2
  -> Deliver attempt 2
  -> Reflect
```

概念结构如下：

```text
Work
|- intent
|- status
|- contractVersion
|- decisionLog
`- phaseRuns[]
   |- kind: discover | plan | deliver | reflect
   |- carrier: session | goal | background
   |- carrierId
   |- state: active | completed | skipped | blocked | superseded | failed
   |- reason
   |- inputRefs
   |- outputRefs
   `- evidenceRefs
```

阶段、当前步骤和运行状态是三个不同维度：

```text
Phase: Plan
Step: Engineering review
Status: Waiting for user
```

## 4. 概念边界

| 概念 | 职责 |
|---|---|
| Work | 用户想要的结果及其持久生命周期 |
| Phase | 当前正在降低哪一类不确定性 |
| Agent | 对某个结果负责的执行主体 |
| Skill | 可重复使用的决策程序或工作方法 |
| Tool | Agent 可以使用的能力 |
| Session / Goal | 执行和持久化载体 |
| Artifact | 阶段之间的结构化交接物 |
| Evidence | 用于证明声明或完成状态真实可信的证据 |

Phase、Agent、Skill 和执行载体之间不能建立一一对应关系。

## 5. MVP Agent 架构

MVP 应复用现有七种 Agent 身份，不新增 CEO、PM、Designer、QA、Release 或 Discover Agent。

```text
User <-> Work Lead（现有 Engineer）
            |
            |- Discover: Work Lead + Explore/Librarian
            |- Plan: Plan Session + Explore/Librarian
            |          `- 独立 Reviewer 冷审合同
            |- Deliver: 简单工作使用普通 Session
            |           `- 非简单工作使用 Goal Lead -> Build -> Reviewer
            `- Reflect: Work Lead 或后台结构化运行
```

### 5.1 Work Lead

现有 Engineer 在产品行为上承担 Work Lead，不要求新增模型配置。

职责包括：

- 对用户侧对话和最终 Work 结果负责；
- 判断工作类型并选择足够用的最小路径；
- 启动、跳过、阻塞、取代和完成 Phase Run；
- 选择 Session 或 Goal 作为载体；
- 维护当前合同和决策日志；
- 委派专业调查和执行；
- 整合各阶段回执；
- 汇总需要用户处理的决策；
- 识别实质性范围变化；
- 提议后续 Work 或 Automation。

Work Lead 只应直接交付范围集中、低风险的工作，不能让简单任务陷入流程仪式。

### 5.2 Discover

MVP 负责人：主 Work Session 中的 Work Lead。

支持 Agent：

- Explore：收集本地源码和项目证据；
- Librarian：收集最新外部证据和文档；
- Reviewer：必要时对 Discovery Brief 进行独立冷审。

Discover 保留在主对话中，因为提问、重新定义问题和接受用户纠正，本身就是这一阶段最重要的产品体验。

### 5.3 Plan

MVP 负责人：隔离子 Session 中的现有 Plan Agent。

Plan Agent 接收已经确认的 Discovery Brief 和相关证据，而不是完整的 Discover 对话。它只生成 Execution Contract，不负责实现。

独立 Reviewer 从完整性、一致性、清晰度、范围、可行性和可测试性等方面审查合同。

### 5.4 Deliver

MVP 负责人：

- 简单、局部、可逆的工作由普通 Session 中的 Work Lead 负责；
- 非简单、长期运行、多 Agent、需要预算、需要恢复或独立审查的工作由 Goal 中的 Goal Lead 负责。

锁定后的 Execution Contract 是 Goal 的输入。如果出现实质性歧义或范围变化，控制权必须返回 Work Lead，不能静默修改 Goal。

### 5.5 Reflect

MVP 负责人：Work Lead，或一次尽力而为的后台结构化运行。

Reflect 不需要专用 Agent 身份或 Goal。它对比意图、决策、合同、交付证据和用户干预，可以提出新的 Work 或 Automation，但不能静默执行。

## 6. Prompt 和上下文架构

每次阶段调用接收四层上下文：

1. 简短、稳定的 Agent 角色提示词；
2. 结构化的 Work Phase Context；
3. 一个当前阶段方法 Skill；
4. 按需加载的证据引用。

不要把完整的历史对话传给每一个阶段。

### 6.1 Work Phase Context

```xml
<work-phase-context>
  <work-id>...</work-id>
  <phase>plan</phase>
  <phase-attempt>1</phase-attempt>
  <user-intent>...</user-intent>
  <approved-input ref="discovery-brief:v2" />
  <known-facts>...</known-facts>
  <assumptions>...</assumptions>
  <decisions>...</decisions>
  <constraints>...</constraints>
  <evidence-refs>...</evidence-refs>
  <required-output>ExecutionContract</required-output>
  <stop-conditions>...</stop-conditions>
</work-phase-context>
```

### 6.2 阶段回执

每个阶段都返回结构化回执：

```text
status: ready | needs_user | blocked | failed
summary
artifact
evidenceRefs
decisions
unresolvedItems
recommendedNext
```

Agent 声称自己已经完成，不等于回执，也不等于证据。

## 7. MVP Skills

只增加四个阶段方法 Skill。

### 7.1 `discover-work`

目的：把模糊意图转化为可以进入规划阶段的 Discovery Brief。

必要行为：

- 将工作识别为产品想法、功能、缺陷、重构、研究、PR/发布或其他边界明确的类型；
- 先调查，再向用户提问；
- 分别记录事实、假设、未知项和有争议的判断；
- 只询问会改变方向、范围、验收或安全性的关键问题；
- 挑战会显著影响结果的前提；
- 生成有实际差异的备选方案；
- 根据工作类型调整深入程度；
- 不进入实现；
- 输出 Discovery Brief 和明确的未决事项。

### 7.2 `plan-work`

目的：把已经确认的 Discovery Brief 转化为可执行、可验证的 Execution Contract。

必要行为：

- 验证输入简报；
- 按需检查源码和外部证据；
- 根据任务需要，从产品、范围、设计、工程、测试、发布、安全和开发体验等角度审视方案；
- 输出目标、范围、非目标、验收条件、推荐方案、有序工作项、责任归属、验证方式、发布、回滚、风险、假设和用户决策；
- 建议 Deliver 应使用 Session 还是 Goal；
- 不进入实现。

### 7.3 `review-contract`

目的：在不知道创作对话的情况下，独立冷审 Discovery Brief 或 Execution Contract。

输出：

- `READY`；或者
- `NOT_READY`，并附上具体未决事项、影响以及需要的修正或用户决策。

### 7.4 `reflect-work`

目的：对比初始意图、合同、决策、交付回执、审查结果和用户干预。

输出：

- 实际结果与最初意图的差异；
- 正确和错误的假设；
- 返工来源；
- 值得长期保存的项目和用户经验；
- 后续 Work 提案；
- Automation 提案。

证据收集和 Deliver 工作继续复用现有 `codemap`、`research-docs`、`safe-refactor`、`review-work` 和 `git-master` Skills。

## 8. 用户决策

阶段 Agent 不应创建彼此竞争的用户对话。

目标模型是：

```text
Phase Agent
  -> Decision Request
    -> Work Lead 汇总并展示
      -> 用户回答
        -> 结构化答案恢复对应的 Phase 载体
```

Decision Request 包括：

- 问题本身；
- 它为什么会改变结果；
- 推荐选择；
- 可行选项；
- 如果暂缓决定，默认采用什么假设；
- 推迟决策的代价。

MVP 可以复用现有 `ask_user` 和 HITL 聚合，但 Work UI 应始终保持一个连贯的产品声音。

## 9. Work 管理协议

MVP-0 不引入 `work_manage` 工具或持久化 Work 状态机。Work Lead 首先应通过普通对话、Skills、现有 `todo_write`、`goal_create`、HITL 和 Session/Goal 事件表达建议。

只有验证证明投影无法维护真实可信的 Work 级状态后，才可以评估一个范围狭窄的 `work_manage` 协议。它只是验证后的候选能力，不属于初始 MVP。

候选动作包括：

```text
start_phase
complete_phase
skip_phase
block_phase
request_decision
supersede_phase
revise_contract
finish_work
propose_automation
```

未来协议也不能硬编码转换图。只有当真实 Work 使用已经证明这些要求存在时，它才可以验证阶段回执、证据、合同版本、活跃归属和用户控制约束。

## 10. 用户体验

验证通过后的候选方向，是让项目主导航以 Work 为中心。MVP-0 不改变导航，MVP-1 也只在功能开关后提供投影视图。

候选信息架构：

```text
全局：Home / Attention | Projects | Automations | Settings
项目：Work 列表 | 当前 Work 对话 | Context / Contract / Evidence
```

Work 顶部只显示主要阶段：

```text
Discover | Plan | Deliver
```

当前子步骤和运行状态分开显示：

```text
Phase: Plan
Step: Engineering review
Status: Waiting for user
```

默认时间线事件包括：

- 阶段开始；
- 当前理解；
- 需要决策；
- 阶段完成；
- 合同批准或修订；
- 交付进度；
- 验证结果；
- 交付回执；
- 复盘；
- Automation 提案。

Session、Goal、子 Agent、工具调用和原始证据仍然可以检查，但不再被设想为用户必须理解的多个并列顶层对象。

## 11. Goal 和 Automation

Goal 继续作为核心运行时原语，在候选模型中承担内部 Deliver 载体。只有 Work 视图得到验证后，才可以考虑不再把独立 Goals 列表作为一级导航。

Loop 继续作为定时和事件驱动工作的内部运行时原语，候选用户侧名称是 `Automation`。

Automation 需要独立管理，因为它的生命周期长于单个 Work，而且需要触发器、计划、预算、权限、运行历史、暂停和恢复控制。它仍然与 Work 关联：

```text
Work A -> Automation -> finding -> Work B
```

Automation 仍然通过对话提出，并且必须由用户批准创建。

## 12. 历史约束：不要重建已经退役的 Workflow

ArchCode 已经在运行时层面进行过一次相似的产品实验。

2026-05-18，提交 `8bdc241` 引入了一套涉及 63 个文件、增加 4,794 行代码的 Workflow MVP，包括：

- `Product -> Critic -> Spec -> Critic -> user approval -> Foreman -> Builder/Reviewer`；
- 持久化的八阶段转换图；
- 七种 Workflow 角色 Agent；
- Workflow 专用 Artifact、权限、工具、路由和 UI；
- 阶段门、重试规则、证据和交接机制。

2026-07-01，提交 `6f58f26` 和 `db46ab8` 删除了活跃的 Workflow 运行时，并用 Goal UI 取代其产品界面。`docs/workbench-refactor/TDD.md` 保留下来的架构结论是：产品策略不应该嵌入庞大的硬编码运行时工作流。Workflow 中真正重要的约束已经迁移到通用 Agent 权限、Goal 验证、HITL、预算和 Session 证据中。

如果当前方案同时引入新的 Work 实体、PhaseRun 存储、阶段专用 Agent、Artifact API、路由和一级 Work UI，它就与旧方案高度相似。这种版本不应该建设。

安全的解释是：

- `Work` 最初只是 root Session 及其关联 Goal、HITL、子 Session、证据和后续工作的用户体验投影；
- `Discover`、`Plan` 和 `Reflect` 是由 Skills 和 Prompt 表达的可选方法；
- `Deliver` 复用 Goal，而不是取代 Goal；
- 在持久化需求被证明之前，阶段标签只是建议性的展示元数据；
- 验证期间继续保留 Goals 和 Loops，不删除、不迁移、不改名；
- 不为阶段增加新的固定 Agent 身份。

这一约束把方案从一次架构转向，变成了一个可逆的产品实验。

## 13. MVP 实施边界

### MVP-0：人工辅助验证，不改运行时

第一次验证使用当前产品和现有原语：

1. 从普通 Engineer Session 开始；
2. 在不确定性足够高时，使用实验性的 `discover-work` Skill 或 Prompt；
3. 在同一对话中生成简洁的 Execution Contract 提案；
4. 只为非简单工作委派独立的 Plan/Reviewer 冷审；
5. 当合同已经就绪且确实需要长期执行时，提出 `goal_create`；
6. 让现有 Goal Lead、Build、Reviewer、HITL 和证据链路完成交付；
7. 完成后在 root Session 中写一份简短复盘；
8. 针对真实任务记录路径选择、用户改判、问题价值、范围变化、Reviewer 失败和重新进入体验。

MVP-0 不需要 Work schema、PhaseRun 存储、路由、导航替换或 `work_manage` 工具。

### MVP-1：只有 MVP-0 获得证据后，才增加轻量投影

如果 MVP-0 验证了这种交互，最小产品实现是：

1. 把 Work 表示为现有 root Session、子 Session 树、Goal、HITL 和事件的只读投影；
2. 让 Engineer 在产品行为上演进为 Work Lead；
3. 增加 `discover-work`、`plan-work`、`review-contract` 和 `reflect-work`；
4. 在主 Work Session 中执行 Discover；
5. 在委派的 Plan Session 中执行 Plan，并对合同进行独立冷审；
6. 为已经批准的非简单合同自动创建 Deliver Goal；
7. 把 Goal 执行和提问投影回 Work 对话；
8. 交付后生成尽力而为的 Reflect 回执；
9. 在保留当前 Session、Goal 和 Loop 导航的前提下，通过功能开关暴露 Work 投影。

第一次验证明确不包含：

- 新的固定 Agent 身份；
- 通用 DAG 或工作流编辑器；
- 用户自定义阶段；
- 大型 Skill 目录；
- 以 Agent 头像作为主导航；
- 完整的浏览器 QA 和部署自动化；
- Skill 市场；
- 投影证明有用之前的全产品存储迁移；
- 删除 Goal 或 Loop 内部实现；
- 新的 Work 数据库或权威 Work schema；
- 持久化 PhaseRun 生命周期；
- 在观察到投影限制之前增加 `work_manage` 工具；
- 在获得对比可用性证据之前替换主导航。

## 14. 产品转向前的验证门槛

以下假设得到验证之前，这个方向不能触发大规模重构：

1. 与显式选择 Session 或 Goal 相比，用户更喜欢从一条 Work 对话开始。
2. Discover 能改善合同质量，同时不会带来无法接受的流程负担。
3. 系统能够为简单工作正确跳过 Discover 或 Plan。
4. 自动从 Plan 交接到 Goal 能减少重复输入和模式管理。
5. 与分散的 Session、Goal 和 Loop 列表相比，Work 级聚合更容易理解。
6. 实现开始后的实质性范围变化减少，因验收条件模糊导致的 Reviewer 失败减少。
7. 当转换理由和证据可见时，用户能够理解并信任 Agent 控制的阶段转换。

候选指标：

- 从第一条消息到批准 Execution Contract 的时间；
- 用户问题数量，以及其中真正改变合同的问题比例；
- 需要用户手动选择模式或原语的 Work 比例；
- Deliver 开始后的实质性范围变化；
- 因需求不明确导致的 Reviewer `NOT_DONE`；
- 不同 Work 类型的完成率；
- 用户推翻自动阶段选择的比例；
- 后续 Work 和 Automation 的采用情况。

## 15. 决策规则

不能仅凭本文档就进行一次从资源中心到 Work 中心的产品重写。

下一步应该是在当前 Session 和 Goal 体验内进行人工辅助实验，不增加 Work 投影，也不改变存储，只测试一条端到端路径：

```text
Discover Session -> Plan Session -> Deliver Goal -> Reflect
```

只有真实使用证明这条路径改善了清晰度、完成率和信任，ArchCode 才应增加轻量 Work 投影。把 Goals 移出一级导航、把 Loops 改名为 Automations、增加权威 Work 存储或泛化工作流模型，都需要第二道、更强的证据门槛。
