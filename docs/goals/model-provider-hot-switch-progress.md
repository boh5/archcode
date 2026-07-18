# Model Provider 与 Execution 热切换 Progress

> Goal 契约：`docs/goals/model-provider-hot-switch-plan-goal.md`
> 执行分支：`codex/model-provider-hot-switch`
> Worktree：`~/.codex/worktrees/73ab/archcode`（从 `main@ca5ffaf` 创建）

## 当前状态

- 阶段：完成
- Goal：complete
- Reviewer：独立 `gpt-5.6-sol(max)` 最终结论 `DONE`；无剩余阻断项

## 验收进度

| AC | 状态 | 证据 |
| --- | --- | --- |
| AC-01 Provider catalog | pass | 24 项 literal adapter/direct deps 测试；最终编译二进制在无 `node_modules` cwd 启动 24 Provider 并取得 health 200 |
| AC-02 Provider options/secrets | pass | catalog/config/server-config-service 定向测试覆盖 JSON-safe 透传、字段拒绝、secret preserve/replace/delete/redact |
| AC-03 原子热应用 | pass | `ServerConfigService` prepare → atomic write → publish；失败不改磁盘/revision、mixed section 与旧/新 binding 测试通过 |
| AC-04 Execution 模型所有权 | pass | binding 显式贯穿 QueryLoop/compact/background/command；架构测试禁止 Agent/cache 持有可执行模型及 LLM 入口漏传 |
| AC-05 Session/消息选择 | pass | strict `modelSelection`、GET/PATCH CAS、请求 fingerprint、config-invalidated 重解析及浏览器首次发送前默认值通过 |
| AC-06 Queue/Steer | pass | FIFO 最大连续前缀、X/Y/X、Steer conflict、HITL 新 Execution 测试；真实浏览器验证两条 Beta 只产生一次 Beta Execution |
| AC-07 两层 UI | pass | Settings/Composer/气泡/footer/Inspector 交互测试；桌面与 390px 浏览器验收，console 0 error |
| AC-08 彻底硬切 | pass | 旧 Session schema、旧 restart boolean、Agent 固定模型、OpenAI-only/`.chatModel()`、双读写与兼容 fallback 均已删除 |
| AC-09 验证闭环 | pass | 最新 `typecheck` 5/5、`test` 8/8、`build`、`git diff --check`、二进制与真实浏览器均通过；独立 Reviewer `DONE` |

## 执行记录

### 2026-07-18

- 重新核对 Goal 文档、Git/worktree 和当前未提交状态；保留无关的 `agent-prompt-architecture-v2-plan-goal.md`。
- 从 `main@ca5ffaf` 创建独立 worktree `~/.codex/worktrees/73ab/archcode`，分支为 `codex/model-provider-hot-switch`；主工作区保持在 `main`。
- 纠正了最初仅切分支、随后缺少 Codex `<4位标识>/archcode` 两级目录的错误；Goal 文档已移入正确 worktree，主工作区只保留原有无关文件。
- 并行启动三条只读勘察：Provider/config、Execution/session、Web/UI。
- 已锁定第一性原则：模型绑定只在 Execution 边界解析；配置更新只发布一个新的不可变 runtime snapshot；运行中的 Execution 不受影响；未启动选择失效时使用当前 Session/Agent 默认值，不保留历史 Provider。
- 三路勘察完成：确认 5 类生产 LLM 入口、Queue 当前全量 claim、HITL continuation 已是新 Execution、首次 `Unknown model` 的真实根因及 Web/Settings 完整改造面。
- 完成 protocol/core 模型基础：`ModelRuntimeSnapshot`、`ModelSelectionResolver`、immutable `ExecutionModelBinding` 与安全 catalog；11 个定向测试、Protocol/Agent Core typecheck 通过。
- 完成独立 Web 基础：section-aware Settings modal 与受控 `ModelPicker`（搜索、Provider 分组、Variant、Agent default、Running/Next、窄屏）；40 个定向测试和 Web typecheck 通过，尚未接 ChatInput/API。
- Provider catalog 安装时发现初选 package major 中混有 ProviderV1/V2，已停止错误 cast 路线，正在逐项改锁真实 ProviderV3 版本。
- Provider/config 基础已落地：24 项 literal adapter catalog、通用 JSON-safe options、集中 secret metadata、ProviderV3 `languageModel()` 路径和兼容版本直接依赖；71 个定向测试通过。
- 配置热应用服务已落地：候选 snapshot 先 prepare，随后原子写盘并同步 publish；配置响应改为 `modelRuntimeRevision` 与 `restartRequiredSections`，旧 OpenAI-only gate 和旧 `restartRequired` 已删除；61 个定向测试通过。
- Agent 模型所有权已硬切：`ConfiguredAgent`、factory、cache 不再持有 Provider/Model，所有 QueryLoop、command、compact、title/memory hook 改为显式接收 immutable binding；320 个定向测试通过。
- 当前全仓 typecheck 的失败集中在正在改造的 strict Session/protocol fixtures（缺少 required binding/model selection），没有在旧 DTO 上增加 fallback；该切片完成后再做纵向 runtime/API 接线。
- Session/protocol strict hard cut 已落地：Session `modelSelection` required，`execution-start`/execution record required binding，pending/receipt required requested selection，canonical user message required per-message audit；旧 Session 无迁移路径。
- Session input durable boundary 已改为 resolved snapshots + binding：Queue 精确前缀、direct、Steer commit 都在同一 durable mutation 中提交消息 audit 与 execution binding；请求 fingerprint 已包含 Model/Variant/mode。
- Settings Web 硬切完成：Provider form 完全由后端 adapter catalog 驱动，递归 secret draft、Advanced JSON、package selector、live-applied 与分 section restart 状态已实现；旧 restart boolean/banner 和前端 Provider 常量已删除。两批共 46 个定向测试通过。
- 后端新增 secret-free `/api/config/provider-adapters` 与 `/api/config/model-runtime`，ModelRuntime publish 具备 revision subscription；Web 全局 SSE 将 `model_runtime.changed` 映射为 catalog query invalidation，并在重连时主动刷新。
- Session API 已接入完整 `nextModelSelection`、active binding 与 model-selection GET/PATCH；消息 POST 已硬切为 required requested selection。
- 完成 Session API/runtime/Web 纵向接线：新 Session 在首次消息前返回完整 Agent default，override 可 PATCH/CAS 并跨刷新持久化；running binding 与 next selection 分离。
- 完成最终全量验证：`bun run typecheck` 5/5、`bun run test` 8/8、`bun run build` 与 `git diff --check` 均通过；Agent Core 架构 lane 为 108 pass / 0 fail。
- 编译后二进制最终 smoke：隔离 HOME、无 `node_modules` 临时 cwd、24 个 Provider 配置全部构建并逐项取得 `languageModel` 后，`/api/health` 返回 200。
- 使用真实浏览器完成桌面与 390px 验收：首次发送前显示 `Alpha · deep · Agent default`；运行中显示 `Running with Alpha` / `Next Beta`；连续两条 Beta Queue 消息合并为一次 Beta Execution，逐消息 requested/actual 与 Assistant actual 均正确，console 0 error。
- 真实浏览器发现并修复 Composer 向上 Popover 被 `overflow-hidden` 裁剪的问题，同时补回归测试；另修复 Settings 成功后再次失败仍残留绿色成功提示的问题。
- 独立终审补强 Provider 安全边界：所有声明 secret path 支持保留/替换/删除与值级脱敏；流式跨 chunk、text/reasoning/tool input、后台 LLM、terminal record 和真实 HTTP 错误回显都不会把 Provider secret 写入 Store/SSE/result/log。
- 独立终审补强配置与状态一致性：Provider URL 禁止 userinfo/query/hash；`queryParams` 只允许 OpenAI-compatible；运行时 snapshot 防御性 clone/freeze；过期 REST snapshot 不得回滚 SSE cursor/model 状态，PATCH 409 后强制同步权威状态。
- Reviewer 按 AC-02 发现同一 Provider/MCP secret 原值若被复制到非 secret 字段会被 GET 回显；已在 resolved candidate 写盘前全局拒绝这种值复用，覆盖 Advanced、Provider/Model display 与 MCP header，并验证失败不写盘、不 publish。未采用会破坏 DTO 形状的 GET 全局替换。
- Reviewer 发现 Assistant Inspector 会借用同 Execution 首条 User audit；已彻底移除该 fallback。现在 User 只显示自身请求，Assistant 显示实际 binding 和该批 Execution 的全部关联 User 请求；新增 X-invalid + Y-invalid → Z 交互测试。
- 终审修复后再次完成全仓 `test` 8/8、生产 `build`、`git diff --check`，并从无 `node_modules` cwd 启动含 24 Provider 的最终编译二进制，`/api/health` 返回 200；测试服务已停止。
- 独立 `gpt-5.6-sol(max)` 逐项复核 AC-01～AC-09、修复项与最终 gates 后给出 `DONE`，无剩余阻断项。

## 发现与更正

- Provider 官方主线已进入 ProviderV4；本 Goal 必须锁定与 `ai@6.0.174` / `@ai-sdk/provider@3.0.10` 兼容的 24 个 ProviderV3 版本，不能使用漂移版本范围。
- `provider.name` 当前被 OpenAI-compatible SDK 当作 namespace；按已确认产品语义硬切为纯显示名，factory namespace 统一使用 Provider ID，不保留 name-keyed translation。
- 当前 `SessionExecutionOrigin` 与模型解析来源是两个概念；保留前者，新增 binding `resolution`，避免含义耦合。
- `/compact` 使用命令提交时携带的 selection，并将 selection 纳入 command fingerprint；Goal/Automation 继续复用统一 Session/Execution 路径，不新增专用 LLM 抽象。
- Composer 改的是 Session 的 next selection，因此消息模式收敛为 `agent_default/session_override`；不增加绕过 Session 状态的一次性 explicit 模式。
- Advanced options 只允许 JSON-safe 值；未知非敏感字段保留并传给 factory，未知 secret-bearing key 或 callback/非 JSON 值明确拒绝，避免“既透传又无法脱敏”的矛盾。
