# Tool Search 可见性投影执行记录

## 基本信息

- Plan Goal：`docs/goals/tool-search-projection-hard-cut-plan-goal.md`
- 分支：`codex/tool-search-projection-hard-cut`
- 基线：`544aeaed`
- 状态：完成；AC-01 至 AC-08 全部验收通过

## 已锁定执行边界

- 只改变模型工具可见性；不建立第二 Registry、权限链或 MCP 执行链。
- 硬切 `tools.tools`，不保留旧 reader、fallback、feature flag、deprecated alias 或墓碑测试。
- 进度、偏差、验证和 review 只记录在本文件，不回写 Plan Goal。

## 执行记录

### 2026-08-26：启动

- 从 `main@544aeaed` 创建并切换到 `codex/tool-search-projection-hard-cut`。
- 开始并行核查授权/可见性、Execution 持久恢复和本地检索/MCP 投影三个实现面。

### 2026-08-26：第一性原理纠偏

- 保留 Discussion 现有 context-locked overlay：`extraTools` 不得为其授予 Definition 外能力。
- 修复既有 depth 漏洞：`extraTools` 不得在 max depth 重新加入已被移除的 delegation control tools。
- MCP namespace v1 只使用现有 server id；不为 Tool Search 扩大 Config/API/UI 去新增 display name。
- State facts 由异步 collector 组合现有服务后交给纯 Projection：child 状态组合 Agent Tree 与 parent `childSessionLinks`，PDF 只读取当前可投影 attachment metadata，不扫描历史全部附件。
- 保留 `runModelAttempt` 的第二次 Goal context materialize；它只补充 compact 后的 idempotent notice，不改变授权/State facts，因此不重复构建 catalog。增加顺序测试锁定这一点。
- Prompt lint 的“required capability 必须本轮可见”与 deferred tools 冲突；改为在 AgentDefinition 层校验角色基础能力，在每轮 Prompt 只校验 visible tools 不越权、forbidden tools 不可见及 delegate target 一致性。
- 冷恢复不扩成通用框架：只在 active Batch 的所有非终态调用均为 `tool_search` 时恢复同一 Execution，其余保持现有 interrupted/manual-inspection 语义。
- MCP runtime snapshot 硬切为单一 `tools` map；每项同时携带 run-local descriptor、server namespace 和 builtin/user 来源，避免 Catalog 另建一份易漂移的 namespace 缓存。
- State Activation 的 Agent Tree 查询改为按需：直接 child link 已足够证明 direct child 正在运行时，不再无条件获取稳定家族快照；只有直接子均已终态、需要确认更深层非终态后代时才读取 Tree。完整集成测试曾由此发现父子并行模型边界可能互等，修复后未引入缓存、fallback 或第二套状态来源。

### 2026-08-27：独立 Review 与修复循环

- 第一轮独立 Review 发现六个实质问题：隐藏 `tool_search` 缺 digest 会在权限拒绝前抛错；authorization semantic validation 太晚；Recall fixture 自证；Token 计量未走生产组合与 provider wire；Output State 误读整个 root family；MCP 测试 seam namespace 错误。全部按生产边界修复，没有增加第二合并器或兼容路径。
- 隐藏/伪造的 `tool_search` 现在无需 digest 即可落盘，并由 Registry 正常结算 `TOOL_NOT_ALLOWED`；只有本轮确实可见的搜索调用才强制真实 catalog digest。
- 新 Execution 的 authorization snapshot 在 claim、消息和 execution-start 持久化前，经 `SessionExecutionManager -> ConfiguredAgent.resolveLiveAuthorizedToolCatalog` 唯一语义验证路径检查；同一逻辑 Execution 恢复只读 durable snapshot。
- Output artifact ownership 硬切加入 `executionId`，State Activation 只查询当前 Execution。artifact/tombstone metadata 同步升到 v2；旧 v1 在启动清理中删除，无迁移和兼容 reader，并已写入 breaking note。
- Recall 评测删除 `evalDescription`，改用真实 builtin descriptors、真实角色授权和完整 no-state deferred 集合；补齐两个 MCP namespace、相似名称、长 description、enum、非 ready 和越角色矩阵负例。
- `tool-contract:measure` 改为实例化 `ConfiguredAgent`，复用唯一 live Authorized Catalog，再走 production Projection、`ResolvedToolSet.toAITools()` 和 provider JSON schema 校验；MCP 增量由真实有/无 MCP 投影对比得出，不是赋值断言。
- 第二轮前的安全审查发现 search query 可能携带非 Provider 配置 secret。现统一在 QueryLoop stream/finalized call、Scheduler durable batch 和 descriptor direct execution 三层使用现有 secret detector；持久化只保留固定安全 marker，返回稳定 `TOOL_SEARCH_SENSITIVE_QUERY`，原文不进入 Store、Batch、audit 或 logger，其他工具不套用此专用规则。
- 最终复审补出两个证据边界：Registry 的 disallowed 结算曾重新写回原始 call input；measurement 的 delegated 角色 store 虽正确，但 runtime depth 仍固定为 0。前者改为用 prepared safe input 结算并由真实 Registry audit 测试锁定；后者明确 Lead/Discussion depth=0、其余 delegated 角色 depth=1，并同时传入 `ConfiguredAgent` 与 capability snapshot。
- Catalog、search tie-break、namespace summary 和 loaded refs 排序改为 code-point 比较，不再依赖宿主 ICU locale。
- 固定 corpus 已作为独立先行提交 `fd5d2476 test(tool-search): lock retrieval corpus`；实现留在后续提交，满足 fixture-first review 顺序。

## 验证记录

- Catalog/Search/Projection focused tests：8 passed，固定 corpus `Recall@5 = 100%`。
- `bun run tool-search:benchmark`：1,000 entries / 100 queries / 20 warmup / 10 runs，最终 p50 74.19 ms、p95 81.47 ms，低于 1 秒门槛。
- `bun run tool-contract:measure`：Lead initial 14 tools / 5,092 tokens，相对 11,845 基线下降 57.01%；默认 MCP 只增加 deferred count，initial token 增量为 0。
- MCP runtime snapshot focused tests：21 passed。
- `tool_search` descriptor focused tests：5 passed。
- 最终安全边界 focused suite：Registry、Tool Batch、`tool_search` descriptor 与 QueryLoop 合计 144 passed；覆盖 prepared input audit、result + loaded refs 原子提交、持久失败时双回滚、Sidecar 不进入事件和非 search 工具不受专用 secret 规则影响。
- Agent Core architecture lane：83 passed；补齐当前 `tool_search` output policy 和 `authorized/core` 定义契约的架构矩阵，不保留旧 `tools.tools` 形状断言。
- 首次全量验证暴露两组应当由硬切发现的旧假设：Web fixture 缺 required snapshot/refs；Runtime/Integration 模拟模型仍直接调用 deferred 工具。已把 fixture 改为严格新 shape，并把确需长尾工具的模拟调用改为 `tool_search -> 下一模型边界调用命中工具`；没有增加兼容默认值、放宽行为断言或加长 timeout。
- Artifact v2 focused suite：38 passed。
- Agent Core integration lane：145 passed；architecture lane：83 passed；Protocol：150 passed。
- 最新 `bun run test`：8/8 workspace tasks passed。
- 最新 `bun run typecheck`：5/5 workspace tasks passed（由 `bun run build` 再次执行）。
- `bun run build`：typecheck、Web production build、308-asset production entrypoint 生成均通过。
- `git diff --check 544aeaed`：通过；生产与当前架构文档无旧 `.tools.tools`、eager MCP append reader 或兼容 alias。

## 独立 Review

- Reviewer：独立 `gpt-5.6-sol` / `xhigh` 子 Agent。
- 第一轮：0 P0；发现的 P1/P2 已进入上述 fix 循环。
- 第二轮：按 AC-01 至 AC-08 逐项复核源码、测试、命令和测量证据；最终 **0 P0 / 0 P1 / 0 P2，全部 PASS**。
- Reviewer 保留的可接受风险只有三类：第三方 MCP 描述质量可能要求模型改写 query；v1 Execution/artifact 数据按本 Goal 的 hard cut 拒绝或清理；深层 descendant 状态查询在超时下 bounded fail-closed。三者都不会扩大授权或触发 eager/load-all fallback。
