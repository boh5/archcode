# Multi-Agent 委派控制面硬切计划

> 状态：待用户 Review 后实施。
>
> 目标：不改变 ArchCode 现有 AgentDefinition、Session、Execution 和 Agent Tree 架构，只补齐可委派 Agent 的完整控制工具，并让父 Agent 能用现有 Queue / Steer 机制向正在运行的直接子 Agent 发消息。

## 1. 最终结果

模型侧委派工具固定为七个：

```text
delegate
list_agents
send_message
background_output
wait_for_reminder
cancel_session
resume_session
```

其中 `send_message` 是唯一的父子消息工具。它表达“向正在运行的直接子 Agent 发消息”，参数 `delivery: "steer" | "queue"` 只决定消息进入当前 Execution 的下一模型 Step，还是排队进入下一次 Execution。

现有基础保持不变：

- 每个 Agent 的工具仍由自己的 `AgentDefinition` 手工配置；
- 子 Agent 仍是独立、持久的 Session 和 Execution；
- `SessionExecutionManager` 仍是 Execution 生命周期、并发、取消、恢复的唯一权威；
- 继续复用现有 `pendingMessages`、Steer mailbox 和 Queue dispatcher，不建立第二套消息系统；
- `resume_session` 仍保持原 Agent、Profile、Skills 和责任；
- Web 现有 Agent Tree 和子 Session 只读界面不变。

## 2. 已锁定的工具边界

| 工具 | 允许范围 | 核心语义 |
| --- | --- | --- |
| `delegate` | 直接子 Agent | 创建持久子 Session |
| `list_agents` | 当前调用者以下完整后代树 | 只读紧凑状态，不返回会话正文 |
| `send_message` | 正在运行的直接子 Agent | `steer` 当前 Execution；`queue` 下一 Execution |
| `background_output` | 直接子 Agent | 读取工作结果 |
| `wait_for_reminder` | 直接子 Agent | 等待终态 Reminder |
| `cancel_session` | 任意后代 | 立即中断并级联目标子树 |
| `resume_session` | 已停止的直接子 Agent | 用原身份继续工作 |

所有工具都拒绝跨 Root。除 `list_agents` 和 `cancel_session` 的明确后代范围外，工作交接坚持直接父子关系；父 Agent 不能读取孙级 transcript，也不能向孙级直接发消息或恢复孙级。

本轮不增加兄弟通信、跨 Root 通信、child 主动广播、Pause、close/delete、共享任务池、新 Agent registry、新 UI 控制台或父 Agent 自动唤醒。

## 3. 目标设计

### 3.1 显式配置完整工具包

将七个工具名放进一个共享常量：

```ts
const DELEGATION_CONTROL_TOOLS = [
  TOOL_DELEGATE,
  TOOL_LIST_AGENTS,
  TOOL_SEND_MESSAGE,
  TOOL_BACKGROUND_OUTPUT,
  TOOL_WAIT_FOR_REMINDER,
  TOOL_CANCEL_SESSION,
  TOOL_RESUME_SESSION,
] as const;
```

- Lead、Discussion、Analyst、Build 在各自 `AgentDefinition.tools.tools` 中显式写入 `...DELEGATION_CONTROL_TOOLS`；
- Explore、Librarian 不写入该常量，因此没有委派能力；
- `AgentDefinition` 继续是唯一授权来源；Factory 不自动注入工具，也不增加新的“完整包”运行时校验；
- Factory 只保留已有的深度和合法目标过滤：只能移除 Definition 已授权的委派工具，不能新增工具；
- 删除旧 `DELEGATION_CORE_TOOLS`、Lead 专属注入和兼容别名，不保留双路径或墓碑测试。

### 3.2 一个 `send_message`，复用现有 Queue / Steer

输入契约：

```ts
{
  session_id: string;
  expected_execution_id: string;
  message: string;
  delivery: "steer" | "queue";
}
```

共同规则：

1. 目标必须是调用者正在运行的直接子 Session；`expected_execution_id` 必须等于目标当前 active Execution，防止状态变化后误投；
2. 消息先进入目标 Session 已有的 `pendingMessages`，来源扩展为 `parent_agent`，并保存发送者 Session、Agent 和 Execution 等审计信息；消费后，同一 provenance 必须写入 canonical input message，并在模型投影中明确标为父 Agent 消息；
3. Agent 消息不是用户授权，不能解决 HITL、批准权限、修改配置/Profile/Skills 或扩大 workspace 范围；
4. 旧的 `user | automation` 消息仍按原路径工作。新增来源值和可选 provenance 不要求新增顶层持久字段；旧 canonical message 缺少 provenance 时只表示“既有外部输入”，不能反推为用户或 Automation，更不能当成父 Agent；
5. 如果目标在校验时已经停止，工具明确失败并提示使用 `resume_session`，不能暗中启动新 Execution。

工具调用复用现有 `inputRequestReceipts` 做持久幂等，不新建 delivery ledger。`clientRequestId` 由发送者 Session、Execution、run ordinal、Tool Batch 和 Tool Call 确定性生成；fingerprint 同时覆盖目标 Execution、delivery、正文和 provenance。同一 Tool Call 重放返回同一消息结果，不得重复入队。

每个 active Execution 的现有 Steer gate 扩展为统一的 message admission gate：Queue 或 Steer 在写入前先登记 in-flight operation；Execution 终结时先关闭 gate，再等待这些 operation 全部落定，最后才能判断“继续 Queue 链”还是“发送终态 Reminder”。该 gate 和 operation set 只属于 `SessionExecutionManager` 的当前运行资源，不新增持久状态或服务。

`delivery: "steer"` 的精确定义：

- 消息绑定当前 child Execution，并尝试进入其现有 Steer mailbox；
- 在同一 Execution 的下一次模型 Step——实现上的下一次 `runModelAttempt`——开始时，先由 `consumeSteers()` 提交消息，再构建模型消息；
- 它不能改写已经发出的 Provider 请求，也不强行中断正在执行的工具批次；
- 如果当前 Step 后没有下一 Step、Steer gate 已关闭或投递竞态失败，claim 回滚，消息保留在 Queue，绝不丢失；
- `send_message` 等待这次 claim 落定：canonical message 确实绑定 `expected_execution_id` 才返回 `steered`；rollback 或被后续 Execution 消费则返回 `queued`。判定复用 receipt 和 canonical message，不增加投递状态机。

`delivery: "queue"` 的精确定义：

- 消息不进入当前 Execution；当前 child Execution 正常结束后，由扩展后的现有 Queue dispatcher 为同一 child 启动下一次 Execution；
- 新 Execution 继续使用原 Agent、Profile、Skills 和责任；
- 如果当前 Execution 失败、取消或无法继续自动派发，消息保持 queued；直接父 Agent 后续调用 `resume_session` 时，resume 指令和已有 queued 消息一起进入新的 Execution，不得绕过或覆盖已有消息。

`SessionInputService` 从“只处理 Root 用户输入”收口为 Session 输入状态的统一所有者：外部用户/Automation 入口继续只允许 Root；`parent_agent` 入口只允许当前 Runtime 已验证的直接父子关系。`SessionExecutionManager` 继续负责是否存在可接收 Steer 的 live Execution，以及新 Execution 的 admission。

现有 Queue dispatcher 目前只扫描 Root 且要求 family idle，因此不能原样调用。应在同一个 Manager 内把它扩展为“扫描有 queued 输入的 Session”：Root 仍保持 family-idle 规则；child 只有在自身无 active Execution 且上一 Execution 正常完成时才自动启动，允许祖先 Execution 仍在运行，但必须重新校验 durable child identity、parent/root lineage、并发槽和已有 child dependency。并发槽不足等临时错误保留 Queue，等待 Runtime activity 变化后重试；cwd/lineage/Definition 等不会自行恢复的错误写 dispatch barrier、停止自动重试并发送 `queue_dispatch_blocked` Reminder，避免热循环。进程启动 recovery 也扫描 child Queue。不得另建 child dispatcher。

Child Queue 形成一条连续工作链，而不是互不相关的静默 Execution：

- 上一 Execution 的全部 `ToolChildSessionLink` 先正确落为终态；只要仍有符合自动派发条件的 queued 消息，就不发送中间终态 Reminder；
- 下一 Execution 使用 queued message 的 sender/tool provenance，在直接父 Session 中创建 `toolName: "send_message"`、`background: true` 的新 Link；同一批包含多个 Tool Call 时，各 Tool Call 都关联同一个 child Execution，按 `childExecutionId` 一起结算，但只发一条 Reminder；
- 每次续跑都重新应用父 Agent 当前 Definition 的 `maxConcurrent`、`timeoutMs`、`abortCascade` 和 `terminalReminders`。若原发送者 Execution 仍 live，abortCascade 绑定其精确 signal；否则由既有 family/subtree cancel 负责级联；
- Execution Terminal Reminder 持久化 `childExecutionId`，按 `{sessionId, childExecutionId}` 去重；不增加 `chainId`。只有 Queue 已清空，或已存在的 Execution 失败/取消使 Queue 链停止时才发送；新 child Execution 启动时，任何更早且未消费的该 child Reminder 都被 supersede。
- 若下一 Execution 尚未创建就永久派发失败，单独写 `queue_dispatch_blocked` Reminder，携带 `blockedAfterExecutionId` 和安全错误信息；上一 Execution 及其 Link 仍保持真实终态，不能伪造成 failed。该 Reminder 仅在所指 Execution 仍为 latest 且没有更新 Execution 时有效。

不新增 `agentSteers`、Agent 专用 mailbox、投递状态机、独立 Steer Service、第二个 Queue dispatcher 或新调度器。

### 3.3 前端 Agent Tree 与 `list_agents` 共用一套权威

当前前端拓扑已经来自 `SessionStoreManager.buildSessionTree()`，但 child 状态仍由前端读取各级 `childSessionLinks` 后再次拼装。本轮必须把“拓扑 + 原始状态事实”统一在后端，避免 UI 与模型工具各算一遍：

1. Store 层把现有构树内部重构为一次 request-scoped family snapshot：每个 Session 只读取一次，保留校验后的完整 Session file map；`buildSessionTree()` 继续是其 summary wrapper，以及 parent/root、缺失节点、重复 ID、环检测和兄弟排序的唯一算法；
2. `AgentTreeProjection` DTO 放在 `@archcode/protocol`，纯投影逻辑放在 agent-core；StoreManager 只提供 durable snapshot，绝不导入或持有 ExecutionManager；
3. Runtime 在两个 Manager 之外组合 durable family snapshot 和一次批量 active-Execution snapshot，并把同一个 callback 注入模型工具；Server 只调用 Runtime 公共 API，不直达 agent-core 内部实现；
4. 现有 `GET /sessions/:root/tree` 保留 `root/children` 结构并在节点上增加状态事实，因此 Inspector 与删除范围等现有消费者继续使用同一接口；`list_agents` 从同一投影定位调用者、裁剪子树，再做紧凑分页；
5. 前端删除按 nested parent 再查 Session 并拼 `childSessionLinks` 的算法，只保留 label/icon、HITL attention 等展示映射；Root 的 `SessionFamilyActivity` 仍由现有 Runtime/SSE 作为独立 canonical fact，不伪装成单个节点 Execution status。

投影是只读的有界一致快照，不宣称整个 family 跨 Session 原子：它使用持久 revision/read barrier 和批量 active snapshot；捕获期间相关 revision 或 active identity 变化时进行有界重试，仍不稳定则返回明确 conflict。`list_agents` 和 GET 都不得在读取时触发 recovery 或写盘；启动恢复和 Runtime lifecycle 负责先行 reconciliation。

`list_agents` 每个节点只返回：

```text
session_id
parent_session_id
agent_type
profile
title
depth
latest_execution_status
active_execution_id
link_status
```

- `latest_execution_status` 使用现有 canonical Execution status；`link_status` 只从与 latest Execution ID 相同的 direct-parent Links 得出，同一 Execution 的多个 Link 状态必须一致，否则返回完整性错误；Root 或无 Link 时为 `null`，不发明第三套 Agent 状态；
- `active_execution_id` 仅在 Runtime 确有 active Execution 时返回；
- 不返回 transcript、reasoning、Prompt、Tool input/result 或附件正文；
- 使用确定性深度优先顺序和简单游标分页，每页最多 100 个节点；游标只保证同一捕获数据集内稳定，workspace、Root、调用者不匹配或游标被篡改时失败；
- `execution-start/end`、Link 变化和相关 Runtime 事件必须使前端 Tree query 失效；Projection 若在 Runtime 已 ready 后仍发现不允许的 durable/live 组合，返回 conflict，不猜测也不修复。

### 3.4 Cancel、Wait、Resume 只收紧现有语义

`cancel_session` 不建立新的服务或持久取消状态，但强保证需要由 `SessionExecutionManager` 持有一个临时 subtree-stop lease：

1. 校验目标属于调用者的后代子树；
2. 同步取得 subtree-stop lease；所有 start/resume/delegate/Queue admission 都必须拒绝进入该子树，pending child launch 记录补充 `parentSessionId` 以便精确判断 lineage；
3. 立即对目标及后代 active run 发出 abort，覆盖模型 Stream、Tool 和子进程；关闭其 message admission gate，并等待已经登记的 Queue/Steer 写入落定；
4. 终结 suspended Tool Batch/HITL，等待已经通过校验但尚未启动的 child launch，并反复扫描取消期间已经形成的新后代；
5. 对目标子树每个 Session 写入晚于当前 pending input 的 `queueDispatchBarrierAt`，保留消息供以后显式 resume，但禁止 cancel 返回后自动复活；
6. 复用现有 abort-and-wait/re-scan，直到终态、Link、Reminder 和 barrier 全部持久化，再释放 lease；返回 `cancelled` 时子树已无 active/suspended Execution、pending launch 或可自动派发 Queue。只有整棵子树原本已终态且没有可派发 Queue 时才返回 `already_stopped`。

`wait_for_reminder` 保留直接子范围，但修正 any/all/count 都按不同 child Session 计算，并只接受该 child 当前 latest terminal Execution 的 Reminder，或仍卡在该 latest Execution 之后的 `queue_dispatch_blocked`。订阅只负责唤醒；“选择 Reminder + 标记 consumed”必须通过一次 durable Store mutation 原子完成，因此同一个 child 不会重复计数，并发 wait 也不能消费同一条 Reminder。

`resume_session` 继续只接受已停止的直接 child，并保持原身份。若 child 存在 barrier 后保留的 Queue，SessionInputService 在一次原子 mutation 中认领 Queue prefix、追加 resume instruction、绑定同一个新 Execution/run 并清除 barrier；固定顺序为旧 Queue 在前、resume instruction 在后。它不是消息 Queue 的替代品，只负责显式开始下一 Execution。

## 4. 实施顺序

1. **工具包硬切**：新增 `list_agents`、`send_message`；建立共享七工具常量；四类可委派 Agent 手工展开，终端 Agent 不配置；删除旧常量和 Lead 特例。
2. **统一消息输入**：扩展 pending/canonical message 的 `parent_agent` provenance；复用 receipt 做 Tool Call 幂等；把 Root-only 限制下沉到外部入口；把现有 Steer gate 泛化为每 Execution 的 message admission gate。
3. **接通 Queue / Steer**：扩展同一个 dispatcher 支持 child admission、临时/永久错误分类、并发槽重试和启动 recovery；补齐 missed-Steer 回滚、按 Execution 结算全部 Link、带 Execution ID 的链尾 Reminder，以及 resume + Queue 原子输入。
4. **统一 Tree 并补齐控制**：建立一次读取的 family snapshot 和 Runtime 组合投影；让前端 Tree 与 `list_agents` 共用事实；删除前端 child 状态重建；在 Manager 内实现 subtree-stop lease、Queue barrier 和原子 Reminder 消费。
5. **同步契约并验证**：更新工具描述、Prompt、AGENTS.md 和相关测试；清理旧路径；执行全仓验证和独立实现 Review。

## 5. 风险与非目标

- **消息竞态**：child 可能在校验和投递之间结束。以 `expected_execution_id`、既有 receipt、message admission gate、claim/rollback 和 durable Queue 保证不串 Execution、不重复、不丢消息。
- **立即取消的边界**：abort 必须立即发出，但工具只有在清理和终态落盘后才返回成功；不承诺外部不可中断系统调用瞬间退出。
- **来源权限**：父 Agent 消息会进入 canonical Session history，但必须永久保留 `parent_agent` 来源，不能伪装成用户授权。
- **历史 Session**：本轮不增加必填顶层字段，不写迁移、双读或 fallback；旧 Session 继续读取。缺少 provenance 的既有 input 只显示为外部输入；缺少 `childExecutionId` 的旧 Reminder 保留可读，但不参与新版 execution-scoped wait，并在 child 启动新 Execution 时统一 supersede。不得按时间猜测来源或 Execution。硬切只删除旧代码路径和旧工具契约。
- **同步阻塞父 Agent**：父 Agent 正同步等待 child 的原 Tool Call 时，无法同时再发模型工具调用；本轮不增加用户直接操控 child 的新 UI/API。

## 6. 验收标准

以下 AC-01 至 AC-07 必须全部满足，缺少实现、自动化测试或可复查证据即为未完成。

### AC-01：工具授权保持原架构

- Lead、Discussion、Analyst、Build 的 Definition 均显式展开同一个七工具常量；Explore、Librarian 不配置该常量。
- 未达深度上限时四类可委派 Agent 都能看到七个工具；达到上限或没有合法目标时，Factory 只移除工具。
- Factory 没有自动注入或新的完整包校验；Profile、Skill、Prompt 不能改变 Runtime 工具权限。
- 生产源码不存在旧工具包、Lead 专属 cancel 注入、`steer_session` 名称、兼容别名或双路径。

### AC-02：拓扑权限准确

- 测试覆盖本 Agent、直接 child、孙级、兄弟、祖先和其他 Root：允许/拒绝结果与第 2 节表格完全一致。
- 仅知道 Session ID 不能绕过 workspace、Root 和 parent lineage 校验。
- `background_output` 仍拒绝孙级内容；`cancel_session` 只级联指定后代子树，不影响祖先和兄弟。

### AC-03：`send_message` 的 Queue / Steer 语义准确

- 同一个 `send_message` 工具支持 `steer | queue`，不存在第二个 child 消息工具。
- send_message 写入与 child 终态由同一个 message admission gate 线性化；终态决策必须关闭 gate 并等待全部 in-flight Queue/Steer operation，不能出现“先提醒完成、后落盘 Queue”。
- 成功的 `steer` 在当前同一 Execution 的下一模型 Step、模型消息构建前注入；不会进入下一 Execution，也不会打断当前已发出的模型请求或工具批次。missed Steer 才按既有规则回到 Queue。
- Steer gate 竞态失败时消息回到 durable Queue，结果返回 `queued`；只有 canonical message 绑定 expected Execution 才返回 `steered`，每条消息只进入一次 canonical history。
- `queue` 不进入当前 Execution；当前 child 正常结束后，同一 child 自动启动下一 Execution 并消费消息。
- 当前 Execution 异常结束时 queued 消息不丢；后续 `resume_session` 同时携带已有队列和 resume 指令。
- child Queue 允许祖先仍在运行，但必须等待目标自身空闲并重新通过 identity、lineage、并发槽和 dependency admission；临时无槽和进程重启会重试，不重复启动；永久 admission 错误停止重试、写 barrier 和 `queue_dispatch_blocked`，不得伪造不存在或已 completed 的 Execution 状态。
- 连续 Queue Execution 各自拥有来源正确的 background Link；同一 child Execution 的全部 Link 一起终态化。中间 Execution 不发 Reminder，链尾 Reminder 带 `childExecutionId` 且按 Session + Execution 去重。每次续跑都应用当前 childPolicy。
- resume 合并 Queue 的一次 mutation 同时完成 FIFO 认领、追加指令、Execution/run 绑定和 barrier 清除；崩溃后不存在只提交了一半的状态。
- stopped child、非直接 child、跨 Root 和错误 `expected_execution_id` 在写入前失败；不得误投到后来换代的 Execution。
- Session history、模型输入和审计保留真实 `parent_agent` 来源；Agent 消息不能解决 HITL 或扩大权限。
- Root 用户/Automation 的既有 Queue / Steer 行为和测试全部保持通过。

### AC-04：旧 Session 无存储破坏

- 不新增 `agentSteers` 或其他必填顶层字段；旧 session.json 能由新版严格 schema 直接读取。
- parent Agent 消息在已有 `pendingMessages` 和消费后的 canonical message 上使用同一可选 provenance；模型投影明确标识发送者。缺少 provenance 的既有 canonical input 只标为外部输入，不猜测具体来源。
- 幂等只复用已有 `inputRequestReceipts`，不新增 Agent 消息 ledger。
- 缺少 `childExecutionId` 的旧 Reminder 仍可展示，但 `wait_for_reminder` 不消费它；不存在时间推断或旧 Reminder fallback。
- 不存在 schema migration、fallback、双读、双写或“旧格式兼容”分支。

### AC-05：`list_agents` 真实、有界、不泄露

- Root 可看全部后代；中间 Agent 只能看自己的子树；terminal Agent 没有此工具。
- 前端 `/tree` 与 `list_agents` 必须调用同一个 Runtime 投影；Protocol/Store/Runtime/Tool/Server 的归属遵守 3.3，Store 与 Execution Manager 不形成双向依赖，Server 不直达内部实现。
- 一次 family snapshot 对每个 Session 只读取一次；Projection 不允许先构树再逐节点二次读取，也不存在第二套 parent/child 构树、兄弟排序或前端 child 状态拼装算法。
- 同一固定数据集下，前端嵌套树与工具分页结果的 Session ID、parent ID、顺序、Execution status、active Execution ID 和 Link status 完全一致；工具仅额外执行 caller 子树裁剪和分页。
- 返回字段严格限制为第 3.3 节所列内容，只使用已有 Execution 与 Link status。
- 同一 latest Execution 的多个 Link 状态全部一致才可投影；不得通过“取最后一个 Link”掩盖冲突。
- 稳定分页每页不超过 100 节点；稳定性仅承诺同一捕获数据集，跨 workspace、Root、调用者或篡改游标均失败。
- 正常读竞态按 revision/active identity 有界重试；仍不稳定或 Runtime ready 后出现非法 durable/live 组合时返回 conflict。GET 和只读工具都不得触发 recovery 写盘。
- `/tree` 保留 `root/children` 结构；删除对话框的后代范围、数量和 Automation 冲突判断保持正确。Execution/Link 事件会使前端 Tree query 失效；Root family activity 继续使用现有 SSE 权威。

### AC-06：Cancel、Wait、Resume 无歧义

- subtree-stop lease 建立后，任何 start/resume/delegate/Queue admission 都不能进入目标子树；pending launch 带 parent lineage，不能在最后一次扫描后漏启动。
- cancel 调用后立即 abort 目标子树中正在进行的 Provider Stream、Tool 和子进程，并终结 suspended HITL/Tool Batch；所有已登记 message operation 先落定。
- 返回 `cancelled` 前，active/suspended Execution、pending child launch 和取消期间形成的新后代都已收敛；终态、全部 Link、Reminder 和每个 Session 的 Queue barrier 已持久化，不存在可自动派发 Queue。
- `already_stopped` 仅表示整棵子树原本均已终态且没有可派发 Queue；已写 barrier 的旧 Queue 可由以后一次原子 resume 显式消费。
- 取消孙级不影响祖先和兄弟；只有目标整棵子树均已终态时返回 `already_stopped`。
- any/all/count 按不同直接 child 计数，只接受当前 latest terminal Execution 的 Reminder或仍有效的 `queue_dispatch_blocked`；选择和 consume 是同一次持久 mutation，并发 wait 不重复消费。
- 只有直接父 Agent 能 resume 已停止 child；恢复后 Agent、Profile、Skills 和责任不变。

### AC-07：验证与独立 Review

- 单元测试覆盖权限矩阵、receipt 重放、message-admission 终态竞态、claim/commit/rollback、Queue 临时错误重试、永久错误的 `queue_dispatch_blocked`、atomic resume、atomic Reminder consume、subtree-stop admission 和工具分页。
- Tree 契约测试证明：一次读取的 family snapshot、批量 live 组合、同 Execution 多 Link 一致性、读竞态 conflict、前端 API/工具投影一致；前端不再发 nested-parent 查询，删除范围消费者保持正确。
- 集成测试完成：Lead 启动后台 Analyst 与 Build → 查看 Agent Tree → steer Analyst → 连续 queue Analyst 两次并验证全部 Link、无中间 Reminder、链尾 Execution Reminder → 在 send_message/终态竞态中 cancel Build 的 Explore 子树并证明没有迟到 launch/Queue 自动复活 → 读取结果 → 原子 resume 保留的 Queue。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 独立 Reviewer 对最终实现和证据给出 `APPROVED`；发现问题必须修复后重新 Review。

## 7. 完成规则

只有 AC-01 至 AC-07 全部满足并有可复查证据，才算完成。工具已注册、测试局部通过或 UI 能看到 Agent Tree，任何一项都不能单独代表完成。
