# Agent Execution Ownership Hard-Cut Goal

## Objective

彻底统一 ArchCode Agent 的运行语义：一次被 Runtime 接受的触发只对应一个 durable Execution，由 `SessionExecutionManager` 独占 live Execution 的 admission、并发、abort generation 与终态；QueryLoop 只拥有 model/tool query cycle。同步修正子 Agent 冷热启动身份、父级标题责任、Session 恢复工具、Slash Command 路径和项目指令刷新。实施必须硬切，不保留旧入口、fallback、双写或旧 Session 兼容。

## Locked Architecture

```text
User / Goal / Automation / Delegate / HITL answer
                         |
                         v
              SessionExecutionManager
              - checked admission
              - execution id / status
              - runtime concurrency
                         |
                         v
              cached ConfiguredAgent
              - prompt / model / tools / hooks
                         |
                         v
                    QueryLoop
           Model/Tool Cycle <-> ToolBatchScheduler
                         |
                         v
                    SessionStore
```

- `SessionExecutionManager` 是 live Execution 的唯一所有者；领域服务决定何时请求取消，但只能通过 Manager 持有的 generation/abort path 生效。`SessionAgentManager` 只缓存可重建的 Agent/Factory，`ConfiguredAgent` 不拥有可观察运行状态。
- `SessionStoreManager` 继续在持久化加载阶段把重启遗留的 `running` record 收敛为 `interrupted`；这属于 hydration repair，不构成第二个 live Execution owner。
- `AgentDefinition` 继续拥有工具与 Hook 策略；`ConfiguredAgent` 继续组装 Prompt、模型、工具和 Hooks；QueryLoop 继续处理模型步骤、工具批次、重试、命令解析和 loop hooks，但不创建或结束 durable Execution。
- `SessionToolBatchScheduler`、`SessionEventBridge`、Session family stop/delete、Goal delegation admission 与 scope validator 保持现有领域边界，不吸收到 ExecutionManager。
- `delegate` 与 `resume_session` 是两个模型工具，但共用同一个 child execution service 和 ExecutionManager；不得为恢复 Session 新增独立 runtime、manager 或状态机。
- 不新增 Harness、Ledger、Snapshot、Coordinator、通用生命周期框架或第二套运行状态。

## Hard-Cut Constraints

- 新 Session 严格持久化 `activeSkillNames`；旧 Session schema 不读取、不补默认值、不迁移。
- `delegate` 只创建新子 Session：删除 `session_id` 输入，`title` 必填且非空；`description` 仍可选，且不得作为 title fallback。
- 新增 `resume_session` 只恢复已有直属子 Session：输入只包含 `session_id`、`task`、可选 `context`/`background`，不接受 `agent_type`、persona、skills 或 title。
- Slash Command 只走普通 Session message execution；删除独立 command dispatch API 和 active-Agent 派发链。
- 删除被替代的旧字段、方法、route、Web mutation、测试和导出，不保留 alias、adapter、deprecated wrapper 或双路径。

## Non-goals

- 不改变 Agent 角色、工具权限、Hook 阶段、Memory 行为、压缩算法、Tool Batch/HITL 恢复语义、Goal/Automation 状态机或 SSE replay。
- 不因本 Goal 合并现有领域服务、重写 EventBridge、替换 Agent cache，或按代码行数驱动删除。
- steer/follow-up 不在本 Goal 范围内。

## Acceptance Criteria

以下 AC-01 至 AC-06 必须全部有代码、测试和审计证据；任一缺失即为 `NOT_DONE`。

### AC-01：Execution 语义唯一

- `user_message | tool_call | tool_batch | goal_claim` 每次成功 admission 恰好产生一条 Execution record，record id 必须等于对应 `ActiveSessionExecution.executionId`。
- 同一次触发内的多个 Model Turn、Todo 自动继续和最多四次 cwd transition 全部沿用同一 execution id；不得创建内部 Execution record。
- 工具进入 HITL 时当前 Execution 以 `waiting_for_human` 结束；回答被接受后由 `tool_batch` 开启新的 execution id。
- `SessionExecutionManager` 在调用 Agent 前持久化一次 `execution-start`，并在完成、`max_steps`、失败、取消、超时、中断或等待人类时持久化一次匹配的 `execution-end`；已开始的 Execution 不得无终态或被终结两次。
- QueryLoop 和 `ConfiguredAgent` 不写 `execution-start/end`；QueryLoop 将确定的运行结果向上返回，由 Manager 决定唯一 live 终态。重启遗留 `running` record 仍由 `SessionStoreManager` 在 hydration 时收敛为 `interrupted`。

### AC-02：入口与运行权归一

- 已存在 Session 的所有生产触发先完成 canonical cold-load、family identity、cwd/worktree、Goal claim、workspace 状态及与 origin 匹配的 Tool Batch 检查，再进入唯一私有的同步 execution claim。新建 child 则必须先创建并持久化完整 canonical identity/prompt，再执行同等级 scope 检查与 claim。普通消息和 Goal 不得越过 blocker，`tool_batch` 只能唤醒该 Session 的 canonical active batch，Goal retry 不得绕过该路径。
- `SessionExecutionManager` 独占 workspace 并发 slot 和 active execution；删除 `SessionAgentManager.activeJobsByWorkspace/acquireSlot/releaseSlot` 以及 `ConfiguredAgent.running` 这两套运行权。
- 生产代码中只有 `SessionExecutionManager` 可以调用 `Agent.run()`；架构测试必须阻止任何其他生产调用者绕过 admission。
- 保留 child launch、cwd transition、family stop、deletion、workspace close 等现有专用 lease/guard；不得为了减少 Map 数量合并不同并发窗口。
- admission 失败不得创建 Execution record；claim 成功后的任何错误必须落入该 Execution 的唯一终态。

### AC-03：子 Agent 身份与标题确定

- Session strict schema 必须包含 `activeSkillNames: string[]`；根 Session 写 `[]`，delegate 创建的子 Session 写去重后的已授权名称。缺失字段、未知 Skill、越权 Skill 或已删除 Skill 均 fail closed。
- 子 Agent 的权威 depth 只从持久化 parent chain 推导；删除 `SessionToolBatch.currentDepth`。`ToolChildSessionLink.depth` 只可作为从 parent chain 计算出的 UI 展示投影，任何权限、delegate target、maxDepth 或 tool 恢复逻辑均不得读取它。warm cache、cache release、进程重启和 HITL 冷恢复必须得到相同 depth、delegate targets 与 allowed tools。
- `ConfiguredAgent` 每次 Execution 根据 `activeSkillNames` 重新解析 Skill 内容；不得把仅存在于 warm Agent 对象的 `ResolvedSkill[]` 当作身份真相。
- `delegate` 的 `title` 必填且非空，`description` 可选；生产代码不存在 `title ?? description` 或其他自动补 title 的 fallback。新子 Session 必须先持久化 identity、title、activeSkillNames 和 delegated prompt，再发布 parent link 并启动；其 title-generation Hook 不得 dispatch。
- `resume_session` 只对拥有 `delegate` 权限的 Agent 可见，只能恢复调用者已有、持久化、直属且当前 idle 的 child；必须重新完成 canonical identity、Goal/cwd、pending HITL/Tool Batch、delegate target/depth 和当前 Agent policy 校验。agent type、title、activeSkillNames 与 depth 全部从 Session 推导，不得由调用参数覆盖；原 title 保持不变。

### AC-04：Hooks 与项目上下文保持正确

- 保留 `beforeModelBuild`、`beforeModelCall`、`afterStepEnd`、`afterLoopEnd` 以及各 Agent 的现有差异；Goal budget 的阻断异常仍必须传播。
- 根 Session 的 title generation 继续在第一次实际 Model Call 前异步触发；已有 title 时不触发。不得移动到 execution finalization。
- Todo、Memory、compression 和 reminder Hook 保持当前触发阶段与次数；尤其不得把 `afterLoopEnd` 重新解释为整个 Execution 结束。
- 删除无生产消费者的 `transcriptSave` policy 及全部定义、fixture 和测试断言，不新增替代 Hook。
- 每次 Execution 重新读取或按可靠 mtime 刷新当前 cwd 的 `AGENTS.md`；修改后下一次 Execution 必须进入 System Prompt，不能继续使用永久缓存。

### AC-05：Slash Command 只有一条路径

- Web 的 `/compact` 与支持的 `/skill` 输入作为普通 Session message 提交，经 checked admission 和 QueryLoop command parsing 执行；idle Session 可以成功执行 `/compact`。
- 删除 command HTTP route、Web `usePostCommand`、Runtime/ExecutionManager/SessionAgentManager/Agent 的 `dispatchCommand`，以及“仅 active Agent 可执行 command”的测试和错误映射。
- command-only Execution 不调用主模型；`/skill` 的 `continueAsMessage` 在同一 Execution 中进入模型；结果继续通过现有 Session event/system notice 可见。

### AC-06：边界、场景与硬切验收

- 架构测试锁定：ExecutionManager 不依赖 Server/Web；QueryLoop 不拥有 Session lifecycle；`Agent.run()` 无 Manager 之外的生产调用者；Agent cache 不拥有并发或 durable identity；ToolBatchScheduler 不处理 Goal/Event forwarding；现有领域服务不反向依赖 QueryLoop。
- 回归至少覆盖：Todo 多轮仍为一个 execution id、cwd transition 仍为一个 id、HITL 前后两个 id、全部终态、Goal retry checked admission、warm/cold child 三层深度与 Skills 一致、`delegate` 强制父级 title、`resume_session` 保留持久化身份与 title、Skill 删除 fail closed、AGENTS.md 刷新、idle `/compact`、`/skill` continuation。
- 现有 Tool Batch 并发/恢复/manual inspection、Permission/HITL、Goal budget/review/retry/cancel、Automation、family stop/delete/cwd race、SSE replay/child forwarding测试必须继续通过。
- 生产代码审计确认不存在 QueryLoop lifecycle 写入、Manager 外的 `Agent.run()`、`activeJobsByWorkspace`、`ConfiguredAgent.running`、`dispatchCommand` 链、command route/mutation、`transcriptSave`、`delegate.session_id`、可选 delegate title、description-to-title fallback、`SessionToolBatch.currentDepth`、把 child-link depth 用作运行权限、缺失 `activeSkillNames` 的兼容解析或迁移代码。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；Reviewer 必须逐项给出 AC-01 至 AC-06 的文件、测试、搜索和运行证据，不能只写“测试通过”。
