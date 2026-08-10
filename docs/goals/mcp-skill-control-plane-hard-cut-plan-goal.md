# MCP And Skill Control Plane Hard-Cut Plan Goal

> 本文是 MCP Runtime 重构与 Skill 控制面完善的唯一实施、验收契约。实施进度和验收证据另记于 `mcp-skill-control-plane-hard-cut-progress.md`，不得用进度记录改写本契约。

## Objective

把当前“一次启动发现、静态注册、用户 MCP 受 Agent 名单限制”的实现硬切为可热更新的全局 MCP Runtime；同时保留现有 Skill Package 安全内核，只补齐发现兼容、诊断和确定性显式激活。完成后：

- 所有启用的用户 MCP 服务器和工具对全部六种 Agent 实时可见；内置 MCP 保持产品定义的角色映射，不开放用户分配。
- MCP 工具无需额外确认即可读写外部系统；ToolRegistry、输出最终化、审计、脱敏和不确定结果恢复仍是强制边界。
- MCP 支持 Streamable HTTP、STDIO、启停、测试、重连、分阶段超时和保存后热应用；OAuth、Resources、Prompts 和富媒体不在本 Goal。
- Skill 继续只提供指导，不能授予工具、Profile、Agent、MCP、workspace 或完成权限；一个损坏的可选 Skill 不再拖垮整个 Execution。
- 被本 Goal 替换的旧配置、Manager、用户 MCP 角色过滤、MCP 审批路径和模型驱动显式 Skill 激活直接删除，不保留 fallback、双路径、迁移器、兼容 alias 或墓碑测试。

## Evidence Baseline

以下证据按 2026-08-09 的公开文档和本分支 `9f1f47f6` 源码锁定方向：

| Evidence | 借鉴内容 |
| --- | --- |
| [OpenAI MCP](https://learn.chatgpt.com/docs/extend/mcp) | HTTP/STDIO、启停、独立超时、认证与工具列表控制的产品形态 |
| [Claude Code MCP](https://code.claude.com/docs/en/mcp) | 连接状态、重连、工具列表刷新和大工具集治理；本 Goal 不实现 tool search |
| [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/) | STDIO/HTTP 配置、状态检查和认证生命周期；OAuth 延后 |
| [Agent Skills client guide](https://agentskills.io/client-implementation/adding-skills-support) | `.agents/skills`、渐进披露、诊断隔离和宿主确定性激活 |
| [MCP 2026-07-28](https://blog.modelcontextprotocol.io/posts/2026-07-28/) | 不新增旧 HTTP+SSE、Roots、Sampling 或 Logging；协议协商交给官方 SDK |

竞品只提供模式证据，不改变 ArchCode 既有 ToolRegistry、Execution、Agent 和 Skill 权限所有权。

## Locked Decisions

### MCP visibility and authority

- 用户 MCP 不再经过 Agent allow-list：每次模型调用直接读取当前启用的 MCP 工具，并为本次调用保留一个纯内存、run-local descriptor map；它产生的 MCP tool call 只能使用该 map，绝不按 alias 改绑到后来出现的同名工具。配置不增加 `agents`、project scope、tool include/exclude、approval mode 或信任级别；关闭用户服务器是唯一用户 MCP 能力过滤方式。
- 现有内置 MCP 角色边界保持不变，但字段硬切为仅表达产品策略的 `builtinMcpServers`：Lead=`context7,exa`，Analyst=`context7`，Librarian=`context7,grep.app,exa`，Discussion/Build/Explore 无内置 MCP。用户不能修改该映射；`disabledBuiltins` 可全局关闭其中的服务器。
- MCP 不创建 permission/HITL。Tool annotations 按规范保守默认解析，只用于准确 traits、顺序调度和 UI 展示；即使标为 destructive，也通过 MCP adapter 的确定性 allow decision 直接执行。
- 这意味着原本本地源码只读的 Agent 也能通过 MCP 修改外部系统。这是用户明确接受的产品边界；文档和 Prompt 不得继续声称这些 Agent 对外部 MCP 也是只读。
- 所有 MCP 工具结果继续经过 Registry 的 exactly-once Raw-to-Finalized、脱敏、artifact、审计和 logger 管线。Skill 永远不能启用、关闭或扩大 MCP。

### Global hard-cut configuration

MCP 仍只读取 `~/.archcode/config.json`。新 schema 是 strict discriminated union：

```json
{
  "mcp": {
    "disabledBuiltins": ["exa"],
    "servers": {
      "remote-docs": {
        "type": "http",
        "enabled": true,
        "url": "https://example.com/mcp",
        "headers": { "Authorization": "${MCP_TOKEN}" },
        "connectTimeoutMs": 10000,
        "discoveryTimeoutMs": 30000,
        "callTimeoutMs": 60000
      },
      "local-tools": {
        "type": "stdio",
        "enabled": true,
        "command": "my-mcp-server",
        "args": ["--stdio"],
        "env": { "TOKEN": "${MCP_TOKEN}" },
        "connectTimeoutMs": 10000,
        "discoveryTimeoutMs": 30000,
        "callTimeoutMs": 60000
      }
    }
  }
}
```

- `type` 和 `enabled` 必填。HTTP 只接受 `http:`/`https:`；STDIO 要求非空 command，args/env 可选，不增加 shell string、cwd 或项目变量插值。
- 三个 timeout 可省略，内部默认分别是 10、30、60 秒；必须为有界正整数。旧单一 `timeout` 字段、无 `type` 的 `{url,headers}` 结构直接失效。
- `disabledBuiltins` 只能包含当前内置 ID、不得重复。内置 URL/transport 仍由 ArchCode 固定，不能出现在 `servers` 中被覆盖；Settings 只允许启停、测试和重连。
- HTTP headers 和 STDIO env 复用 Config secret mutation、环境变量展开和日志脱敏边界。旧 MCP 配置不迁移、不自动改写，Config Recovery 只报告新 schema 错误。
- 使用支持当前 MCP 规范的官方 TypeScript SDK 公共 transport API。SDK 自身的协议协商不算 ArchCode fallback；生产代码不实现旧 HTTP+SSE 或两套自有协议路径。

### MCP runtime ownership and hot apply

保留一个高内聚 `McpRuntimeService`，只拥有全局 server config、当前连接、已发现工具、状态、测试/重连和关闭；不建立通用 Plugin Manager，也不为 Session 或 Execution 保存 MCP 状态。

```text
ServerConfigService atomic save
  -> ServerHost serialized mutation
  -> AgentRuntime.applyMcpConfig(resolved config)
  -> McpRuntimeService atomically updates current servers and tools
  -> Agent/query builds each model call from the current tools
  -> ToolRegistry executes/finalizes its run-local resolved descriptor
```

- MCP descriptors 不再永久追加到全局可变 ToolRegistry。`McpRuntimeService` 提供当前用户 MCP，Agent/query 组合边界再加入角色固定的内置 MCP 并生成 run-local descriptor map。ToolRegistry 只增加 MCP 无关的 `executeResolved(descriptor, call, context)` 入口，与原有按名称 lookup 汇入同一个内部校验、permission/hook、执行和 exactly-once finalization 管线；Registry 不导入 MCP、Config 或 Agent policy。
- 不存在 per-Session/per-Execution MCP 工具副本、版本、fingerprint、lease 或可用于恢复/重绑的持久化字段。现有 Tool Batch 的 tool name/traits/allowed-tools 和 Prompt trace 可以继续作为只读历史审计，但不得包含 handle、descriptor reference、MCP version token 或 server config，也不得用于恢复解析。所有项目、Session 和 Agent 直接使用 `McpRuntimeService` 的当前状态。
- Query loop 在每次模型调用前重新读取当前 descriptors/status/inventory。该次模型调用只保留 run-local descriptor map；若配置在响应流中变化，旧 server handle 会被标记 retired，随后才产生的 call 在开始前得到 `TOOL_MCP_NOT_AVAILABLE`，不会按同名新 descriptor 误执行。下一模型调用立即读取最新工具并可重试。
- 若同一 Tool Batch 因 `ask_user`、permission 或同步 child dependency 即将暂停，scheduler 在提交 suspension 前把其中所有尚未开始的 MCP calls 通过现有 finalization 边界结算为 `TOOL_MCP_INTERRUPTED`。Resume 不保留、重建或按名称解析 descriptor reference。
- 已经开始执行的单次 MCP call 持有其 server handle 直到 settlement；这只是 call-local in-flight 计数，不属于 Session/Execution 状态。服务器被替换、关闭或删除后，retired handle 不接受新调用；它在最后一个已开始调用结束或超时后关闭一次。
- Apply 以 server 为单位替换。Winning save/reconnect/disable epoch 在任何 connect/discovery `await` 前同步 retire changed/disabled handle、移除其工具并发布 `connecting|disabled`；未变化连接继续复用。Candidate ready 后才重新提供工具，失败则保持不可用并显示 failed，不保留临时 last-good fallback；其他服务器继续工作。迟到的 connect/disconnect/list 结果只能关闭自己的候选资源，不能覆盖更高 epoch 的工具和状态。
- `tryAcquireCall()` 与 handle retire 都是无 `await` 的原子判定：call 先 acquire 就进入 in-flight drain，retire 先发生就返回 `TOOL_MCP_NOT_AVAILABLE`。连接意外断开使用相同 retire/remove 路径并发布 failed。
- Config 文件原子保存成功后不回滚。MCP apply 失败通过 Config response 和全局 SSE 明确报告；`mcp` 从 restart-required sections 删除。手动 `Test` 接受 Settings 未保存 draft，通过与保存相同的 schema、secret mutation 和环境变量解析后建立临时连接，随后关闭；它不写 Config、不发布工具。`Reconnect` 只重建并发布已保存服务器。
- 状态硬切为 `disabled | connecting | ready | failed`。Ready 包含工具数与连接时间，Failed 包含脱敏错误与失败时间；不存在旧 `pending` 或未被生产路径使用的假状态。
- 不增加无限后台 retry。连接断开转 failed；用户保存配置或点击 Reconnect 后重试。工具列表在连接/重连时完整刷新。
- 每个 server handle 持有自己的 MCP secret redaction policy；被替换 handle 在 in-flight calls 排空前继续用旧 policy。MCP transport/descriptor adapter 在构造 `RawToolResult` 前脱敏成功输出、structured content 和错误；状态、SSE、连接日志和候选 apply 错误在离开 `McpRuntimeService` 前脱敏。Registry/Finalizer 不依赖或接收 redaction policy；secret 长度/数量在 Config 写盘前验证。
- 进程重启只从当前全局 Config 重新连接 MCP 并发现工具，不恢复历史工具列表或 descriptor reference。Startup reconciliation 对已发出且结果不确定的 effectful call 继续使用现有 `manual_inspection_required`；其他未完成 MCP call 统一以 `TOOL_MCP_INTERRUPTED` 结算并归档，不跨重启自动重放。下一模型调用直接读取最新工具。

### MCP tool adaptation and execution

- 支持规范工具名，并生成 provider-safe、最多 64 字符、冲突安全的稳定 registry alias；超长名使用确定性截断加 hash，不静默丢弃合法工具。UI/audit 同时保留原 server/tool 名。
- annotations 缺失时按 MCP 保守默认处理：非只读、可能 destructive、非幂等、open-world。它们不触发确认或拒绝；只有明确只读的工具可并发，其余 MCP 调用串行。
- connect、tools/list 和 tools/call 使用各自 deadline。Execution abort 和 call timeout 必须传入 SDK/transport cancellation；不能只用不取消底层工作的 `Promise.race`。
- Adapter/transport 明确记录调用尚未发出或已经交给 transport。发出前取消是普通 abort。Live read-only abort/timeout 分别结算为 `TOOL_MCP_CALL_ABORTED`/`TOOL_MCP_CALL_TIMEOUT`，scheduler 不自动重放原 call；若 Execution 仍可继续，模型可显式发起新 call。跨进程重启不自动恢复任何 MCP read call，而是结算为 `TOOL_MCP_INTERRUPTED`。只有 effectful 调用发出后无法证明未执行时才返回 `unknownResult: true`。现有 Tool Batch scheduler 是唯一状态所有者：它在 finalized result 提交点原子写入结果与 `effectful_cancelled_unknown`，把 call/batch 转为 `manual_inspection_required`，不二次 finalization、不自动重放，也不给模型普通“请重试”提示。响应与取消竞态由一次性 settlement guard 决定，迟到完成只能被丢弃并记录脱敏日志。
- v1 结果继续支持 text 和 bounded `structuredContent`，统一进入现有 artifact/finalizer。Image、audio、resource link、embedded resource 明确延后，不新增半套媒体适配。

### Skill control plane without a new Skill runtime

- 保留 `schema.ts`、`package-reader.ts`、builtin manifest 和一个 `SkillService`；不重写已经验收的 package、symlink、资源限制和单资源读取边界。
- 来源优先级硬切为：project `.archcode/skills` > project `.agents/skills` > user `~/.archcode/skills` > user `~/.agents/skills` > builtin。一个 winning package 始终原子胜出，不跨来源合并或资源 fallback；reserved lifecycle builtins 继续不可 shadow。
- `SkillService` 返回 catalog entries 和独立 diagnostics。损坏的普通候选被隔离且不进入模型目录；同名低优先级来源不得顶替。显式激活、delegated active Skill 或 lifecycle Skill 无效时仍 fail closed。
- 第一版不增加 Skill enable/disable 或新的 Skill Config；管理面只负责发现、来源、冲突和错误诊断。
- 保留 `/skill use <name> <request>` 作为唯一文本命令，但硬切其实现：command handler 解析并校验 winning Skill，`completeCommandAsMessage` 在同一 durable mutation 中把规范化 name 写入 pending input 的 `executionSkillNames`，并纳入 command receipt 的幂等 fingerprint。重复 `clientRequestId` 必须回放同一 pending input；已有冲突的一次性 Skill pending 时拒绝第二个不同 Skill。
- `SessionExecutionManager` 在 queue claim 时把 `executionSkillNames`、winning source tier 和 whole-package digest 原子写入 Execution record，同时取得由现有 package bounds 限制的 immutable Skill package snapshot。Digest 覆盖 source tier、原始 entry bytes，以及按相对路径排序的每个 resource path、byte length 和 content bytes；首个模型调用前注入完整 entry/resource inventory，但不把 resource body 注入 Prompt。
- Execution tool context 给已激活的一次性 Skill 提供 snapshot-aware resolver；`skill_read({name})` 和 `skill_read({name,resource})` 都从 snapshot 返回 entry/inventory/resource，不回到 live filesystem，也不建立第二个 VFS/cache。暂停/resume 复用 snapshot；进程重启只在当前 winner source tier 与 whole-package digest 都相同后重建，否则以 `SKILL_PACKAGE_CHANGED` 在模型调用前 fail closed。终态释放 snapshot。模型 wire 中不再出现要求先调用 `skill_read` 的 continuation message。
- 模型的隐式选择仍可使用 `skill_read`；active lifecycle 和 delegated Skills 继续走当前持久身份。显式一次性 Skill 只作用于该逻辑 Execution，不永久改写 Session `activeSkillNames`。Composer picker 提交同一个 `/skill use` command contract，不建立第二套 mention 或激活协议。
- available Skill 的 Prompt 目录由一个 canonical projection 函数生成 `{includedEntries, omittedCount, renderedText, byteLength}`，只供 System Prompt、Prompt trace 和对应 UI 预览。输入按 SkillService 的确定性 catalog 顺序；description 先把空白规范化为单空格，再在 Unicode code-point 边界截为最多 160 UTF-8 bytes（发生截断时 160 bytes 包含 `…`）；固定 renderer 再按顺序装入 entry，并为精确 omitted footer 预留空间，直到完整 UTF-8 输出不超过 8,000 bytes。Active Skill 正文不受目录预算截断。
- `skill_list` 从同一完整 catalog 提供 strict cursor pagination：每页最多 50 entries 且序列化 JSON 最多 24 KiB，opaque cursor 绑定 catalog digest 与下一 index；catalog 改变时返回 `TOOL_SKILL_CATALOG_CHANGED` 并要求从第一页重取。这样 Prompt omitted Skill 仍可按需发现，不引入 tool search 或第二个 Skill runtime。
- 提供当前项目完整诊断 catalog 的 digest-bound cursor API（每页最多 50 records、64 KiB JSON），以及复用它的 Composer picker/管理面，显示 name、source、winner、valid/invalid/shadowed、diagnostic；Prompt 预览另显示 projection omitted count。Picker 和 inventory 不受 8,000-byte Prompt 截尾。不新增 Skill installer、marketplace、远程 catalog 或启停状态。

## Implementation Plan

1. **Hard-cut Protocol and Config contracts**
   - 引入新的 MCP transport union、timeout、builtin-disable、live status/tool inventory DTO，以及 pending input/Execution 的一次性 Skill overlay 和 Skill fingerprint 字段；不增加任何持久 MCP 工具版本或身份。
   - 更新 Config secret masking/mutation、semantic validation、Settings draft 和 release note；删除旧 MCP config shape、单 timeout、旧 status 和 restart-required MCP 比较，不编写迁移或旧格式墓碑测试。

2. **Replace the MCP client/manager**
   - 用一个 `McpRuntimeService` 和窄的 HTTP/STDIO connection adapter 替换当前 `McpManager`、一次性 background discovery 和永久 Registry 注册。
   - 实现 connect/discovery/call cancellation、server lifecycle、test、reconnect、per-server failure isolation、规范 name alias 和完整关闭；删除 MCP destructive approval 模块。

3. **Wire one global live MCP runtime**
   - 在 Agent/query 组合边界每次模型调用重新投影当前 schema/status/inventory，并让本次调用产生的 MCP calls 只使用 run-local descriptor map；暂停前结算未开始调用，resume/restart 不重绑。
   - ToolRegistry 只增加 MCP 无关的 `executeResolved` 并复用原内部管线；architecture test 禁止 Registry 依赖 MCP/Config/Agent policy。将 `AgentDefinition.mcpTools` 硬切为产品拥有的 `builtinMcpServers`，删除用户 MCP prefix allow-list，让六种 Agent 都加入全部当前用户 MCP。
   - 覆盖同步 retire、原子 acquire/retire、call-local handle drain、epoch fencing 和启动恢复的不确定工具结果；不增加 MCP 工具副本、generation、lease 或 Session/Execution 持久字段。

4. **Wire live config and control routes**
   - ServerHost 在现有 mutation queue 内完成 Config save 后调用 Runtime MCP apply；暴露 status、inventory、test、reconnect，并通过已有 global SSE 发布状态。
   - Test 校验未保存 draft 但不写盘/发布；保存失败零变化；保存成功但连接失败时 Config 保留且状态准确。MCP apply 不重启 Server、AgentRuntime 或正在运行的 Execution。

5. **Extend the existing SkillService**
   - 增加 `.agents/skills` 两个来源、隔离 diagnostics、Prompt-only canonical projection、paginated `skill_list` 和完整 inventory API；保留 package reader，不创建 registry/VFS/cache。
   - 将 `/skill use` 改为 durable pending-input overlay，并由 SessionExecutionManager 在 claim 时固化 whole-package snapshot 和 resolver；Composer picker 与管理状态复用同一服务，不增加另一个 Skill 状态机或 enable/disable Config。

6. **Build the MCP and Skill management surfaces**
   - MCP Settings 支持 HTTP/STDIO 编辑、秘密字段、启停、内置锁定、状态、工具 inventory、Test/Reconnect 及清晰错误；删除旧“修改后需重启”文案。
   - Skill 管理面和 Composer picker 只消费完整 inventory/command contract。两个 UI 都按现有 design-system 与 UI/UX Pro Max 工作流完成键盘、焦点、窄屏、非颜色状态和 pending 防重复；不创建无必要 prototype。

7. **Hard-cut documentation and verification**
   - 更新 AGENTS、配置文档、MCP/Skill 架构说明和 breaking release note；删除被替换的代码、测试 fixture 和文案，不保留 fallback、deprecated export、兼容 reader 或墓碑测试。
   - 完成 focused、Agent Core、Server、Web、architecture、真实 HTTP/STDIO fixture、浏览器、typecheck/test/build 和独立 reviewer 验收。

## Non-goals

- 不实现 OAuth、bearer login flow、Resources、Prompts、MCP Apps、Tasks、elicitation、富媒体或 tool search；不实现旧 HTTP+SSE、Roots、Sampling、Logging。
- 不实现用户 MCP 的 Agent/project/tool 分配、allowlist/denylist、approval mode、信任级别、后台无限重试或 last-good fallback；产品内置 MCP 的固定角色映射不属于用户配置。
- 不实现 Skill installer、远程 registry、marketplace、自动脚本执行、Skill 提供 MCP/工具权限、厂商目录扫描或通用 Plugin Runtime。
- 不改变 Base Tool 权限、SessionExecutionManager 所有权、ToolOutputFinalizer、HITL、Automation/Goal 生命周期或 Provider Prompt 分支。
- 不实现 Skill enable/disable，不迁移旧 Config 或持久数据；不增加旧字段 rejection 专用测试。现有测试中仍有价值的行为覆盖直接改写为新契约。

## Risks And Controls

| Risk | Control / accepted boundary |
| --- | --- |
| 任意 Agent 可无确认修改外部系统 | 用户明确接受；所有调用仍审计、脱敏、顺序调度，超时不确定结果禁止自动重放 |
| 旧 MCP Config 启动失败 | 明确 breaking release note 和 Config Recovery 诊断；无自动迁移、fallback 或双 schema |
| 配置在模型响应流或 Tool Batch 暂停前变化 | run-local descriptor 不改绑新工具；retired handle 拒绝新 acquire，暂停前结算未开始 MCP call，下一模型调用读取最新工具 |
| 某服务器失败拖垮全部 MCP | server-level isolation；失败服务器不再提供工具，其他 ready 服务器继续工作 |
| 热添加或删除 secret 造成旧调用泄漏 | redaction policy 跟随 server handle，只保留到已开始调用排空；Config 写盘前验证 secret policy |
| STDIO 子进程泄漏或输出污染 | SDK transport 单 owner、bounded stderr logging、明确 close/abort tests，stdout 只属于 MCP transport |
| MCP 工具过多增加上下文 | 本 Goal 接受 eager exposure；记录工具数和 schema 大小，达到真实问题后再单独设计 tool search |
| Skill 来源增加造成同名冲突 | 固定完整 precedence、winner/shadowed diagnostics、无低来源 fallback |

## Acceptance Criteria

AC-01 至 AC-08 必须全部给出代码、自动化命令或真实 UI 证据；任一缺失即为 `NOT_DONE`。

### AC-01: MCP config hard cut is complete

- 新 HTTP/STDIO、required `type/enabled`、三个 timeout、`disabledBuiltins` 和 secret mutation round-trip 均有 schema/semantic tests；默认 timeout 精确为 10/30/60 秒。
- 当前 Config 样例、Settings 和文档只生成新 shape。生产代码不存在旧单 `timeout`、无 type server parse、builtin override 或 MCP restart-required 分支。
- 旧 shape 只会作为普通新 schema validation failure 被 Config Recovery 报告；没有 migration、dual parse、fallback、deprecated alias 或只证明旧 shape 死亡的墓碑测试。

### AC-02: user MCP is global while builtin MCP keeps product role boundaries

- 同一时刻，六种 Agent 的下一次模型调用都包含全部启用用户 MCP 工具；关闭任一用户服务器后，六种 Agent 无需新建 Session 或 Execution，下一模型调用即不再看到其工具。
- 自动化矩阵精确证明内置 MCP 仍为 Lead=`context7,exa`、Analyst=`context7`、Librarian=`context7,grep.app,exa`、Discussion/Build/Explore=空；`disabledBuiltins` 关闭后所有原可见角色均移除该服务器。
- `AgentDefinition` 只保留新 `builtinMcpServers` 产品策略；factory、Prompt、Config 和生产测试 fixture 中不存在旧 `mcpTools`、用户服务器 prefix allow-list 或用户可配置的 Agent/project/tool 分配字段。
- 本地 Base Tool、delegation depth 和 Skill allow-list 保持各 Agent 原边界；文档明确本地只读 Agent 仍可调用具有外部写副作用的 MCP。

### AC-03: MCP updates globally in real time without Session state

- 自动化测试让运行中的 Execution A 完成一个模型 step，再保存变化后的 Config：A 的下一模型调用立即使用新 schema/status/inventory；另一个项目中的 Session B 同时读取相同的最新工具，无需重启或重建 Execution。
- 生产协议、Session 文件、Execution record、Agent cache 和 Runtime 恢复代码中不存在 MCP handle/reference、工具副本/version token、generation、fingerprint、lease 或 project-specific MCP state。Tool Batch/Prompt trace 只保留 tool name、traits、allowed-tools 和可读状态等审计事实，且没有生产解析路径使用它们重绑 descriptor。
- 配置在模型响应流中变化时，该次已发送 schema 保持不变；run-local descriptor 不会改绑同名新工具。Retired handle 对尚未开始的 call 返回 `TOOL_MCP_NOT_AVAILABLE`；下一模型调用显示当前工具并可自行重试。
- `ask_user -> MCP`、permission blocker 与 `delegate -> MCP` 混合 batch 测试证明 suspension 持久化前，尚未开始的 MCP calls 已各自 finalized 为 `TOOL_MCP_INTERRUPTED`；resume 不持有 descriptor，也从不按 alias 执行新 handle。
- 已开始调用在服务器 replace/disable/delete 后仍使用原 handle 正常 settlement；新调用只使用当前 handle。旧 handle 在最后一个 in-flight call 结束或超时后关闭一次，没有调用时立即关闭；这部分状态只存在于 `McpRuntimeService`，不关联 Session/Execution。
- 单个新服务器连接失败时 Config 已保存、该服务器 status=failed 且不提供工具；其他服务器及 Runtime 保持可用。生产代码没有 last-good fallback。
- Changed/disabled/reconnect handle 在 winning epoch 的首次异步连接等待前已同步 retire、移除工具并发布 connecting/disabled；candidate 连接的整个等待期内，所有模型调用和 tool acquire 都看不到旧 descriptors。Ready 才重新提供工具，failed 保持不可用。
- `tryAcquireCall` 先于 retire 时调用进入 drain；retire 先于 acquire 时调用精确返回 `TOOL_MCP_NOT_AVAILABLE`。并发 reconnect/disable/save 和迟到 connect/list/disconnect 测试证明只有最高 apply epoch 可发布当前工具和状态，stale candidate 被关闭。
- Config response 不再要求 MCP restart；Server、AgentRuntime 和活跃 Execution 未重启，status/inventory API 与 SSE 一致。
- 进程重启只加载当前 Config。Interrupted effectful call 仍进入 `manual_inspection_required`；其他未完成 MCP call 一律以 `TOOL_MCP_INTERRUPTED` 结算并归档，不按同名当前工具自动重放。下一模型调用直接读取最新工具。
- 新增、替换和删除 header/env secret 时，旧 handle 的结果、structured content、错误和日志仍由其 policy 脱敏直至 in-flight drain；当前 handle 使用当前 policy。测试证明脱敏发生在 MCP adapter/Runtime 边界且 `tool-output-boundaries.test.ts` 继续通过，Registry/Finalizer 未引入 security policy 依赖。违反 secret policy 的 draft/save 在写盘或连接前失败。

### AC-04: HTTP/STDIO lifecycle and cancellation are deterministic

- 真实本地 HTTP 与 STDIO fixture 分别证明 connect、分页 tools/list、call、disable、test、reconnect、配置变化和 shutdown；STDIO 结束后无遗留子进程。
- connect/discovery/call 各自在精确 deadline 失败，Execution abort 会传到 transport。测试证明旧 `Promise.race` 后台继续完成路径不存在。
- 发出前取消产生普通 abort；live read-only abort/timeout 精确返回 `TOOL_MCP_CALL_ABORTED`/`TOOL_MCP_CALL_TIMEOUT`，不自动重放原 call，但允许仍在运行的模型显式发起新 call。Startup interrupted MCP read call 返回 `TOOL_MCP_INTERRUPTED`，不自动恢复。只有 effectful 调用在发出后无法证明未执行时返回一次 finalized `unknownResult=true`；Tool Batch scheduler 原子保存 result、`effectful_cancelled_unknown` 和 `manual_inspection_required`，同一 tool call 不被自动重放或二次 finalization。
- 响应先于取消、取消先于响应和迟到响应三类竞态各有确定性测试；迟到完成不改变已结算 Tool Batch，日志中不泄漏输入、secret 或未最终化输出。
- annotations 缺失使用保守 traits；explicit read-only 可并发，其余串行。所有 MCP 工具无用户确认、无 permission suspension，同时仍经过 finalizer、artifact、audit 和 redaction。

### AC-05: MCP tools and Settings are operationally complete

- 合法最长/超长/点号工具名产生稳定、唯一、<=64 字符 alias；原始 server/tool identity 在 UI、audit 和 error 中保留。冲突使用 hash 解歧，不跳过合法工具。
- Settings 可创建/edit HTTP 和 STDIO、自定义 secret、启停用户服务器、关闭/恢复内置服务器，并显示 `disabled|connecting|ready|failed`、tool count、原始工具 inventory、脱敏错误和时间。
- Test 对未保存 draft 使用与 Save 相同的 schema/secret/env 解析，成功或失败都不写 Config、不改变当前工具，临时连接只关闭一次；Reconnect 成功后立即更新当前连接和工具，已开始调用按 in-flight 规则排空。重复点击在 pending 时被拒绝或合并，不创建重复连接。
- 390px 与 1440px、light/dark、键盘操作和 screen reader 状态通过真实浏览器验收；console error 为 0，旧 restart-required 文案不存在。

### AC-06: Skill discovery and diagnostics are exact

- 五级来源 precedence 逐级有测试；winner 资源从不跨来源合并。Reserved lifecycle builtin 不可 shadow。
- 一个损坏普通 Skill 产生脱敏 diagnostic、从 available catalog 隔离且不阻止 Session；同名低来源不 fallback。显式、delegated active 或 lifecycle Skill 损坏时 Execution 在模型调用前失败。
- Inventory/picker 显示 winner/source/valid/invalid/shadowed 和脱敏诊断；Config、API、UI 和生产类型中不存在 Skill enable/disable 状态或项目覆盖层。
- Composer picker 和诊断面在 390px/1440px、键盘、焦点、screen reader、light/dark 下通过真实浏览器验收；invalid/shadowed/prompt-omitted 状态不只依赖颜色表达。

### AC-07: explicit Skill activation and context budget are deterministic

- `/skill use <name> <request>` 在 command 完成的同一 durable mutation 中写入 pending input overlay；崩溃后重启、相同 `clientRequestId` 重放和 queue claim 均只产生一条消息与一次激活。冲突的一次性 Skill pending 被确定性拒绝。
- Queue claim 原子持久化 `executionSkillNames`、winning source tier 与 whole-package digest，并在首个模型调用前注入该 Execution 的完整 winning entry/resource inventory。暂停/resume 使用同一 snapshot；重启时 source/digest 都相同才重建，不同则在模型调用前得到 `SKILL_PACKAGE_CHANGED`。模型 wire 中没有要求先调用 `skill_read` 的 continuation message，也没有多一次激活 tool round-trip。
- Claim 后把 resource 替换为相同 byte length 的不同内容，`skill_read({name})` 仍返回 snapshot entry/inventory，`skill_read({name,resource})` 仍返回 snapshot bytes；重启后同样修改则 digest mismatch 并 fail closed。高优先级 winner 被同内容的低优先级 package 取代也因 source tier 改变而 fail closed；Entry、资源路径、byte length 或任一内容变化都改变 digest，resource body 不被预注入 Prompt。
- 显式 Skill 只影响当前逻辑 Execution，terminal 后释放；Session 持久 `activeSkillNames`、delegated Skills 和 lifecycle Skills 语义保持不变。Composer picker 与文本命令提交同一个 command/receipt/claim path。
- Prompt projection 的固定 renderer、160-byte description cap、Unicode code-point 截断、omitted footer 和总 byte count 有 golden tests；7,999/8,000/8,001 bytes 及中英文/emoji 边界均证明输出 `<=8,000`。System Prompt、Prompt trace 和 Prompt UI 预览使用同一 `includedEntries/omittedCount/byteLength`，Active Skill 正文不被该预算截断。
- `skill_list` 的 50-entry/24-KiB cursor pages 能遍历完整 valid catalog；cursor 绑定 digest，catalog 变化后旧 cursor 确定失败。Inventory API 的 50-record/64-KiB pages 和 Composer picker 能遍历 Prompt omitted Skill 及全部 invalid/shadowed diagnostics。
- Skill 仍不能改变 allowed tools、MCP 工具、Profile、delegation target、workspace 或 completion authority；architecture tests 覆盖该不变量。

### AC-08: hard cut, verification and review are complete

- 生产代码中不存在旧 `McpManager` 一次性 discovery 注册、`createMcpDestructivePermission`、旧 `mcpTools`/用户 MCP 角色过滤、旧 Skill activation continuation、旧 Config shape reader 或被替换模块的 fallback。
- 新增抽象只限 `McpRuntimeService`、per-server transport adapter、Agent/query 的 run-local descriptor map、ToolRegistry 的 MCP 无关 `executeResolved` 入口和现有 `SkillService` 扩展；不存在 per-Execution MCP 工具副本、通用 Plugin Manager、动态 Registry framework、第二 Tool pipeline 或第二 Skill state machine。Architecture tests 禁止 Registry 导入 MCP、Config 或 Agent policy，并证明静态 lookup 与 `executeResolved` 汇入同一内部管线。
- Focused tests、Agent Core unit/integration/architecture lanes、Server/Web tests、`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 独立 Reviewer 按 AC-01 至 AC-08 给出文件、测试、命令和浏览器证据；不得用“测试通过”代替逐条验收，未执行项目不得标为完成。
