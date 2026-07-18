# Tool Description Contract Progress

## Status

`DONE`

## 2026-07-17

- 以 `tool-description-contract-plan-goal.md` 的 AC-01 至 AC-06 为唯一完成标准；执行过程只记录在本文件，不回写 Goal 文档。
- 当前工作区起点只有未跟踪的 plan-goal 文档，没有既有产品代码改动；Engineer definition 的 30 个 base tools、MCP/worktree/extraTools 动态增量边界保持不变。
- 已并行启动三条只读审计：本地/执行工具契约、多 Agent/Memory/Goal/Automation/Skill 契约，以及 `file_read`/token 计量实现边界。审计必须同时核对竞品固定证据与 ArchCode runtime，禁止凭描述长度扩写。
- 已锁定 token 只做修改前后和竞品同口径报告，不设数值上限，不参与 `DONE/NOT_DONE`；Core、插件和 MCP surface 分列。
- 本地执行工具审计完成：确认除 `file_read` 外均只需修改模型可见文案；`file_edit.edits` 实际全部匹配同一份 pre-edit 文件，`web_fetch` 的 5MB 下载上限是硬拒绝而 `maxLength` 才是返回内容截断，实施按 runtime 写实。
- `file_read`/计量审计完成：分页应先在原始字节上定位行区间再施加 50KB；计量应走真实 registry、Engineer definition、`toAITools()` 与 AI SDK schema 转换。
- 生命周期审计确认 `background_output` runtime 可按同项目 Session id 读取 unrelated/grandchild，不能声称只接受 direct child。后续 Reviewer 又用 Store 行为测试确认 terminal reminder 会按 `sessionId` 去重，因此 `wait_for_reminder` 的 `{ count: N }` 应表达为 N 个 distinct Sessions，而不是同一 Session 的 N 条 reminder；本 Goal 不扩张 runtime，文案按完整执行链写实。
- 20 个目标工具的 description/schema 字段说明已按竞品证据和本地 runtime 实施；未修改 Engineer tool surface、registry/provider 转换链、permission/guard/hook 或 Agent 架构。
- `file_read` 已硬切为“先按字节定位 offset/limit 行范围，再施加 50KB 窗口”，旧的固定首 50KB 路径已删除；补充高 offset、选择范围截断、>10MB 硬拒绝、高 offset snapshot 与 UTF-8 边界回归测试，定向测试 17/17 通过。
- 新增 Bun 原生计量命令 `bun run tool-contract:measure`，真实经过 builtin 注册、Engineer definition、`resolveForAgent().toAITools()` 和 AI SDK schema 转换；固定 `js-tiktoken@1.0.21/o200k_base`。
- 已用 Python `tiktoken==0.12.0/o200k_base` 对最终同一 wire 交叉校验，结果同为 8,070，证明 Bun 计量实现没有改变既定 tokenizer 口径。
- 从 `HEAD` 导出的干净基线以同一脚本公式复算为 30 tools / 6,284 full wire / 102 names / 929 descriptions / 4,866 parameters / 452 skeleton；最终为 30 / 8,070 / 102 / 2,101 / 5,480 / 452。Full wire 增加 1,786（28.42%），其中 description 增加 1,172（126.16%）、parameters 增加 614（12.62%），names/skeleton 不变；不设通过上限。
- 重新本机捕获 OMO-CAP 得到相同 49 tools / 17,384 full-wire tokens；独立序列化分组为 OpenCode base 10 tools / 6,505，OMO plugin 18 / 4,450，MCP 与 MCP resource helpers 21 / 6,433。分组 token 因数组边界不能相加等于 full。CLI 明确提示 `sisyphus` 名称不存在并回退 default agent，因此不把该数据误称为已验证的 Sisyphus 专属 surface。
- 本地工具定向测试 187/187、生命周期工具定向测试 89/89 通过；生命周期单元 `agent-core` typecheck 通过。

## 2026-07-17 — Prompt ownership follow-up

- 将共享 `Delegation Protocol` 收敛为 `Delegation Policy`：System 只保留直接执行/委派判断、证据与权限边界、并行所有权和父 Agent 验收责任；删除 task/context 填写手册、`background` 参数说明以及 `resume_session`、`wait_for_reminder`、`background_output` 操作链。
- 生命周期操作链没有删除：`delegate`、`resume_session`、`wait_for_reminder` 与 `background_output` 的 description/schema 继续分别拥有新建、恢复、终态通知和最终交付物读取语义；模型可见契约测试明确断言 `wait_for_reminder -> background_output(block=true)` 仍然存在。
- Engineer role 删除与 Delegate description、共享父验收政策重复的 Agent 目录和结果复核文案；Engineer 与 Goal Lead 的并行 Build 政策不再泄漏 `background=true` 参数写法，由 Delegate 工具契约负责具体调用方法。
- Tools System section 只新增一条跨工具策略：已知且独立的非交互查询应在同一 model turn 发出，由 runtime 并行 concurrency-safe calls、串行其余 calls；交互和 mutation 不批量。避免过小 `file_read` 切片属于单工具操作知识，按 ownership review 移入 `file_read` description。
- 统一 `js-tiktoken@1.0.21/o200k_base` 固定上下文复算：Delegation section `801 -> 571`，Engineer role `561 -> 496`，Tools section `136 -> 182`。固定静态 Engineer System（Identity + Role + Execution + Delegation + Tools + Compression + 固定 Environment，不含动态 Skills/Memory/Project）`2,300 -> 2,050`，净减少 250 tokens。
- Engineer 30-tool wire 因 `file_read` 新增一条 OpenCode 直接证据支持的调用效率说明，从 `8,070 -> 8,085`；descriptions `2,101 -> 2,116`，parameters、names 与 skeleton 不变。System ownership 重构未把删除内容重复塞回工具数组。
- Claude 证据拆成捕获 A 与捕获 B：A 的 28 个非 MCP tools 只能称为 capture-specific subset；B 为另一份 30-tool 动态 surface，不能再把 `/private/tmp/claude-request-v2.json` 与 A 的 37-tool/Pencil 统计混为同一捕获。
- 验证完成：Prompt/Tool Contract 定向测试 51/51、`bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码 0。最终 diff review 未发现生命周期调用链丢失、虚假能力、Tool surface/registry/provider/permission 变更或跨角色实现权限扩张。

### Token comparison (`o200k_base`)

| Surface | Tools | Full wire | Notes |
| --- | ---: | ---: | --- |
| ArchCode before | 30 | 6,284 | names 102; descriptions 929; parameters 4,866; skeleton 452 |
| ArchCode after Tool Contract V2 | 30 | 8,070 | names 102; descriptions 2,101; parameters 5,480; skeleton 452 |
| ArchCode current after ownership follow-up | 30 | 8,085 | names 102; descriptions 2,116; parameters 5,480; skeleton 452 |
| ArchCode after Delegate Skill/file_write follow-up | 30 | 8,135 | names 102; descriptions 2,126; parameters 5,520; skeleton 452 |
| ArchCode current after Codex/OpenCode follow-up | 30 | 8,334 | names 102; descriptions 2,278; parameters 5,567; skeleton 452 |
| ArchCode current after source-backed manuals/examples and review fixes | 30 | 10,711 | names 102; descriptions 4,344; parameters 5,878; skeleton 452 |
| Claude Code capture A non-MCP subset | 28 | 17,797 | capture-specific subset, not a fixed core catalog |
| Claude Code capture A Pencil MCP | 9 | 2,399 | full 37-tool surface is 20,194; independent arrays do not add exactly |
| Claude Code capture B | 30 | 21,213 | separate dynamic surface without Pencil MCP; descriptions 14,775, schemas 6,111 |
| OMO-CAP OpenCode base | 10 | 6,505 | exact captured subset |
| OMO-CAP plugin | 18 | 4,450 | exact captured subset |
| OMO-CAP MCP/resources | 21 | 6,433 | exact captured subset; full 49-tool surface is 17,384 |
| Codex local plugin surface | 23 top-level declarations | 32,853 | plugin/namespace-heavy full capture; not presented as Codex core |

## Verification

- 首轮 Reviewer 复现 50KB 截断切断多字节 UTF-8 的缺陷；已直接修复为 UTF-8 边界安全截断并新增回归测试。
- 最终 model-visible contract + `file_read` 定向测试 38/38 通过；`bun run typecheck`、`bun run test`（8/8 Turbo tasks）、`bun run build`、`git diff --check` 均在 UTF-8 修复和最终契约断言补齐后通过。
- 独立 `gpt-5.6-sol/xhigh` Reviewer 完整核验 AC-01 至 AC-06，经历 UTF-8 边界、必见事实断言及 provenance 行号修复循环后给出最终 `DONE`，无剩余阻塞项。

## 2026-07-17 — Delegate Skill recovery and file_write follow-up

- `delegate` 在目标 Agent 拒绝 Skill 时返回 `target_agent`、`rejected_skill`、精确 `allowed_skills` 和重试提示；授权仍由原 AgentDefinition allow-list 唯一决定。
- `delegate.skills` 的模型可见字段说明同步声明错误恢复路径，不把各目标的动态列表复制进 System Prompt。
- `file_write` 明确自动创建缺失父目录、要求完整文本、绝不覆盖已有文件，以及已有文件使用 `file_edit`；执行逻辑未改变。
- Engineer surface 仍为 30 tools；`o200k_base` full wire `8,085 -> 8,135`，其中 descriptions `2,116 -> 2,126`、parameters `5,480 -> 5,520`，names `102`、skeleton `452` 不变。
- 独立 `gpt-5.6-sol/xhigh` Reviewer 首轮要求补强授权来源和普通错误隔离证据；修复后 68/68 相关测试与 `agent-core` typecheck、`git diff --check` 通过，Reviewer 复审给出 `DONE`。此前根 `typecheck`、全量 `test`（8/8 Turbo tasks）和 `build` 均已通过。

## 2026-07-18 — Current Codex/OpenCode contract follow-up

- 复核 Codex `03cef23` 与 OpenCode `518b0bf` 当前源码后，按用户确认补充 `delegate` fresh-context、三个 LSP 前提、`web_fetch` 响应头/重定向共享 30 秒 deadline 和 `todo_write` 及时/阻塞状态规则。
- `background_output` 与 `wait_for_reminder` 的默认值和最大等待值均改为 `1,800,000ms`（30 分钟）；`wait_for_reminder` 保留 `1,000ms` 下限，并为 `{ count: N }` 增加字段级说明。
- Engineer surface 和 Agent/registry/provider/permission 架构未改变；`o200k_base` full wire `8,135 -> 8,334`（+199，+2.45%），其中 descriptions `2,126 -> 2,278`、parameters `5,520 -> 5,567`，names `102`、skeleton `452` 不变。Python `tiktoken==0.12.0` 对同一 wire 交叉校验同为 `8,334`。
- 113/113 相关测试、`bun run typecheck`、`bun run test`（8/8 Turbo tasks）、`bun run build` 与 `git diff --check` 全部通过。
- 独立 `gpt-5.6-sol/xhigh` Reviewer 首轮指出 `web_fetch` timeout 文案过度承诺、`wait_for_reminder.count` 缺少 Store 去重行为证据和 provenance 不完整；修复并重跑全量门禁后，第二轮复审给出 `DONE`。

## 2026-07-18 — OpenCode/OMO manuals and examples follow-up

- 重新按当前源码核验 OpenCode `45cd8d7` 与 oh-my-openagent `0023507`，排除 MCP/Pencil/用户插件并按最终 tool name 去重：OpenCode 默认 11–13 个，OMO 默认 13 个 definitions 中 4 个覆盖同名 OpenCode 工具、净增 9 个，合并默认 20–23 个；默认关闭的 task system 开启后约 24–27 个。ArchCode 30-tool surface 并不少，差距来源改判为 description/schema 内容密度。
- OpenCode 当前源码中 `task` 2,305 chars、`todowrite` 2,012、`edit` 1,369、`shell` 1,269、`read` 1,158；其主要增量是 when/when-not、调用示例、失败恢复和跨工具工作流，不是更多默认工具。
- 已把对应内容放入 Tool 自己的 description/schema，而不是 System Prompt：覆盖 file discovery/read/edit、Bash/Git、Todo、ask_user、delegate/resume/background、Skill 与 LSP 选择链；没有复制 OpenCode 独有的 `replaceAll`、PDF/图片读取、持久 shell 或 OMO 的 `bg_...` ID 语义。
- Engineer base surface、Agent definitions、System Prompt、registry/provider/permission/guard/hook 均未改变。相对上一版，30-tool wire `8,334 -> 10,711`（+2,377，+28.52%）；descriptions `2,278 -> 4,344`（+2,066，+90.69%），parameters `5,567 -> 5,878`（+311，+5.59%），names 102、skeleton 452 不变。Python `tiktoken==0.12.0` 对最终同一 wire 交叉校验同为 10,711；不设 token 上限。
- 独立 Reviewer 首轮给出 `NOT_DONE`：`todo_write` 示例要求复用模型不可见的生成 id、OpenCode 计数错误地按 GPT/非 GPT 分桶、LSP workflow 未说明 1-based `column` 到 0-based `character` 的换算。已改为首次调用显式稳定 Todo id、按 patch-eligible/edit-write 分桶，并明确 `character=column-1`；最终 `toAITools()` contract test 增加对应断言。
- 修复后 model-visible contract 27/27、`agent-core` typecheck、token 交叉校验、根目录 `bun run test`（8/8 Turbo tasks）、`bun run build` 与 `git diff --check` 全部退出码为 0。独立 `gpt-5.6-sol/xhigh` Reviewer 第二轮复核三个 finding 与 AC-01 至 AC-07 后给出 `DONE`，无剩余阻塞项。
