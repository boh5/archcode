# Tool Search 可见性投影硬切计划

## Goal

把 ArchCode 的模型首轮工具面从“Agent 全部授权工具 + 当前全部 MCP 工具”硬切为：

1. 少量高频 Core Tools 始终可见；
2. 已有运行时事实需要的工具由 State Activation 直接加入；
3. 其余本地工具和所有 MCP 工具在首轮只进入按 namespace/MCP server 分组的紧凑 deferred 目录，再通过一个 `tool_search` 按需加载完整 schema。

本 Goal 只改变“模型这一轮看见哪些工具”，不改变 Agent 能力边界、ToolRegistry、权限、Tool Batch、MCP 连接、ToolOutputFinalizer 或审计链。完成后，常规任务首轮不再为未使用的长尾 schema 付费，需要长尾能力时最多增加一次搜索工具往返。

## 已锁定的决定

- **一个搜索入口，两种查询语义**：只有 `tool_search`。模型已从首轮目录看到规范名称时使用 `select:<exact registryName>`，命中只做精确加载；精确失败不得回落 BM25。其他自然语言 query 才进入现有 BM25/词法排序，不另做 `tool_get`、`list_all_tools` 或第二种工具。
- **搜索不调用模型**：本机对已授权 catalog 做确定性词法与模糊排序；v1 不用 embedding、向量库、远程检索或额外 LLM。
- **授权和可见性分开**：AgentDefinition 决定角色基础授权，现有 system-owned Execution overlay/worktree/MCP 决定动态授权，Visibility Projection 只从合并后的有效授权集选出当前模型可见子集；后者绝不能扩大授权。
- **MCP 默认全部 deferred**：已启用用户 MCP 仍对六种 Agent 全局授权，产品内置 MCP 仍保留现有角色矩阵，但完整工具 schema 只经 `tool_search` 加载。v1 不增加 `alwaysLoad`、用户级工具分配或 eager 开关。
- **加载状态属于一次逻辑 Execution**：同一次 Execution 内跨 step、HITL、子 Agent 同步暂停、resume、compact 和进程恢复保留；新 Execution 从 Core + 当前 State 重新开始，不把历史加载无限带入 Session。
- **硬切，不兜底**：删除当前 eager MCP 拼接和旧 `tools.tools` 合约。`select:` 精确失败不得回落 BM25；自然语言搜索空结果、MCP 暂不可用或 provider 不支持厂商原生 Tool Search 时，都不得回退为全量 schema。

## 为什么现在做

在当前 `main@544aeaed` 上，用真实 `ToolDescriptor -> toAITools() -> JSON Schema` 和同一 `o200k_base` 口径测得：

| Surface | 工具数 | 约占 tool schema tokens |
| --- | ---: | ---: |
| Lead 本地工具 | 36 | 11,845 |
| Lead + 默认 ready 的 `context7`/`exa` | 40 | 13,338 |
| 本计划锁定的 Lead Core（尚未含 `tool_search`） | 13 | 5,077 |

本地捕获用于确认竞品真实请求形态，而不是拿宣传口径推断：Codex CLI 0.146.0 首轮请求有 4 个顶层工具入口、至少 13 个后端操作，tool wire 约 3,942 tokens；Claude Code 2.1.239 启用 Tool Search 时首轮是 11 个即时工具 + 1 个 deferred placeholder，tool wire 约 9,742 tokens，禁用搜索后的 24-tool eager 请求约 18,591 tokens。它们证明的不是“工具越少越好”，而是竞品也在把高频能力与长尾 schema 分开。

官方产品行为也与本方案一致：

- [OpenAI Tool Search](https://developers.openai.com/api/docs/guides/tools-tool-search) 首轮只暴露 namespace/MCP 的简要信息，命中的函数在后续上下文中加载；官方建议按 namespace/MCP 组织并控制每组函数数量。
- [Claude Code Tool Search](https://code.claude.com/docs/en/agent-sdk/tool-search) 在工具较多时默认 deferred，保留 Bash/Read/Edit 等核心工具；官方明确指出全量工具会消耗 10K–20K tokens，并在 30–50 个以上影响选择准确率。

以上 token 是同 tokenizer 下的本地规范化测量，不冒充厂商账单。Goal 的验收以 ArchCode 自身 wire、行为和回归测试为准。

## 完成后的架构

模型调用前的唯一流程：

`角色基础授权 + Execution overlay + worktree eligibility + live MCP snapshot -> Authorized Catalog -> Core + State + Execution 已加载项 + deferred compact directory -> ResolvedToolSet -> Provider`

`tool_search` 只在 Authorized Catalog 内搜索；命中项在当前 Tool Batch 成功结算时写入 Execution 的 loaded refs，下一次模型调用才带上这些完整 schema。模型不能在搜索的同一响应中调用尚未提供 schema 的工具。

### 1. 有效授权：来源固定，可见性只做减法

将当前 `tools.tools` 硬切为两个显式字段：

```ts
tools: {
  authorized: readonly ToolName[]; // 本 Agent 角色基础本地能力
  core: readonly ToolName[];       // authorized 的严格子集，首轮始终可见
  delegateTargets?: readonly AgentName[];
}
```

有效 Authorized Catalog 的来源锁定为且仅为：

1. `AgentDefinition.tools.authorized` 的角色基础工具；
2. 现有 `extraTools` 明确传入的 system-owned Execution overlay；
3. 现有 Session worktree eligibility 给出的 worktree 工具；
4. 当前全局用户 MCP + `builtinMcpServers` 角色策略给出的 ready MCP 工具；
5. 现有 `toolProjection` 若存在，只能对 1–3 的合并结果做交集收窄，不能授予新能力。

除以上来源外不存在隐式注册即授权。GitHub descriptors 继续保持“仅在调用方通过现有 `extraTools` 明确授予该 Execution 时可用”，本 Goal 不把 GitHub 自动授权给任一 Agent；被授予后它们进入 searchable catalog，不进入 Core。`tool_search` 本身加入六个 Agent 的 `authorized`，但不列入 `core`，只有存在至少一个 deferred 候选时才由 Visibility Projection 加入当前模型面。

`core` 不授予能力；它始终与当前有效授权取交集。因此达到 delegation depth 后，现有 capability projection 移除 `delegate` 及控制包的语义保持不变。MCP 授权不复制进 AgentDefinition。

Core 锁定如下，后续实现不得仅为追求更低 token 擅自删减：

| Agent | Core tools（`tool_search` 不属于 Core；有 deferred 候选时另行加入） |
| --- | --- |
| Lead | `file_read`, `file_write`, `file_edit`, `grep`, `glob`, `git_status`, `git_diff`, `bash`, `todo_write`, `ask_user`, `delegate`, `skill_list`, `skill_read` |
| Discussion | 与 Lead 相同；`project_todo_update` 由绑定 Todo 状态激活 |
| Analyst | `file_read`, `grep`, `glob`, `git_status`, `git_diff`, `bash`, `todo_write`, `ask_user`, `delegate`, `skill_list`, `skill_read` |
| Build | 与 Lead 相同 |
| Explore | `file_read`, `grep`, `glob`, `git_status`, `git_diff`, `todo_write`, `skill_list`, `skill_read` |
| Librarian | `file_read`, `grep`, `glob`, `web_fetch`, `memory_read`, `todo_write`, `skill_list`, `skill_read` |

Deferred candidates 精确等于 `Authorized Catalog - Core - 当前 State - 当前 Execution loaded refs - {tool_search}`。`tool_search` 本身不可被搜索；只有它仍在有效本地授权且 deferred candidates 非空，才加入当前模型面。`toolProjection` 若明确排除了 `tool_search`，该受限 Execution 不获得 deferred 能力，也不做任何 fallback。不存在可搜索项时不发送空壳搜索工具。

### 2. State Activation：只认系统事实

实现一个纯 `ToolVisibilityProjection`，直接读取现有 Session/Execution/Store 事实。不要做通用规则引擎、意图分类模型或可配置 DSL。

| 已有事实 | 直接加入模型工具面 |
| --- | --- |
| 当前 root Lead 有 active Goal | `get_goal`, `update_goal` |
| root Discussion 绑定一个 Todo | `project_todo_update` |
| 当前输入有 PDF attachment | `pdf_read` |
| 当前 Execution 存在可授权的 output artifact/ref | `output_read`, `output_search` |
| 已存在 descendant | `list_agents`；另按 direct child 的 running/background/resumable 状态加入 `send_message`, `background_output`, `wait_for_reminder`, `cancel_session`, `resume_session` |
| 当前 Session 已满足既有 worktree eligibility | 按现有状态加入 `worktree_enter` 或 `worktree_exit`，不改变 eligibility 规则 |

不满足状态时，这些工具仍可被 `tool_search` 找到，只是不再由 State 自动加入；若当前 Execution 已显式加载，则继续服从 loaded refs 规则。State 只是确定性的零往返可见性提升，不是第二道授权或执行前提。`create_goal`、`automation_create`、`compress`、Memory 写入、AST/LSP、非 Librarian 的 Web、Execution overlay 已授权的 GitHub 和其余本地长尾工具走搜索，不新增自然语言意图分类器。

### 3. Tool Catalog 和搜索

Catalog 不是第二个 Registry，也不持久化 schema。每次模型边界从以下实时、已授权 descriptor 投影得到：

- `ToolRegistry.resolveForAgent(authorized)` 的本地 descriptors；
- 当前角色可用的 live MCP snapshot；
- 已有 delegation/skill model projection 后的真实模型可见 description/schema。

ConfiguredAgent 拥有唯一异步 `resolveLiveAuthorizedToolCatalog(authorizationSnapshot)` 组合函数：它按当前 Agent/depth、持久 authorization snapshot、当前 worktree eligibility 和 live MCP snapshot 重建 catalog，并应用现有 delegate/skill model projection。模型边界、正常 `tool_search` 执行和冷恢复都必须调用同一函数；QueryLoop 只把窄 resolver 注入 ToolExecutionContext/Scheduler，ToolRegistry 与 descriptor 不缓存、不重建 catalog。State facts 只决定即时可见提升，不参与 Authorized Catalog digest。

每条内存索引只保存搜索需要的字段：规范工具名、namespace/server、description、参数名、参数说明和 enum literals，以及 descriptor digest。首轮目录从同一 Authorized Catalog 投影，不建立第二份 Registry；按 namespace/MCP server 分组，每项只显示 canonical `registryName` 和原始 description 的第一行，首行 trim 后最多 160 个 Unicode 字符，不显示完整 description 或参数 schema。没有 description 时只显示名称。Digest 统一为稳定 key order 的 UTF-8 JSON 做 SHA-256，规范输入精确包含 `{sourceKind, namespace, registryName, description, aiJsonSchema, traits, outputPolicy}`；不包含 execute closure、MCP handle、secret、连接 epoch 或 provider wire。Catalog digest 是按 `namespace + registryName` 排序后的 `[registryName, descriptorDigest]` 再做同样 SHA-256。

搜索先按 query 形式分支，再使用确定性排序：

1. `select:<exact registryName>` 只在当前 deferred Authorized Catalog 中做规范名称精确匹配，成功最多加载该一项；名称不存在、已非 deferred、未授权或 query 不是完整规范名时直接返回 no-match，不运行 BM25、不做前缀/模糊补偿；
2. 其他自然语言 query 才走现有 BM25/词项重合、字符 trigram、exact/prefix 加分和稳定 tie-break；
3. 分数相同按 namespace + registry name 稳定排序。

`tool_search` 输入只保留 `query`、可选 `namespace` 和 `limit`；`limit` 默认 5、最大 5。模型边界把本轮 catalog digest 随 `tool_search` call 一起写入 Tool Batch。正常执行与冷恢复执行都先调用 `resolveLiveAuthorizedToolCatalog`；当前 digest 已变化时精确返回 `TOOL_SEARCH_CATALOG_CHANGED` 且不加载，相同才在这份刚解析的 catalog 上运行对应 query 分支。`select:` 成功只加载该工具；自然语言成功把前 1–5 个命中工具全部加载。两者都只返回名称、namespace 和短摘要；完整 description/schema 只在下一模型调用出现。

该 descriptor 锁定为 `readOnly=true, destructive=false, concurrencySafe=false`：它没有 workspace/外部副作用，可在中断后安全恢复，但会改变 Execution visibility，不能与同 Batch 的其他调用并行。Registry 的 runtime-only `ToolExecutionSidecar` 增加窄字段 `loadedToolRefs`；Scheduler 在已有 settled-call mutation 中同时提交 finalized result 和 Execution refs，Sidecar 自身不进入 Session/SSE。空结果返回 `TOOL_SEARCH_NO_MATCH` 和可用 namespace 提示，模型可以改写 query，但系统不得自动扩大到全量工具。

搜索本身不连接 MCP、不执行命中工具、不改变权限，也不绕过 Registry。MCP server 只有在当前 snapshot 为 ready 时进入候选集。

### 4. MCP 和 deferred 目录提示

System Prompt 增加一个紧凑 deferred 目录：按 namespace/MCP server 分组，列出每个 deferred 工具的 canonical `registryName` 和 description 第一行（最多 160 个 Unicode 字符），只放原始摘要，不放参数名、参数说明或完整 schema。目录中的名称必须覆盖当前 deferred Authorized Catalog，不能为了省 token 静默隐藏名称；`tool_search` 仍搜索完整 catalog。目录 token 随工具数量增长是显式成本，由 measurement 单独报告。

现有 MCP 语义保持不变：

- 用户 MCP 对六种 Agent 全局授权；内置矩阵仍为 Lead=`context7,exa`、Analyst=`context7`、Librarian=`context7,grep.app,exa`、其他为空；
- 配置热更新后，下一模型边界使用最新 catalog；当前已发给 provider 的 schema 和本次 Tool Batch 的 run-local descriptor 不变；
- 同名 descriptor digest 改变或工具在该模型边界不可用时，旧 loaded ref 不得静默绑定新 contract；`SessionExecutionManager` 通过传入 Agent.run 的窄 `reconcileExecutionToolLoads` callback 在 prompt 编译前原子删除 ref 并追加一条 durable、bounded 模型通知，之后因 ref 已删除不再重复通知；ConfiguredAgent/Projection 不直接写 Execution record；
- MCP 透明 reconnect/replace 若下一模型边界仍提供同 namespace、alias 和相同 descriptor digest，则 loaded ref 保留并使用该边界新的 run-local descriptor。这沿用现有“每个新模型边界绑定当前连接”的语义；连接/config epoch 本身不作为重新搜索或第二批准条件。若 reconnect 窗口内工具不可用，或 model-facing contract 改变，则按上一条失效并要求重新搜索；
- 搜索和加载不增加 MCP 第二批准层，不改变 effectful MCP 的现有风险边界。

### 5. Execution 持久状态

`SessionExecutionRecordBase` 新增 required、去重、稳定排序的 `loadedToolRefs: { name, descriptorDigest }[]`。只存身份和 digest，不存 schema、descriptor、MCP handle、搜索索引或 provider wire。Tool Batch 的 `tool_search` call 另持久化当次 `catalogDigest`，只用于中断恢复的一致性检查。

同一 record 还新增 required `toolAuthorizationSnapshot: { extraTools: string[]; toolProjection: string[] | null }`。`SessionExecutionManager` 在 Execution admission 时先按现有规则验证输入，再与 execution-start 原子持久化；同一逻辑 Execution 的 HITL/child resume、cwd transition 和进程冷恢复只从该 snapshot 重建，不接受调用方重新传值。角色 definition、depth、worktree 与 live MCP 仍由当前 runtime 确定性重建，不复制进 snapshot。新 Execution 从本次已验证输入创建新 snapshot。

`tool_search` 的成功结果与 loaded refs 必须由现有 Tool Batch settlement 在同一次 durable store mutation 中提交；ToolRegistry 只传递 Sidecar，不拥有持久化。冷启动时，`SessionExecutionManager` 新增一个窄恢复分类：只有 active Tool Batch 的全部非终态 calls 都是 `tool_search`，且 Execution authorization snapshot 完整时，才恢复同一逻辑 Execution；ConfiguredAgent 先按 snapshot 建立 live-catalog resolver，QueryLoop 再把原 Batch 交回 Scheduler。存在任一其他非终态 call 时继续走当前 interrupted/manual-inspection 规则，不扩大通用恢复范围。Scheduler 随后按现有 read-only 预算恢复一次并通过该 resolver 取执行瞬间 catalog：digest 相同则确定性重跑，不同则结算 `TOOL_SEARCH_CATALOG_CHANGED`，两种情况都不会进入 effectful manual inspection。暂停、resume、compact 和进程恢复都从当前 Execution record 重建可见投影。旧 Session/Execution shape 不迁移、不兼容读取，并在 breaking release note 中明确。

### 6. State facts 的收集顺序

State Projection 保持纯函数，但 facts 不是假设全在 Zustand Store。ConfiguredAgent 新增一个异步 `collectToolVisibilityFacts` 组合点，复用现有 Goal/Todo、attachment、artifact、Agent Tree 和 worktree 服务，只返回固定结构化 facts；不让纯 Projection 反向依赖这些服务，也不允许 collector 自己持久化 Execution 状态。

每次模型尝试的顺序锁定为：`consumeSteers -> materializeModelContext -> collect facts + live catalog -> reconcile invalid loaded refs -> compile Prompt/tools -> beforeModelBuild compact -> model message projection -> beforeModelCall nudges -> attachment body projection -> provider`。PDF 激活读取已持久 attachment metadata，不等待图片/PDF body 投影；output 激活通过现有 artifact access service 查询可授权 refs。`compress` 不做 State Activation，避免与 `beforeModelCall` 的 token-pressure nudge 形成循环，它保持 searchable。Goal context materialize 在 fact collection 前完成，因此 State 不落后一轮。

## 实施计划

1. **先硬切定义契约**
   - 把六个 AgentDefinition 从 `tools.tools` 改为 `authorized/core`，增加 compile-time/runtime 子集与重复检查；新增 `tool_search` 名称和 descriptor。
   - 删除旧 eager surface 假设和固定 `EXPECTED_TOOL_COUNT=34` 脚本断言；计量改为报告 authorized/core/state/loaded/MCP 各层，不用固定总数掩盖变化。

2. **实现一个可见性投影模块**
   - 在 ConfiguredAgent 组合边界集中实现唯一 live Authorized Catalog resolver、异步 facts collection 和纯 visible descriptor projection；模型边界、正常 search 与 cold recovery 复用该 resolver。
   - 保持 `ResolvedToolSet`、provider 转换、ToolRegistry、permission、hooks 和 output finalization 原样；architecture test 禁止新模块反向进入 Registry。

3. **实现本地搜索和加载**
   - 从真实 model-projected descriptors 建索引并实现确定性混合排序、namespace filter、最多 5 项加载、规范 digest 与 catalog-change 拒绝。
   - `tool_search` 走普通 Registry/Tool Batch/finalizer/audit；runtime-only Sidecar 把 refs 交给 Scheduler，Tool Batch 原子结算 result + loaded refs，下一模型边界读取，不允许同一 response 越权调用。

4. **接通 State、Execution 和恢复**
   - 按锁定顺序从现有 Goal、Todo source、attachment metadata、output artifacts、child topology 与 worktree eligibility 异步收集有限状态事实，再交给纯 Projection。
   - 增加 required Execution authorization snapshot/loaded refs 和 Tool Batch search catalog digest；在 ExecutionManager 增加仅限 search-only 非终态 calls 的冷恢复分类，覆盖正常 step、HITL/permission suspension、同步 child suspension、resume、cwd transition、compact、restart、terminal/new Execution、read-only search recovery 和原子 descriptor invalidation notice。

5. **把 MCP 从 eager 改为 searchable**
   - 删除 `ConfiguredAgent.resolveModelTools` 当前直接 append 全部 MCP descriptors 的路径，改为 live Authorized Catalog 输入。
   - 保留角色授权、hot apply、run-local descriptor、retire/epoch、redaction 和外部副作用语义；增加按 server 分组的 deferred compact directory，列出名称和截断首行，不加入完整 schema。

6. **测量、评测和收口**
   - 让 `tool-contract:measure` 复用生产 projection，固定输出每个 Agent 的 initial/core、state fixture、loaded fixture、MCP 增量及 token；记录修改前后对比。
   - 先提交固定检索 fixture，再实现/调参排序；增加动态 MCP、权限隔离、稳定排序和 1,000-tool 本地性能命令。
   - 更新 AGENTS/架构文档/breaking release note，删除旧实现和旧测试假设；完成 focused、全量 test/typecheck/build 和独立 review。

## 不做什么

- 不接 OpenAI/Anthropic 厂商原生 deferred-tool API；v1 用同一 client-executed contract 覆盖所有 provider，未来如需原生传输优化另立 Goal。
- 不做 embedding、向量数据库、LLM 重写 query、远程搜索服务、学习排序或用户可配置 ranking weights。
- 不做通用工具插件框架、第二 Registry、第二权限链、MCP 工具缓存/副本、per-project MCP 分配或 `alwaysLoad` 配置。
- 不把 Skills 改造成 Tools，也不改变 Skill 激活、Prompt Contract、Agent delegation、Goal/Automation 生命周期。
- 不保留 eager fallback、旧 `tools.tools` reader、兼容 alias、feature flag 或墓碑测试。

## 风险和控制

| 风险 | 控制 |
| --- | --- |
| 搜索漏掉正确工具 | 高频能力留在 Core，明确状态能力直接激活；固定内置 benchmark 要求 Recall@5=100%，无匹配时允许模型改写 query，但绝不全量兜底 |
| 搜索多一次模型 step | 无长尾需求的任务零额外 step；需要长尾时一次搜索最多加载 5 项，并在同一 Execution 后续复用 |
| MCP 描述语言或质量不一致 | 精确路径只依赖目录中的 canonical registry name，不依赖描述语言；自然语言 BM25 不承诺跨语言召回，混合语言 fixture 必须单独测量；不得借翻译、embedding 或 eager fallback 修补 |
| MCP 热更新后误用旧工具 | loaded ref 绑定 model-facing contract digest；变化/消失立即失效，同 digest 的透明 reconnect 延续现有下一边界绑定语义，实际调用始终用当前模型边界的 run-local descriptor |
| State Activation 逐渐变成规则平台 | v1 条件只限本 Goal 的固定事实表，放在一个纯函数模块；新增状态类型必须修改该表和测试，不提供 DSL/配置接口 |
| 初始提示目录变大 | 每项只保留 canonical name 和首行摘要，首行最多 160 个 Unicode 字符，不放 schema；完整目录名称不静默省略，measurement 单独报告其 token 成本 |
| 新 Execution 字段破坏旧持久数据 | 这是明确 hard cut：启动/载入给出可诊断 schema failure 和 breaking note，不迁移、不默认空数组兼容 |

## 验收标准

以下 AC-01 至 AC-08 必须全部满足；任一项缺证据即为 `NOT_DONE`。

### AC-01：授权边界和 Core 精确落地

- 六个 AgentDefinition 只有 `authorized/core` 新契约；`tool_search` 在六者 `authorized` 中但不在 `core`，其余 Core 名称与上表逐项一致。
- 有效本地授权精确等于 `definition authorized + extraTools + eligible worktree tools` 再由可选 `toolProjection` 做交集；注册工具不会自动进入 catalog，`toolProjection` 不能授予工具。GitHub 只有经 `extraTools` 明确授予时才可搜索，测试覆盖已授予/未授予两种情况。
- Execution admission 将验证后的 `extraTools/toolProjection` 原子固化为 required authorization snapshot；同一逻辑 Execution 的 HITL/child resume、cwd transition 和 cold recovery 从 snapshot 重建且拒绝调用方替换。新 Execution 使用新 snapshot，旧 shape 不默认补空值。
- 现有每个角色基础能力、Execution overlay、delegation depth、Skill allow-list、用户 MCP 全局授权和 builtin MCP 角色矩阵均有 before/after 集合相等测试；Visibility Projection 只能减少有效授权，不能扩大授权。
- 生产代码、fixture 和文档中不存在旧 `tools.tools`、第二个授权合并器、deprecated alias 或兼容分支。

### AC-02：首轮模型工具面符合 Core + State

- 对六种 Agent 的最小合法 runtime identity，真实 `resolveModelBoundary().tools.toAITools()` 只包含锁定 Core、身份必需的 State（Discussion 为 `project_todo_update`），以及存在 deferred 候选时的 `tool_search`，不含任一 MCP 完整 schema。Lead、Analyst、Build、Explore、Librarian fixture 不设置可选 State；Discussion 使用生产要求的 Todo-bound root identity。
- Goal、PDF attachment、output ref、各 child 状态和 worktree 状态逐项 fixture 只加入状态表指定且当前 Agent 已授权的工具；这些可消失状态撤销后的下一模型边界撤下对应 State 提升，除非同一工具另由当前 Execution 的 loaded ref 合法保留。Discussion 的 Todo source 是不可变身份，自动化测试应证明 `project_todo_update` 在合法边界持续存在，不得伪造 direct Discussion 来测试消失。`compress` 不在 State 表中。
- 自动化顺序测试证明 Goal context materialize 在 facts collection 前，facts collection/reconcile 在 Prompt/tools compile 前，attachment body projection 仍在 message projection 后；首轮 PDF/output/Goal fixture 不允许落后一轮。
- 异步 collector 只调用现有 Goal/Todo/attachment/artifact/Agent Tree/worktree 服务并返回固定结构化 facts；纯 Projection 不依赖这些服务、不读取自然语言、不访问网络、不注册通用规则 DSL。

### AC-03：目录和搜索可重复且能找回内置长尾

- 首轮 prompt 对每个 deferred candidate 都输出一次 canonical `registryName`，按 namespace/MCP server 分组；每条 description 只取原始首行并限制为最多 160 个 Unicode 字符，不输出完整 description/schema。无 description 时仍输出名称，未授权或非 ready 工具不得出现。
- 同一 catalog/query/namespace/limit 在重复运行、重启和 descriptor 枚举顺序变化后返回同一结果；`select:<exact registryName>` 只做精确命中，失败不得运行 BM25；其他自然语言 query 才使用现有 BM25/trigram 排序，exact/prefix 只在该排序内加分。
- 固定 fixture 位于 `packages/agent-core/src/agents/tool-visibility/search-eval-cases.ts`，必须在 ranking 实现/调参前作为独立提交进入 review。Fixture 显式保存六个 Agent 各自“无 Goal/Todo/attachment/output/child/worktree/extraTools/MCP、无 loaded refs”的完整 deferred builtin 名称数组；测试先断言生产 catalog 与这些数组逐项相等。每个至少在一个 Agent 中 deferred 的 builtin 恰好三类 case：不含 registry name token 的自然能力描述、不含 registry name token 的常见同义表达、以及对 registry name 最长非下划线词做一次中间相邻字符交换的确定性 typo；每条显式保存 `agent/query/namespace/expectedTool`，并始终在该 Agent 的完整锁定数组上搜索。测试拒绝缺项、重复项、前两类泄漏 registry name、expectedTool 不在 catalog，以及 `tool_search` 出现在任一 corpus。全部 expected tool 必须进入 Top 5，即 `Recall@5 = 100%`。
- 两个本地 MCP fixture（含相似名称、不同 namespace、长 description 和 enum 参数）逐项得到锁定 Top 5；未授权、disabled/connecting/failed MCP 和超出角色 builtin 矩阵的工具命中率必须为 0。
- 搜索实现无 LLM、embedding、网络和远程服务调用。`bun run tool-search:benchmark` 固定用 1,000 个 stable synthetic entries、上述 fixture 的前 100 条 query（不足则按稳定顺序循环）、20 次不计时 warmup 和 10 次完整计时；每次包含建索引 + 100 次搜索，报告 10 次 total 的 p50/p95，p50 必须小于 1 秒，不以 sleep/retry 通过。Benchmark 是独立验收命令，不塞进普通 unit test lane。

### AC-04：加载与模型调用边界正确

- `select:<exact registryName>` 一次只加载一个已授权 deferred 命中项；自然语言 query 一次加载 1–5 个已授权命中项。两者的 result 只返回选中项短摘要，下一模型 step 才出现完整 schema。
- 模型在同一个 response 中伪造调用未提供工具时，被现有 Tool Batch allowed-tools 边界拒绝；搜索不执行命中工具、不授予权限、不绕过 permission/finalizer/audit。
- 每个 `tool_search` call 的 Tool Batch 记录模型边界 catalog digest；执行前 digest 改变时只结算 `TOOL_SEARCH_CATALOG_CHANGED`。Descriptor traits 精确为 read-only、non-destructive、non-concurrency-safe。
- 模型边界、正常 search execute 和 cold recovery 使用同一个 ConfiguredAgent `resolveLiveAuthorizedToolCatalog`；自动化 spy 证明三条路径均在执行瞬间调用，QueryLoop 只透传 resolver，Registry/descriptor 不拥有 catalog 构建或缓存。
- `tool_search` 必须从 deferred count、索引 entries、search results、loaded refs 和 builtin/MCP eval corpus 五处全部排除；无其他 deferred candidate 时它自身不可见。
- Registry settled Sidecar 中的 refs 不进入 model/SSE；Scheduler 在既有 settled-call store mutation 中原子写入 finalized result + Execution refs。Registry 与 descriptor 不直接写 Execution record。
- loaded 项去重并在同一 Execution 后续 step 可见；新 Execution 的 loaded refs 必须为空，不能继承前一次 Session 历史。
- `select:` 的名称不存在、已非 deferred、未授权或不完整时精确返回 `TOOL_SEARCH_NO_MATCH`，不得回落 BM25；自然语言 query 才能进入 BM25。不存在自动 load-all、隐藏重试、provider fallback 或 eager fallback。

### AC-05：暂停、恢复、重启和 MCP 变化不误绑

- tool_search 成功结果与 `loadedToolRefs` 在同一 durable mutation 中提交；故障注入证明不能出现“结果成功但未加载”或“加载已持久化但调用结果未结算”。
- `SessionExecutionManager` 冷恢复只接纳“active Batch 的全部非终态 calls 均为 `tool_search` 且 authorization snapshot 完整”的同一逻辑 Execution；混有任何其他非终态 call 时保持当前恢复/终止语义。自动化测试证明被接纳 Batch 真正进入 `SessionToolBatchScheduler.recoverInterruptedBatch()`。
- 进程在 search call queued/running/descriptor-returned-before-commit 三个点中断时，ConfiguredAgent 先从 durable authorization snapshot + current runtime 建立 resolver；catalog digest 相同只按现有 read-only 预算重跑一次并得到同一命中，digest 改变则结算 `TOOL_SEARCH_CATALOG_CHANGED`，两者都不进入 `manual_inspection_required`。
- 同一 Execution 跨普通 step、HITL/permission suspension、同步 child suspension、resume、compact 和进程重启后，digest 未变的 loaded 工具仍可见。
- descriptor 改 digest或工具在边界不可用时，Execution owner 在一次 durable mutation 中删除旧 ref 并追加一条 bounded 模型通知；连续两个模型边界只出现一次通知，重新搜索后才加载新 digest。
- MCP 同 namespace/alias/descriptor digest 的透明 reconnect/replace 保留 loaded ref，并让下一 Tool Batch 使用该模型边界的 run-local descriptor；schema/description/traits/outputPolicy 改变、disable/delete 或边界时 unavailable 均失效。连接 epoch、handle 和 secret/config 不进入 descriptor digest。
- ToolRegistry、Session/Execution 文件中不存在 schema、descriptor、MCP handle、搜索 index、generation 或工具副本；Execution 只持久化授权名称 snapshot 与 `{name, descriptorDigest}` refs，Tool Batch search call 只额外持久化 catalog digest。

### AC-06：上下文收益可量化，正常路径不降速

- 修改后默认无状态 Lead 的真实 initial tool wire（Core + `tool_search`，不含 deferred 目录正文）不超过 6,000 `o200k_base` tokens，且相对当前 11,845-token 本地基线下降至少 45%。
- 默认 ready `context7`/`exa` 不再增加首轮完整 tool wire；deferred 目录逐项按 namespace/MCP server 输出 canonical name + 最多 160 个 Unicode 字符的 description 首行，不输出 schema；目录 token 数单独计量，不能用隐藏工具名或全量 schema 达标。
- 不需要长尾工具的固定 query-loop fixture 与当前架构模型调用次数相同；需要长尾工具的 fixture只允许增加一次 `tool_search` model step，后续复用不重复搜索。
- `bun run tool-contract:measure` 不依赖 vendor credentials 或临时文件，并报告每个 Agent 的 tool count、full/name/description/parameters tokens、MCP deferred count、state/loaded 增量和修改前后百分比。

### AC-07：安全、MCP 和观测边界不退化

- `tool_search` 仅搜索当前 Agent/depth/Session 状态已授权 descriptors；未授权工具名称即使完全匹配也不出现在结果、日志或 deferred 目录中。
- 搜索、加载和实际执行各有 Prompt trace/audit 字段：catalog digest、initial/state/loaded 名称、deferred count、search query、命中及 descriptor digest；不得记录 MCP secret 或完整敏感输入。
- 现有 MCP hot apply、run-local descriptor、retire/epoch fencing、timeout/cancel、redaction、effectful unknown-result 和无第二 approval 语义的 focused tests 全部继续通过。
- Registry 仍是 Raw-to-Finalized 唯一边界；architecture test 禁止 Registry 依赖 Agent visibility、MCP runtime 或 SessionExecutionManager。

### AC-08：硬切、验证和独立验收完成

- 当前 eager MCP append 路径、旧固定 tool-count 断言和所有被替换实现已删除；无 feature flag、旧行为 fallback、兼容 reader、deprecated export 或墓碑测试。`select:` 精确失败不得回落 BM25。
- Focused unit/integration/architecture tests、`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 更新后的 AGENTS/架构文档/breaking release note 与 runtime 一致，明确旧持久 Execution shape 不兼容、MCP 改为 deferred、搜索失败不回退。
- 独立 Reviewer 必须按 AC-01 至 AC-08 给出源码、测试、命令和测量证据；只说“测试通过”或“token 下降”不能判定完成。
