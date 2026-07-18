# Model Provider 与 Execution 热切换 Plan Goal

> 状态：产品边界已锁定。本文是实施契约，不是候选方案集合。

## Objective

保持现有 `~/.archcode/config.json` 结构不变，支持 ArchCode 当前 AI SDK 6 版本的官方语言模型 Provider 及 OpenAI-compatible 自定义端点；将 Provider/Model/Agent 配置保存改为运行时原子生效，并允许用户在 Composer 为当前 Session 选择下一次 Execution 的模型。一次 Execution 启动后 ArchCode 的 binding 固定，ArchCode runtime 不能中途切换或在调用失败后自动改投另一 binding。

同时修复首次发送前 Composer 已能从 Agent 默认配置得知模型、却显示 `Unknown model` 的问题。

## 已锁定的产品与架构结论

### 1. 配置结构不改

磁盘配置继续且只使用：

```text
provider.<id>.{npm,name,options,models}
agents.<agentName>.{model,variant,options}
```

- 不新增 `connections`、`profiles`、Session 配置文件或另一套模型配置源。
- `provider:<modelId>` 仍是唯一 qualified model id；`provider/model` 不合法。
- 现有 OpenAI-compatible 磁盘层级无需迁移；只把 `provider.options` 从 OpenAI-only 固定字段语义扩展为对应 Provider factory 的 JSON options。`provider.name` 曾被 SDK 当作 namespace 的行为直接硬切：新实现始终使用 Provider ID，且不保留 name-keyed compatibility translation。
- Model call options 合并顺序不变：Model options → Variant → Agent options；Session 只选择 Model/Variant，不复制 options。

### 2. Provider 支持边界固定

初始静态 catalog 必须恰好覆盖当前 AI SDK 6 官方、具备语言模型能力的这些包：

```text
@ai-sdk/gateway              @ai-sdk/xai                 @ai-sdk/vercel
@ai-sdk/openai               @ai-sdk/azure               @ai-sdk/anthropic
@ai-sdk/open-responses       @ai-sdk/amazon-bedrock      @ai-sdk/groq
@ai-sdk/deepinfra            @ai-sdk/google              @ai-sdk/google-vertex
@ai-sdk/mistral              @ai-sdk/togetherai          @ai-sdk/cohere
@ai-sdk/fireworks            @ai-sdk/deepseek            @ai-sdk/moonshotai
@ai-sdk/alibaba              @ai-sdk/cerebras            @ai-sdk/perplexity
@ai-sdk/baseten              @ai-sdk/huggingface         @ai-sdk/openai-compatible
```

- `@ai-sdk/openai-compatible` 负责任意 Chat Completions-compatible 自定义/本地端点；`@ai-sdk/open-responses` 负责对应的 Responses-compatible 端点。
- 不承诺任意 community npm package，不运行时安装 npm 包，也不设计 ArchCode 自有 Provider 插件协议。
- 24 个包都是 `agent-core` 直接生产依赖，并锁定到与 `ai@6.0.174`、`@ai-sdk/provider@3.0.10` 的 ProviderV3 兼容版本；不得使用会自动漂移到 ProviderV4 的范围。Bun 单文件编译无法可靠打包变量 `import(packageName)`；catalog 使用逐项 literal dynamic import，并与 AI SDK 版本一起升级。
- 统一从 AI SDK `ProviderV3.languageModel(modelId)` 取得模型；删除 OpenAI-compatible 专用 `.chatModel()` 主路径。
- Provider `name` 只用于显示；Provider ID 才是运行时命名空间和 OpenAI-compatible provider key。
- AI Gateway、OpenRouter-compatible 网关或自定义端点可能按用户显式配置在其服务内部路由或 fallback；这是选定 Provider 的黑盒行为。ArchCode 只审计并保证自己的 `gateway:modelId` binding 不变，不虚构实际落到的上游 Provider，也不自动注入 Gateway `order/models`。

研究依据：[AI SDK Provider 架构](https://ai-sdk.dev/docs/foundations/providers-and-models)、[AI SDK 6 Provider 列表](https://ai-sdk.dev/providers/ai-sdk-providers)、[ProviderV3 specification](https://github.com/vercel/ai/blob/main/packages/provider/src/provider/v3/provider-v3.ts)、[OpenCode Provider 配置](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/providers.mdx) 与 [OpenCode Provider runtime](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts)。竞品证明了“稳定配置形状 + Provider adapter + 会话模型选择”的产品形态；ArchCode 不复制其动态安装、模型目录或 runtime fallback 链。

### 3. 模型归 Execution，不归 Agent 实例

```text
Settings PUT
  -> ServerConfigService 校验并构建候选 ModelRuntimeSnapshot
  -> 原子写 config.json
  -> 同步发布 snapshot 指针

Session selection / accepted message selection
  -> ModelSelectionResolver（读取当前 snapshot）
  -> immutable ExecutionModelBinding
  -> ConfiguredAgent.run(binding)
```

- `ProviderAdapterCatalog` 只拥有 package → literal loader/factory、显示信息、常用 factory option 字段及 secret paths。
- `ModelRuntime` 只拥有当前不可变 snapshot：config revision、Provider registry、Models、Variants 和八个 Agent 默认选择；发布是一次同步指针替换，不建设 generation manager 或历史仓库。它同时输出不含 options/secrets 的 Web catalog（Provider display、Model、Variant、Agent defaults、revision），Composer 不读取整份 Settings DTO。
- `ModelSelectionResolver` 是默认选择、Session override、Variant 与 call options 合并的唯一所有者。
- `SessionExecutionManager` 在 claim 时解析一次 binding，并把它写入 `execution-start`；重试、工具循环、Todo continuation、同一 Execution 内的 cwd transition 及后台 hooks 全部复用该对象。
- `ConfiguredAgent` 只保留角色、工具、Skill、Store 和 prompt 生命周期；彻底删除构造期 `modelInfo/modelOptions/providerRegistry` 所有权。模型相关 command 也必须在 command 启动时取得一次 binding。

### 4. Session、Queue、Steer 与 HITL 语义

- Session 持久化一个可选 `{ model, variant? }` override；没有 override 就始终跟随该 Agent 当前默认值。
- Composer 发送请求必须携带当时显示的明确 Model/Variant 及选择模式；服务端接受消息时把请求的 Model/Variant 和原始模式写入 `PendingSessionMessage`，并纳入 `clientRequestId` fingerprint。普通正文 Edit 不改变该请求选择。
- Queue 启动只消费 FIFO 中“解析后 Model/Variant 相同”的最大连续前缀，不重排：`X, X, Y` 分成 `X+X`、`Y` 两个 Execution；`X, Y, X` 分成三个。
- queued message 的请求选择在当前 snapshot 仍有效时必须使用；若启动前已因配置变更失效，dispatcher 直接重新解析该 Session 当前 override，override 也无效或不存在时使用当前 Agent 默认值。配置保存必须保证八个 Agent 默认值全部合法，所以此路径不阻塞、不要求重选，也不保留旧 Provider/runtime。
- Steer 仅在 queued message 的解析后 Model/Variant 与 active binding 相同时可用；不同时 UI 禁用，服务端仍必须返回确定的 conflict。
- active Execution 使用 A 时选择 B，只改变 `next`；不 abort、不重建 Agent，也不改变 A。
- 一次 Execution 进入 `waiting_for_human` 后已经结束。批准后的 Tool Batch continuation 是新 Execution，按该 Session 当时的选择重新解析；原选择已删除或 Variant 已失效时，使用该 Agent 当前默认值。
- “无效请求/override → 当前 Session 选择 → Agent 默认值”只发生在新 Execution claim 前。每条 committed canonical user message 持久化自己的 requested Model/Variant、原始模式、actual Model/Variant 与可选 `config_invalidated` 原因；Execution binding summary 只记录该批次统一的实际 binding。既有 `executionOrigin` 继续表示 `user_message/tool_call/tool_batch/goal_claim`，模型解析来源单独使用 `resolution`，不得复用同一字段。Provider 调用开始后 ArchCode 不得改投其他 binding。
- child Session 独立解析自身 Agent 默认值或自身 override；root 的选择不向 descendants 传播。
- Execution binding 的 `resolution` 只描述 `requested/session_override/agent_default`，不承载单条消息的 requested selection；既有 `executionOrigin` 独立描述 Execution 来源。消息模式只有 `agent_default/session_override`，不设计绕过 Session 状态的一次性 explicit 模式。相同实际 Model/Variant 可以合批，不因各消息的 requested selection 或原始模式不同而拆 Execution。

## 实施计划

1. **Provider catalog 与配置领域硬切**
   - 增加单一 `ProviderAdapterCatalog`，为上述 24 个包提供 literal loader、factory adapter、option 字段和 secret path metadata；Web 通过后端 catalog DTO 获取选项，不复制 package 清单。
   - 将 Provider schema/Settings DTO 改为通用 JSON options，同时由 catalog 做 package、字段和敏感值处理；保留现有磁盘层级及 Model/Variant/Agent schema。
   - 把 provider-specific secret 的 redact/preserve/replace/delete 集中到配置领域，Advanced options 不得重新暴露已脱敏字段。
   - 凭据只允许放在 `provider.<id>.options` 的 catalog-declared secret paths 或 headers/queryParams；未知但 JSON-safe、非敏感的 Advanced 字段原样保留并传给 factory，未知 secret-bearing key 与 callback/非 JSON 值字段级拒绝。Model/Variant/Agent `providerOptions` 是公开 call options，递归出现 `byok`、api key、token、password、secret、credential、private key、authorization 等 secret-bearing key 时保存失败。Gateway BYOK 不在本 Goal 支持范围。

2. **原子 ModelRuntime snapshot**
   - 从完整候选配置离线构建不可变 snapshot；任何 adapter 加载、Provider 创建、Model/Variant/Agent 引用校验失败都不得写盘或发布。
   - 成功路径固定为“计算 revision并构建候选 → 原子写盘 → 同步 pointer swap → 返回 applied revision”。旧 Execution 持有旧 binding，自然完成后释放。
   - Provider/Models/Agents 的 Settings 保存立即生效。配置响应硬切为 `modelRuntimeRevision` + `restartRequiredSections: ("mcp" | "memory" | "integrations.github")[]`；删除旧单一 `restartRequired`。一次 mixed save 必须同时准确表达模型已应用和哪些非模型 section 仍需重启。

3. **Execution binding 纵向重构**
   - 新增内部 `ExecutionModelBinding`（ModelInfo、合并后 options、Model/Variant、config revision）和不含 secrets、只描述实际 binding 的 protocol summary；`execution origin` 继续由 Execution record 独立持有，requested/actual/reason 是逐消息审计字段，不塞进单值 Execution 字段。
   - 把 Agent factory、ConfiguredAgent、QueryLoop、compact、title/memory hooks、Goal/Automation/child/resume 等所有 LLM 入口统一改为显式 binding；资源标题等无 Session 调用在启动时解析对应 Agent 默认值。
   - `execution-start` 与 `SessionExecutionRecord` 持久化 binding summary；Assistant message 已有 `executionId`，直接关联实际 binding。

4. **Session selection 与 Queue 契约**
   - 用 `modelSelection` + 派生的 `active/next` projection 替换含义模糊的 Session `modelInfo`；增加 Session selection GET/PATCH 契约，选择 `Agent default` 会删除 override。
   - 增加 ModelRuntime safe catalog DTO，作为 Composer 配置模型列表与 Agent default 的唯一来源；revision 变化通过现有全局控制面通知 Web 失效查询。
   - Message admission 持久化请求选择；Queue dispatcher 在 claim 前按统一规则解析，以实际同选择连续前缀分组，并在同一个 durable commit 中为每条 canonical user message 写入各自的 requested/actual/reason；Steer 同时校验 expected execution 与模型一致性。
   - HITL continuation、Goal continuation、resume 均在各自新 Execution 边界重新解析。`/compact` 使用命令提交请求携带的 selection，且 command receipt fingerprint 包含 selection；不存在旧 binding/config revision 的持久化仓库。

5. **两层 UI**
   - Settings 的 Models 管理“可用 Provider/Model”，Agents 管理八个 Agent 默认值；Provider package 改为 catalog selector，表单显示 provider-specific 常用字段和 Advanced options JSON。
   - Composer 左下角模型文字改为按钮；Popover 向上展开，支持搜索、按 Provider 分组、Model/Variant 选择、`Agent default` 与 `Manage models…`。
   - 首次发送前必须显示例如 `GLM-5 · deep · Agent default`。运行中 A、next 为 B 时按钮显示 `Next: B`，Popover 同时显示 `Running with A` 与 `Next B`。
   - queued/committed 用户气泡显示该消息请求的 Model/Variant；如果配置变更使其失效，则显示将采用/已采用的实际选择及原因但不阻塞。Assistant footer 显示该 Execution 实际 Model/Variant；Context Inspector 组合当前消息的逐消息审计与 Execution 的 Provider、Variant、origin、revision。

6. **旧契约清理与验证**
   - 删除 OpenAI-only constant/error/validation、`.chatModel()` runtime path、startup-only model snapshot 测试、Agent 固定模型字段、Session `modelInfo`、旧 `restartRequired` boolean/banner 及所有旧 DTO/alias。
   - Session 持久化 schema 直接硬切，不迁移旧 Session 文件，不保留双读/双写；磁盘 `config.json` 形状是本 Goal 唯一明确保留的兼容面。
   - 更新 README/配置示例，明确 Provider catalog 范围、手工编辑配置不触发 watcher、Session/Execution 选择语义和无自动模型 fallback。

## 验收标准

以下 AC-01 至 AC-09 必须全部有测试、浏览器或审计证据；任一缺失即为 `NOT_DONE`。

### AC-01：配置与 Provider catalog

- 当前仓库的 OpenAI-compatible 配置原样通过新 schema 并启动；磁盘 JSON 仍只有既有层级，不出现 `connections/profiles` 或迁移产物。
- catalog 恰好包含上文 24 个 package；lockfile 中每个直接依赖版本都与 AI SDK 6 / ProviderV3 兼容，每项能通过 literal loader 创建 `ProviderV3` 并调用 `languageModel(testModelId)`，Unsupported package 在写盘前返回字段级错误。
- 生产代码不存在变量动态 import、运行时 npm install、community package fallback、OpenAI-only provider gate 或 `.chatModel()` Provider 主路径。
- 在不含 `node_modules` 的临时 cwd，以无网络 fixture 驱动编译后二进制实际加载 24 个 adapter 并逐项调用 `languageModel(testModelId)`，同时取得 `/api/health = 200`；只检查 health、未触发 loader 或任一 adapter 未嵌入都算失败。

### AC-02：Provider options 与 secrets

- `baseURL` 不再被所有 Provider 强制要求；每个 catalog entry 的常用字段、Advanced JSON 和 factory input 有 round-trip 测试。未知 JSON-safe 非敏感字段必须原样保留并进入 factory；未知 secret-bearing key、callback 或非 JSON 值必须字段级拒绝，任何字段都不得被 UI/DTO 静默删除。
- 每个 catalog-declared secret path，以及 headers/queryParams 的值，GET/SSE/log/UI 均不出现明文；preserve、replace、delete 各有测试，保存失败不改变原 secret。
- Model/Variant/Agent `providerOptions` 递归出现 `byok`、api key、token、password、secret、credential、private key、authorization 等 secret-bearing key 时必须在写盘前返回字段级错误；凭据只允许进入 Provider options 的受控 secret paths，Gateway BYOK 明确不在本 Goal 范围。
- `provider.name` 改名只影响显示；Provider ID 和 `providerOptions` namespace 不随 display name 漂移。

### AC-03：配置原子热应用

- 候选 adapter、schema、Model/Variant/Agent 引用任一失败时，磁盘文件逐字节不变、runtime revision 不变、当前和下一 Execution 均不受影响。
- 成功响应必须返回 `modelRuntimeRevision` 和精确的 `restartRequiredSections`；前者同时等于磁盘 revision 与 `ModelRuntime.current.revision`。只改 Provider/Models/Agents 时后者为空且 UI 显示已实时应用。
- 同一次 PUT 同时修改 Models 和 MCP/memory/GitHub 时，Models 立即按返回 revision 生效，UI 仅对 `restartRequiredSections` 点名的非模型 section 显示待重启；不得用一个总 `restartRequired` 抹平两种状态。
- A 运行时保存配置并切换默认值：A 的所有后续 model calls 仍使用其旧 binding；保存后启动的 B 使用新 revision。不存在半旧半新的单次 Execution。
- 直接在外部编辑 `config.json` 不承诺热应用；重启读取新文件，Settings PUT 才是本 Goal 的 live-apply 入口。

### AC-04：Execution 模型所有权

- `ConfiguredAgent`、Agent cache/factory 和 Session Store 不再持有可执行模型；每个 LLM run/command 都必须显式收到一次解析的 binding。
- 同一 Execution 的首轮、tool-result 后续轮、重试、Todo continuation、cwd transition、compact/title/memory hooks 使用完全相同的 ModelInfo/options/revision；调用失败只按现有同 binding retry/recovery，ArchCode 不切换 binding。Gateway/自定义端点内部按用户配置发生的路由对 ArchCode 是不可见 Provider 行为，不得被审计成 ArchCode fallback。
- child、resume、Goal/Automation 与资源标题各自在新执行边界解析其 Agent 默认值或 Session override；root override 不影响 child。
- HITL 前 Execution 可记录 A；批准后 continuation 在当时选择为 B 时必须记录并实际调用 B，不保存或查找 A 的历史 Provider 配置。

### AC-05：Session 默认值与消息锁定

- 新 Session 尚无消息、Agent 尚未创建时，Session API 已返回完整 `next` 选择；Composer 显示 Model、Variant 和 `Agent default`，不得出现 `Unknown model`/空白。
- Session override 跨刷新和 server restart 保持；选择 `Agent default` 后 override 从持久化状态删除，并跟随以后 Agent 默认配置变化。
- 新 Execution claim 时，请求选择有效则原样使用；失效则解析当前 Session override，仍无效或不存在时使用当前 Agent 合法默认值。该解析不得阻塞 Queue；每条 committed canonical user message 必须记录 requested Model/Variant、原始模式、actual Model/Variant 与可选 `config_invalidated`，Execution summary 只记录实际 binding，且不得影响已运行的 Execution。
- POST message 的服务端 receipt/fingerprint 包含 Model/Variant；同一 `clientRequestId` 改正文或模型重试必须冲突，网络重试不得重复消息或改变原选择。

### AC-06：Queue 与 Steer

- A 运行，B/C 为 X、D 为 Y：A 成功后一个 Execution 消费 B+C 并使用 X，D 保持 queued；随后一个 Execution 使用 Y。`X,Y,X` 必须产生三个有序 Execution，不能重排或混用。
- Queue claim、messages committed 与带 binding 的 execution-start 仍是一个 durable 边界；崩溃恢复不得让消息丢失、重复或换到错误 binding。
- queued 请求选择在配置变更后失效时，无需人工处理：按 AC-05 得到实际 binding 后参与连续前缀分组；两个 requested Model/Variant 或原始模式不同、但实际 binding 相同的连续消息必须合批，并保留完整逐消息审计。
- `X-invalid, Y-invalid → Z-default` 必须产生一个使用 Z 的 Execution；两条 committed user message 分别保留 X/Y 的 requested 值、各自模式、Z 的 actual 值和 `config_invalidated`，历史 UI/Context Inspector 不得只显示首条请求。
- queued message 的 Edit 保留选择；Steer 仅在其 Model/Variant 与 active binding 相同且原有 execution/revision CAS 通过时成功，否则 UI 不提供可用按钮且服务端返回确定 conflict。
- waiting_for_human 期间的新消息仍留在 Queue；先运行采用当前 Session 选择的新 Tool Batch continuation，再按上述 Queue 规则 dispatch。

### AC-07：UI 两层职责与可见状态

- Settings 能从后端 catalog 添加任一受支持 Provider，package 不再只读；Models/Variants 和八个 Agent 默认值可保存并立即进入下一 Execution。
- Composer 只读取不含 Provider options/secrets 的 ModelRuntime catalog DTO；revision 更新后通过全局控制面失效并取得新 Provider/Model/Variant/default，不得读取或缓存整份 Settings DTO。
- Composer picker 具备搜索、Provider 分组、Variant、Agent default、Manage models；idle、running A/next B、queued、HITL continuation 各状态均与服务端 projection 一致，刷新不闪回旧值。
- queued/committed 用户气泡、Assistant footer 和 Context Inspector 分别显示逐消息请求/实际选择、Execution 实际选择和两者组成的完整 audit；配置使请求失效时 UI 非阻塞地显示改用当前/default 的原因。历史 Assistant 永远按自己的 executionId 显示，不能被当前 next 选择覆盖。
- 桌面与 390px 窄屏完成首次发送前、idle 切换、running A→next B、mixed-model Queue、Settings 成功/失败保存验收；无截断关键操作、无重复气泡、控制台 0 error。

### AC-08：彻底硬切

- 不存在旧 `modelInfo` Session 字段/DTO、Agent 构造期模型、startup-only Provider snapshot、旧 `restartRequired` boolean/banner、Models/Agents restart-required 文案、旧 API alias、feature flag、双读/双写、迁移器或旧 Provider 兼容 fallback。
- 旧 Session 文件按新 strict schema 失败，不自动补字段、猜模型或迁移；实施 QA 前使用隔离 HOME/项目状态。
- 配置兼容仅指本文锁定的 `config.json` 结构与现有 OpenAI-compatible 配置；不能借“硬切”更改该结构。

### AC-09：验证闭环

- Provider catalog/config、secret rejection、snapshot publish、mixed-section save、binding resolver、Session selection、配置失效重解析、不同请求合批的逐消息审计、Queue grouping、Steer conflict、HITL continuation、protocol reducer 和 UI interaction 均有定向测试。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；编译后二进制与真实浏览器验收按 AC-01/AC-07 完成。
- Reviewer 必须逐项给出 AC-01 至 AC-09 的证据，并搜索所有旧模型所有权、OpenAI-only、restart-only、fallback/compatibility 残留；仅报告测试通过不能判定 `DONE`。
