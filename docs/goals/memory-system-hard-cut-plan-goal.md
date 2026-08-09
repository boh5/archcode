# Memory 可靠学习、归并与管理 Hard-Cut Plan Goal

> 状态：产品边界已确认，本文是实施与验收契约。当前只产出计划，不实施代码。

## Objective

在保留现有 Markdown Memory 与 `memory_write` 工具契约的前提下，彻底重做自动学习链路：用户明确要求“记住”时继续由当前 Agent 按现有权限和工具语义调用 `memory_write`；普通对话只在根 Session 连续空闲 10 分钟后后台抽取，并在写入前针对实际涉及的完整 Memory 文件做一次归并。系统必须能跨重启恢复、并发写入不丢数据、不会无限追加重复内容，并提供可查看、编辑、删除和开关的 Settings → Memory 管理界面。

这次不引入数据库、向量检索、Embedding、知识图谱或审批队列。目标是把现有方案做可靠，不建设通用 Memory 平台。

## 已锁定的产品规则

### 1. 显式 `memory_write` 保持现状

- 不增加“识别用户说记住”的新流程；是否调用仍由当前 Agent 使用已经提供的 `memory_write` 工具完成，不等待 10 分钟，也不经过自动抽取。
- `memory_write` 的 input/output schema、scope/name/content 规则和现有 Agent 工具权限保持；在已确认容量上限内，preferences 继续追加，project topic 继续 upsert 并重建 index。
- 不增加确认流程、建议队列、额外 Agent 或另一种显式保存 API。统一 `MemoryService` 只收口底层锁、容量和文件/index 一致性；唯一新增的可见边界是写入将超限时明确失败。
- 自动提取只新增一件事：把同一窗口内成功完成的 `memory_write` 标成“已经保存”，避免后台再次保存同一内容。

### 2. 自动学习节奏固定为 10 分钟空闲

- 只处理成功完成的根 `Lead` / 根 `Discussion` 对话。失败、取消、仍在运行的 Execution 和全部子 Session 不触发学习。
- 根 Session 成功完成后开始 10 分钟倒计时；新用户消息到达立即取消旧倒计时，待新一轮根 Execution 成功完成后重新计时。
- 不再在每次 Query Loop 结束时立即抽取，不保留消息数、字符数、5 分钟 cooldown 等旧阈值。
- 自动任务使用当时有效的 `fast` Profile，作为不可见的内部后台任务；不创建新的 Session 或 Agent 身份。
- 每个空闲批次最多一次抽取调用和一次归并调用。没有候选 Memory 时只发生抽取；不能为“更聪明”继续增加多轮 Agent 工作流。
- 结构化抽取固定最多 8 个候选、最多 4 个 touched files；归并 payload 最多 64 KiB，并且必须符合当前 `fast` 模型声明的 context 安全预算。超出时完整目标文件不截断、不拆成第三次调用，而是阻塞本批次并提示用户管理。
- 抽取的完整 Prompt 也有 64 KiB 硬上限并服从 `fast` context 安全预算：完整 preferences 和完整 index 优先保留，再从最近向前装入 conversation。若固定 Prompt + 完整 Memory manifest + 最近一组 user/final-assistant 仍放不下，则不调用抽取、不推进游标并显示 input-budget warning；绝不截断 preferences/index 来假装成功。

### 3. 抽取内容和 scope

- 抽取模型根据内容判断 user-global 或 current-project scope，代码不维护一套硬编码分类规则。
- 可保存内容仅包括：用户偏好/工作方式、稳定项目约定与架构决策、反复出现的反馈/纠正、长期有用的技术参考。
- 必须排除：临时进度、一次性报错、仅当前 Session 有效的事实、secret、推理过程和不确定结论。
- 输入窗口包含有界的用户正文与附件标记、成功根 Execution 的最终 Assistant 回答、可信只读工具证据，以及同一窗口内成功 `memory_write` 的“已保存”标记。不得把 reasoning、失败工具结果或普通有副作用工具输出当成 Memory 证据。
- “同意”“就这样”等短回复必须和对应 Assistant 上下文一起进入抽取，不能脱离上下文单独解释。

### 4. 存储与召回保持简单

- 保留现有文件：用户级 `preferences.md`，项目级 `index.md` 与 `knowledge/{topic}.md`；不迁移到数据库或另一套双写格式。
- 主 Agent Prompt 注入完整的、有 8 KiB 硬上限的 personal preferences，以及当前项目完整 index；不注入所有 topic 正文，也不改成“只取最相关 3～5 条”。
- topic 正文仍由 Agent 根据 index 使用精确 `memory_read(name)` 按需读取。`index.md` 始终由系统生成、只读，用户不能直接编辑。
- 自动抽取先看完整 preferences 与完整 index 来选择已有 topic 或新 topic。若候选指向 `build_tools`，归并模型读取完整 `knowledge/build_tools.md`；若确实是新主题，则允许创建新文件。不会先从旧文件挑一行给模型，也不会读取全部 topic 正文。
- 对升级前已经超过 8/16 KiB 或 200 topics 的数据，不迁移、不截断、不自动删除：文件继续可读、可删，人工编辑只允许保持或缩小 UTF-8 bytes，直至恢复合规；超限 target 暂停显式/自动扩写。preferences 超限时只停止 preferences 注入；topic 数超过 200 时停止 index 注入和新 topic；单个 topic 超限不影响仍然合规的 index 注入。所有情况均在 Settings 显示 blocking warning，恢复合规后自动回到正常规则。

### 5. 归并、冲突与容量

- 抽取只产出候选和目标；真正写入前，系统读取本批次涉及的完整 preferences / topic 文件，用同一个 `fast` 归并调用输出严格的 `ADD | UPDATE | NOOP` 操作。
- 现有文件在归并 Prompt 中按 Markdown block 临时编号。`ADD` 追加新 block；`UPDATE` 只能替换明确引用的一个或多个 block；`NOOP` 不写。编号不持久化，不引入独立 Memory ID 系统。
- 最新的、明确的用户纠正可以 `UPDATE` 旧冲突内容，最终只保留一个有效结论。仅由模型推断出的不确定冲突不得覆盖旧内容，只能 `NOOP`；系统不提供自动 `DELETE`。
- `UPDATE` 可把内容重复或高度重叠的多个 block 合并为一个 block，以便在接近容量时做定向压缩；不能借“整理”删除无关内容或改写未引用 block。
- 硬上限固定为：preferences 8 KiB UTF-8、单个 project topic 16 KiB UTF-8、每个项目最多 200 个 topic。到达上限时，同一次归并先尝试去重、合并或落入已有相关 topic；仍放不下则不写、不推进处理游标，并在管理界面显示持久化警告，绝不静默删除或截断。
- 容量一律按最终落盘 Markdown 的 UTF-8 bytes 计算；topic 的 16 KiB 包含 frontmatter、正文和换行。

### 6. 管理界面

- 入口固定为 Settings → Memory，不增加顶级导航。
- 页面分为 Personal Memory 与 Current Project Memory，支持查看、编辑、删除；topic 列表展示名称、类型、描述和容量，index 仅展示为系统生成状态。
- 两个独立开关：`Use Memory` 只控制后续 Execution 的 Prompt 注入；`Auto learning` 控制 10 分钟后台学习。关闭自动学习不影响显式 `memory_write`。
- `Use Memory` 在 Execution claim 时取一次快照，并在该 Execution 的所有模型调用中保持不变；关闭只影响之后 claim 的 Execution，不删除任何文件。
- `Auto learning` 关闭表示 opt-out，不是暂停：保存返回前线性化发布新 policy epoch、取消 timer，并把尚未提交的窗口标为已跳过；关闭期间的对话以后不补学。重新开启只学习开启后的新对话，显式 `memory_write` 始终可用。
- 不做来源追踪、置信度编辑、过期标记、建议审批、文件/Git 绑定或知识图谱。

## 当前实现必须解决的问题

- `afterLoopEnd` 达到阈值就调度，和已确认的 10 分钟空闲语义不一致。
- Hook 在后台任务成功前就推进 `lastExtractionIndex/time`；任务也在文件写入前推进游标，失败会永久漏提取。
- 两个游标字段没有进入 `SessionFileSchema` / `toSessionFile`，重启后会重复处理旧对话。
- 自动任务绕过 `sharedMutationQueue` 直接读改写文件；多个根 Session 可互相覆盖。
- preferences 和已有 topic 只做文本追加，Prompt 级“去重”不能阻止重复与冲突持续增长。
- 现有 consolidation 只重写 index、既不合并 topic 也不删除文件，下一次 `rebuildIndex()` 又会把所有 topic 加回来，实际没有整理效果。
- 抽取输入丢掉最终 Assistant 回答，导致短回复缺少语义；成功显式写入也没有被标记为已保存。
- Settings 只有旧阈值配置，没有 Memory CRUD、容量状态或可处理的失败提示。

## 目标架构

```text
root message / completed root Execution
  -> MemoryIdleCoordinator（每个根 Session 一个 10 分钟 debounce）
  -> durable memoryLearning cursor + eligible snapshot
  -> fast extraction（候选、scope、目标、explicit/inferred basis）
  -> MemoryService 在锁内重新读取 touched files
  -> fast reconciliation（完整目标文件，ADD / UPDATE / NOOP）
  -> validate + capacity check
  -> persist bounded pendingApply receipt
  -> deterministic per-file apply + rebuild index
  -> 写入全部成功后推进 durable cursor

memory_write / Memory HTTP API
  -> MemoryService
  -> 同一 mutation lane、校验、容量与 index 规则
```

- `MemoryFileManager` 降为 Markdown 文件读写层，只负责安全路径、解析、原子单文件写和 index 生成，不包含 LLM、定时器或业务策略。
- 新的 project-scoped `MemoryService` 是所有 Memory 变更的唯一入口，统一拥有显式写入、自动归并应用、CRUD、容量、secret 检查、revision/CAS 和 mutation serialization。
- 新的 runtime-scoped `MemoryIdleCoordinator` 只拥有根 Session 的 debounce、启动恢复、`fast` binding、policy epoch 与任务取消；不扩成通用调度器。运行期 epoch 固定为 `{ bootId, generation }`，每次 Memory policy 保存递增 generation，阻止 off→on ABA。
- 根 Session 持久化一个 `memoryLearning` record，使用稳定 message id 而不是数组下标，记录 processed cursor、eligible cursor、idle timestamp、最多一个 blocked reason，以及最多一个有界 `pendingApply`。旧的易失 `lastExtractionIndex/time` 直接删除，不双读、不翻译。
- `memoryLearning` 缺失表示该 Session 从未建立待处理窗口。首次新输入入队时，以入队前最后一条 message 为基线创建记录，因此不会对升级前的全部历史盲目回填，也不需要旧字段 fallback。
- 自动批次捕获 `{ processedCursor, eligibleCursor, policyEpoch }`。运行期间的新消息或更新后的 eligible cursor 属于下一批，不使旧批失效；提交只 CAS 原 processed cursor 与当前 boot policy epoch，成功后推进到 captured eligible，并保留更晚 eligible/idle timestamp 再挂下一 timer。
- `pendingApply` 在任何 Memory 写入前原子持久化，包含 captured window、每个目标的 expected revision、最终完整文档与 final revision。重启只确定性重放该 receipt：当前 revision 等于 expected 才写，等于 final 视为已完成，其他值转为 conflict warning；绝不重新询问 LLM。全部目标与 index 到位后，在一次 Session state save 中清除 receipt 并推进 cursor。
- 跨重启不比较旧进程 generation：启动读取 durable config；若 `autoLearning=false`，在不写 Memory 的情况下原子丢弃旧 receipt、把 captured window 标为 skipped 并清除 warning；若为 `true`，则在 apply admission gate 内把 receipt 绑定到当前 boot epoch 后确定性重放，再以当前 epoch 提交。启动恢复同一 Session 每个 boot 最多触发一次。
- HTTP 编辑返回内容 revision；PUT/DELETE 必须携带 `expectedRevision`。UI 与自动任务都在 mutation lane 内重新读取，过期编辑返回 409，不允许静默覆盖并发变化。
- blocked warning 归根 Session 所有，每个 Session 最多一条；项目 snapshot 按 `blockedAt, sessionId` 聚合本项目 warning。personal 文件自身的超限状态在所有项目可见，但 pending personal warning 只在其来源项目显示。目标人工变更会丢弃与旧 revision 冲突的 receipt、清除对应 warning 并唤醒所有匹配的已加载 Session；未加载 Session 在下次恢复时执行同样检查。成功处理或关闭 Auto learning 会清除该 Session warning。

## 实施计划

1. **硬切配置与领域契约**
   - 将 `memory.{enabled,minMessages,minContentLength,cooldownMs}` 替换为 `memory.{useMemory,autoLearning}`；10 分钟与三项容量均为代码常量，不在 UI 暴露调参。
   - 定义 extraction candidate、reconciliation action、Memory snapshot/item/capacity/warning、`pendingApply` 和 revision DTO；schema 固定 8 candidates / 4 touched files / 64 KiB extraction input / 64 KiB reconciliation payload，并严格拒绝未知字段与越权 target/action。
   - 删除旧 extraction/consolidation schema、threshold/cooldown 常量和所有旧配置读取，不保留 alias 或兼容解析。
   - 增加 Runtime-owned Memory policy snapshot 与 `{ bootId, generation }` epoch。Settings 保存与自动 apply admission 共用一个短临界区：保存关闭会等待已进入 apply 的批次完成，再发布新 generation；响应返回后旧 epoch 不能再开始 Memory 写入。

2. **收口 Memory 存储写入**
   - 保留并瘦身 `MemoryFileManager`，新增 `MemoryService`；把 `memory_write`、自动学习和 HTTP CRUD 全部改为调用 Service，禁止其他生产代码直接写 Memory 文件。
   - Service 按真实 user preferences 路径和 project memory root 串行化完整 read-modify-write；topic 写/删和 index rebuild 必须处于同一 project mutation lane。
   - 实现最终落盘 UTF-8 容量、200 topic、secret、frontmatter/name、revision/CAS 校验及 pre-existing over-cap remediation。先计算并验证最终文档，再持久化 receipt、确定性 apply；多文件中途失败不推进游标。
   - `memory_write` 保持当前 schema、返回值、preferences append、topic upsert 和 Agent 工具权限；只把内部文件操作收口到 Service，并在将超过统一容量上限时返回明确错误。

3. **重写自动学习管线**
   - 删除 Query Loop 的 memory extraction/consolidation hooks 与旧 background tasks，新增 `MemoryIdleCoordinator`，接到根输入 durable admission、根 Execution terminal commit、Runtime startup reconciliation 与 shutdown drain/cancel 生命周期。
   - 根输入取消 timer；只有成功根 terminal commit 才设置 eligible cursor 并从该时刻计 10 分钟。启动时只重挂有未处理 eligible window 的记录；已经空闲满 10 分钟的记录立即后台调度一次。
   - 使用 message provenance 构造有界输入：用户内容、成功根最终回答、白名单只读工具证据、成功 `memory_write` marker。先预算固定 Prompt 与完整 preferences/index，再按时间从最近向前加入 conversation；conversation 可有明确截断标记，preferences/index 不可截断，连最近一组 user/final-assistant 都放不下则阻塞。
   - 使用 `fast` Profile 做严格结构化抽取；scope、已有/新 topic 和 explicit/inferred basis 由模型输出，代码只做安全及一致性校验。自动候选命中 secret 时丢弃该候选而不是持久阻塞；其余安全操作成功后批次可以推进。

4. **实现批次级定向归并**
   - 根据候选 target 读取完整 preferences 或完整选中 topic；同一批所有 touched files 放入一次有界归并调用，新 topic 以空文档输入。
   - 将完整正文按 canonical `---` divider 切成临时编号 block；没有 divider 的正文就是 block 1。校验 `UPDATE` 引用、候选归属、纠正规则和未触碰内容 byte-for-byte 保持。
   - 在同一次归并里完成正常去重和接近容量时的定向压缩；禁止第三次“整理 Agent”调用，禁止扫描全部 topic 正文，禁止自动 DELETE。
   - 抽取与归并分别执行 64 KiB 与模型 context budget admission；任何要求完整保留的输入放不下时不调用 LLM，写入 durable warning。空结果或仅丢弃不安全候选算成功；LLM/schema/读取/写盘/容量失败保留游标。
   - 归并验证成功后先保存 `pendingApply`，再按 expected/final revision 确定性应用。容量阻塞仅在新活动、目标人工变更或一次 Runtime 恢复时重试，避免定时死循环。
   - receipt 形成前的读取/LLM/schema 失败在当前 idle batch 不自动重试，只保存一条不含正文的 warning，等待下一次成功根活动或每 boot 一次恢复。receipt apply 不再调用 LLM，只允许最多 3 次确定性 I/O 尝试；耗尽后保留 receipt 和 warning，等待相同触发。成功推进 cursor、关闭 Auto learning 或人工解决目标冲突时清除 warning。

5. **保持召回契约清晰**
   - Prompt compiler 使用 Execution claim 时的 `useMemory` snapshot，注入完整 preferences（最大 8 KiB）和完整 project index（最多 200 topic）；topic 正文继续按需 `memory_read`。preferences 超限只省略 preferences，topic 数超限只省略 index；单个 topic 超限不影响 index。被省略部分只注入不含内容的管理提示。
   - `memory_read` 的无参、`preferences`、`index` 和精确 topic 语义保持单一；更新说明，明确 index 是导航而非语义检索结果。
   - `autoLearning` 只影响后台学习；显式读写工具不会因该开关消失。开关变化通过 Runtime policy snapshot 实时传给 Prompt 与 Coordinator。

6. **增加 project-scoped API 与 Settings 管理 UI**
   - 增加当前项目的 Memory snapshot、preferences PUT/DELETE、topic PUT/DELETE 路由；personal 数据仍是 user-global，但通过当前已认证项目上下文访问，不增加第二套全局路由。
   - API 不返回本地绝对路径，不记录 Memory 正文；所有写/删使用 `expectedRevision`，返回新 revision、容量和 warning 状态。
   - Settings 从当前 `/projects/:slug/**` route 取得 project slug。位于 Global Home 或其他无项目 route 时，仍可保存两个全局开关，但 Personal/Current Project CRUD 显示“请先打开一个项目”的不可用状态，不猜测最近项目。
   - 按仓库 UI 流程先读 `design-system/MASTER.md` 与 Settings 相关规范、检查当前真实页面，再使用 `ui-ux-pro-max` 做结构和可访问性校验。只在确有重大布局不确定性时更新单一 prototype。
   - 实现两个开关、personal 编辑器、topic 列表/编辑/删除确认、只读 index 状态、容量条与 blocked warning；桌面和窄屏均能完成全部管理操作。

7. **清理、文档与验证**
   - 删除旧 hook/task、无效 consolidation、旧配置 UI/测试和任何绕过 `MemoryService` 的 Memory 写入旁路；更新 README/config 示例及 Memory 生命周期说明。
   - 增加 fake-clock scheduler 单测、input/prompt snapshot、stubbed structured-output validator/apply fixtures、Service 并发与 receipt 故障注入测试、restart integration、Server route 测试、Web interaction 测试和真实浏览器验收。真实 `fast` 模型语义只做记录型非阻塞 eval，不进入 `bun run test` 门禁。
   - 不增加只断言旧 symbol/文件不存在的墓碑测试；硬切通过代码审查和最终 `rg` audit 证明。

## 风险与控制

- **LLM 错误归并**：归并只能看到/修改本批 touched files；结构化 action 必须引用合法 block，推断不能覆盖旧结论，未引用内容保持不变。
- **跨文件无法真正事务提交**：使用每个根 Session 最多一个、有严格大小上限的 `pendingApply` receipt 固定最终操作；它只解决 Memory apply/cursor 的 crash recovery，不扩展成通用 WAL 或事件溯源。
- **多个项目同时写 personal preferences**：以 user preferences 的真实路径全局串行化，并在锁内重读；project 锁不能替代 user 锁。
- **重启或关闭开关时仍写入**：游标、receipt 与 blocked state 持久化；policy epoch 与 apply admission 线性化，shutdown 纳入 Runtime drain/cancel。
- **容量阻塞导致反复调用**：阻塞后不推进游标但停止周期性自旋，只在新活动、人工 Memory 变更或一次启动恢复时重试，并持续向 UI 暴露原因。
- **瞬时失败导致永久搁置或自旋**：pre-receipt 失败不在同一 idle batch 重试；receipt 只做 3 次确定性 I/O 尝试。之后统一等待新成功根活动或每 boot 一次恢复，并复用同一 warning 槽位。

## 验收标准

以下 AC-01 至 AC-08 必须全部提供自动测试、浏览器证据或代码审计证据；任一缺失即为 `NOT_DONE`。

### AC-01：现有显式 `memory_write` 契约不变

- 当前有权限的 Agent 一次成功 `memory_write` 后，调用返回前对应文件已可由 `memory_read` 和 API 读到；即使立刻关闭 Server 也不会等待自动学习。
- 现有 input/output schema、scope/name/content 校验、preferences append、topic upsert/index rebuild 和 Agent 工具可见性保持不变；Lead、Discussion、Build 继续拥有该工具，不新增或移除权限。
- `autoLearning=false` 时显式读写仍成功。secret、非法 name/scope 或写入后将超过 8/16 KiB 上限时整次失败，旧文件与 index byte-for-byte 不变；容量按最终落盘 Markdown 计算。
- 同一窗口已有成功 `memory_write` 时，input snapshot 必须包含已保存 marker；即使 stubbed extraction 仍产出同一候选，后续归并也必须 `NOOP`，文件不得新增重复 block。

### AC-02：10 分钟 idle 与跨重启游标准确

- fake clock 证明成功根 Execution 完成后 `9:59.999` 不调度、`10:00.000` 只调度一次；期间任一新用户消息取消旧 timer，失败/取消 Execution 和 child Session 永不调度。
- Server 在倒计时中重启后按剩余时间恢复；已经空闲超过 10 分钟则启动后调度一次。关闭 `Auto learning` 取消 pending timer，正在运行的批次不得在关闭后提交写入。
- 批次只处理 durable processed/eligible message-id 区间；任务期间新消息留给下一批。提交 CAS 只检查原 processed cursor 与当前 boot policy epoch，推进 captured eligible 时必须保留更新的 eligible/idle timestamp。LLM、schema、容量或写盘失败不推进；空候选或安全候选全部完成后才推进。
- 故障注入分别在 receipt 保存后、首个文件写后、全部文件写后但 cursor 提交前崩溃；重启不得再次调用 LLM，只重放同一 receipt，最终文件无重复 block且 cursor 前进一次。
- 关闭 `Auto learning` 的保存响应返回后不再有旧 revision 写入；关闭期间窗口被跳过且不会在重新开启后补学。重新开启后的首个新成功根对话按正常 10 分钟规则调度。
- restart fixture 证明：旧 boot receipt 在 durable config 仍开启时绑定当前 `{bootId,generation}` 后只重放一次；config 已关闭时不写 Memory、丢弃 receipt并跳过 captured window。一次 boot 内 off→on 的 generation 不复用，旧 batch 永远不能因 ABA 恢复提交资格。
- pre-receipt LLM/schema/read 失败在同一 idle period 调用次数保持 1；下一次成功根活动或下一 boot 只再尝试一次。receipt apply 的 I/O 尝试恰好最多 3 次，耗尽后跨 timer 不自旋，重启仍不调用 LLM。

### AC-03：抽取证据与 scope 正确

- input-builder snapshot 证明“Assistant 提议规则 → 用户回复同意”时最终回答与“同意”同时存在；移除 Assistant final 后 snapshot 只剩无解释的短回复，生产代码不得自行补写语义。
- snapshot 包含成功完成的根最终回答和白名单只读证据；reasoning、失败结果、effectful 工具输出、失败/取消 Execution 内容均不出现。成功 `memory_write` 以已保存 marker 出现。
- stubbed structured output 证明 user-global / current-project 结果原样进入对应 target；同一套代码不以关键词、Agent 名或文件名硬编码 scope。secret 候选被丢弃，session-only 候选由 extraction schema/prompt eval 覆盖。
- 抽取和归并都使用 `fast` Profile，且不会创建 Session、child Agent 或第三次 LLM 调用。
- 真实 fast 模型对短回复、语义重复和纠正案例运行非阻塞 eval并保存结果；它用于观察 Prompt 质量，不作为确定性测试或完成门槛。

### AC-04：归并、去重与冲突规则可验证

- stubbed `NOOP / ADD / UPDATE` 输出分别验证 exact/semantic duplicate、补充、明确纠正、推断冲突与新 topic 的 validator/apply 行为；新 topic 使用对空 target 的 `ADD` 创建文件，不引入第四种 `CREATE` action。
- 每次归并输入包含 touched target 的完整正文；未选中的 topic 正文不被读取。新 topic 可以创建，不要求先命中已有 topic。
- action 引用不存在 block、修改未触碰文件、推断覆盖冲突、越权删除或使未引用 block 改变时，整批拒绝且游标不前进。
- 正常学习批次最多两次 LLM 调用；生产代码不存在独立全库 consolidation 扫描或自动 `DELETE` 路径。
- schema 对第 9 个 candidate、第 5 个 touched file、超过 64 KiB 或超过模型安全预算的 payload 确定拒绝；完整 selected file 不截断、不分批，cursor 保持且 warning 可见。
- extraction input 在 64 KiB 与模型安全预算边界内保留完整 preferences/index并优先裁剪最旧 conversation；固定 Prompt + Memory manifest + 最近 user/final-assistant 超限时零次 LLM 调用、cursor 不变且 input-budget warning 可见。

### AC-05：容量、并发与失败不会丢数据

- 8 KiB preferences、16 KiB 最终 topic Markdown、200 topic 的边界值可写，超过 1 byte/1 topic 即拒绝。接近上限时先由本次归并合并重复 block 或复用相关 topic；仍超限不改变文件/index/cursor，并持久显示 target 与原因。
- fixture 从 25 KiB preferences、20 KiB topic 与 201 topics 启动：原数据不改变且可读/可删，只允许不增大的人工编辑；preferences 与超限 target 不再扩写，201 topics 不再新增。Prompt 分别只省略超限 preferences 或超 200 的 index，20 KiB 单 topic 不影响 index；UI 明确提示，恢复到上限内后正常启用。
- 两个自动批次并发更新同一 topic、两个项目并发更新 personal preferences 的测试证明锁内重读与 receipt apply 无 lost update、损坏 frontmatter 或漏 index entry；多个显式调用继续按现有语义串行化：preferences 按顺序追加，同一 topic 后进入 mutation lane 的 upsert 生效。
- API 过期 revision 返回 409 且不覆盖新内容；topic 删除与 index rebuild 同 lane 完成，任何可见成功响应都不留下指向已删除 topic 的 index。
- Memory LLM/文件错误只记录无正文、无绝对路径、无 secret 的结构化日志；后台失败不导致根 Session Execution 失败。

### AC-06：召回与开关语义不含糊

- `Use Memory=true` 且数据合规时，下一次 claim 的 Execution 收到完整 preferences（不超过 8 KiB）和全部 project index（不超过 200 topic），不自动收到 topic 正文；同一 Execution 后续模型调用使用同一快照语义。
- pre-existing over-cap 数据不做截断注入：preferences 超限时只省略 preferences，topic 数超限时只省略 index，单 topic 超限不改变 index 注入；对应数据仍可通过管理 API 和精确 `memory_read` 读取，恢复合规后的下一 Execution 恢复完整注入。
- `Use Memory=false` 后新 Execution Prompt 不含 Memory，磁盘数据、API 和显式 `memory_read/write` 均仍可用；已经开始的模型调用不被中途篡改。
- index 始终由 topic 文件重建且只读；管理 API/UI 和 `memory_write` 均不能直接写 index。不存在向量/Embedding/“top 3～5 relevant memory”隐藏召回路径。

### AC-07：管理 API 与 UI 完整可用

- Settings → Memory 能分别查看 personal preferences 和 current-project topics，完成编辑、删除、删除确认、两个开关切换，并显示 UTF-8 用量、topic 数与 durable blocked warning。
- 当前 URL 无 project slug 时两个全局开关仍可保存，Personal/Current Project CRUD 明确不可用并提示先打开项目；进入 `/projects/:slug/**` 后只管理该 slug 与 user-global personal Memory，不使用“最近项目”猜测。
- index 只能查看生成状态；所有编辑使用 revision，冲突有明确提示和 reload，不静默覆盖。API/日志/错误/UI 不泄露本地绝对路径或被 secret 检测拒绝的正文。
- `Auto learning` 与 `Use Memory` 的说明和行为分别对应后台学习与 Prompt 注入；关闭前者仍可显式记住，关闭后者不删除内容。
- 真实浏览器在桌面和 390px 宽度完成上述操作：关键按钮可见、键盘可达、焦点/确认对话框正确、无横向溢出、控制台 0 error。
- 多 Session warning 按 `blockedAt, sessionId` 稳定排序；personal 文件超限在每个项目显示，pending personal warning 只在来源项目显示。人工修改、成功重试和关闭 Auto learning 的清除/唤醒行为均有 route/service 测试。

### AC-08：硬切与完整验证

- 生产代码中不再存在 Query Loop memory extraction/consolidation hook、旧 background task、`lastExtractionIndex/time`、旧阈值配置、自动学习任务的盲 append 或绕过 `MemoryService` 的 Memory 写入；现有 `memory_write` schema、语义和 Agent 权限保持不变。
- 现有 Markdown 路径是唯一存储格式；不存在 DB、Embedding、双写、旧配置 alias、fallback 读取、全库整理 Agent、建议审批或墓碑测试。
- targeted tests 覆盖 AC-01 至 AC-07；随后 `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 最终独立 Reviewer 必须逐项给出 AC-01 至 AC-08 的文件、测试、命令和浏览器证据；不能用“测试通过”或“功能看起来正常”代替逐项验收。

## Hard-Cut Audit

最终交付前用 `rg` 审计旧 hook/task 名、旧 config keys、旧 cursor 字段、直接 `MemoryFileManager.write*` 调用和 Agent 工具表；`MemoryFileManager.write*` 的唯一生产命中允许位于 `MemoryService` 内部，其余生产命中必须为零，旧符号只能剩历史文档引用。审计是交付证据，不新增用于守尸旧实现的测试。
