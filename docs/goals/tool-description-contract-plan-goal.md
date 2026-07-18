# Tool Description Contract 改进计划

## Objective

在不改变 Engineer 30 个 base tools、Agent 架构、权限链和 provider 转换链的前提下，基于 Claude Code、OpenAI Codex、OpenCode/OMO 与 Grok Build 的真实工具契约，把工具选择、调用前提、参数边界、正反例、失败恢复、跨工具工作流及多 Agent 生命周期明确写入 ArchCode 模型可见的 description/schema；同时修复 `file_read` 高 `offset` 无法读取首个 50KB 之后内容的问题。

本 Goal 验收“契约事实已进入首轮模型可见定义且与 runtime 一致”；工具选择率或参数成功率提升是预期收益，不在本轮虚构效果阈值。

## Locked Scope

- `engineerAgentDefinition.tools.tools` 的 30 个 base tools 名称与数量保持不变。现有 MCP、Session worktree 和 `extraTools` 的叠加行为保持不变，并在 token 统计中作为额外 surface 单列。
- 保持 `defineTool -> ResolvedToolSet.toAITools() -> AI SDK -> provider`、traits、permission、guard、hook 与执行器架构不变。
- 只修改事实与当前 runtime 一致的 description 和字段 `.describe()`；不把竞品独有能力写进 ArchCode。
- 执行行为修改只包括：直接修正 `file_read` 分页及其矛盾错误提示；让 `delegate` 在目标 Agent 拒绝 Skill 时返回其既有 allow-list 和恢复提示；以及按用户确认将 `background_output`、`wait_for_reminder` 的默认值和最大等待值统一为 30 分钟。这些修改都不改变权限或能力边界。
- 不引入 Tool Contract compiler、新 manager、动态 surface、provider 分支、feature flag、旧行为 fallback 或兼容路径。

## Evidence Baseline

固定证据源：

- `CC-160-A`：Claude Code 2.1.160 的一次真实首轮请求，包含 28 个非 MCP tools 与 9 个 Pencil MCP tools；捕获命令、tool extracts 与结论持久保存在 `/Users/bo/.codex/sessions/2026/07/17/rollout-2026-07-17T12-11-21-019f6e45-95a5-7b73-8715-dc4315e27ed5.jsonl`。该捕获只代表当次动态 surface，不定义固定 Claude Code core catalog。
- `CC-B`：另一份本地 Claude Code 首轮请求 `/private/tmp/claude-request-v2.json`，SHA-256 `1ae3f10f22a7b1ff8c0c4f309b5837a1ba6799d14015348c5cf496f895cb4910`；包含 30 个 tools，未包含 Pencil MCP，并出现 `Workflow`、`Monitor` 等与捕获 A 不同的动态工具。它用于证明 Claude Code surface 会随运行环境变化，不与 `CC-160-A` 混算。
- `OC`：[OpenCode tool prompts @ `3a1c6df`](https://github.com/anomalyco/opencode/tree/3a1c6df9e24672f0761a6ced18e1315d89334baf/packages/opencode/src/tool)。
- `OMO-D`：[delegate contract @ `5ef852a`](https://github.com/code-yeongyu/oh-my-openagent/blob/5ef852a32c2c433386eb009bd92ca7c07359d0e6/packages/omo-opencode/src/tools/delegate-task/tool-description.ts)；`OMO-B`：[background contract](https://github.com/code-yeongyu/oh-my-openagent/tree/5ef852a32c2c433386eb009bd92ca7c07359d0e6/packages/omo-opencode/src/tools/background-task)；`OMO-A`：[ast-grep contract](https://github.com/code-yeongyu/oh-my-openagent/blob/5ef852a32c2c433386eb009bd92ca7c07359d0e6/packages/shared-skills/skills/ast-grep/SKILL.md)；`OMO-L`：[LSP verification boundary](https://github.com/code-yeongyu/oh-my-openagent/blob/5ef852a32c2c433386eb009bd92ca7c07359d0e6/packages/prompts-core/prompts/ultrawork/default.md)。
- `OMO-CAP`：OpenCode 1.17.16 + oh-my-opencode 3.17.4，在用户当时配置下传入 `--agent sisyphus`，但 CLI 明确提示该名称不存在并回退到 default agent；模型请求重定向到本机捕获端点后得到 49-tool 首轮 payload。捕获命令、统计与序列化结果持久保存在 `/Users/bo/.codex/sessions/2026/07/17/rollout-2026-07-17T12-11-21-019f6e45-95a5-7b73-8715-dc4315e27ed5.jsonl`。该动态 catalog 的 OpenCode base、OMO/plugin 与 MCP 增量必须分开报告，不把它误标成已验证的 Sisyphus 专属 surface。
- `CX-MA`：[Codex multi-agent specs @ `3151954`](https://github.com/openai/codex/blob/315195492c80fdade38e917c18f9584efd599304/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)；`CX-LOCAL`：Codex CLI 0.142.3 `codex debug prompt-input` 的本机首轮捕获，保存在 rollout `019f6e45-95a5-7b73-8715-dc4315e27ed5`。
- `GB`：[Grok Build tools @ `8adf901`](https://github.com/xai-org/grok-build/tree/8adf9013a0929e5c7f1d4e849492d2387837a28d/crates/codegen/xai-grok-tools/src/implementations)。
- `GEMINI3`：[Gemini CLI model-family tool definitions @ `3ff5ba2`](https://github.com/google-gemini/gemini-cli/blob/3ff5ba20fc1ad7d867218bbdb34756eb54d6eccb/packages/core/src/tools/definitions/model-family-sets/gemini-3.ts)。
- `OC-CURRENT`：[OpenCode 1.18.3 registry/contracts @ `45cd8d7`](https://github.com/anomalyco/opencode/tree/45cd8d76920839e4a7b6b931c4e26b52e1495636/packages/opencode/src/tool)；`OMO-CURRENT`：[oh-my-openagent registry/contracts @ `0023507`](https://github.com/code-yeongyu/oh-my-openagent/tree/00235071f5c8fae520cf42ed2ca1430bdfca1e80/packages/omo-opencode/src)；`CX-CURRENT`：[Codex tool specs @ `03cef23`](https://github.com/openai/codex/tree/03cef233f11e8ef29fd17ce1ffeb8fc644aaf7de/codex-rs/core/src/tools/handlers)。

源码去重口径（排除 MCP、Pencil、用户自定义插件）：OpenCode 默认 CLI surface 中，满足当前 `apply_patch` 选择条件的模型为 11–12 个，其余使用 `edit` + `write` 的模型为 12–13 个；差异来自 model edit/patch 选择与 websearch gate，不能笼统按 GPT/非 GPT 分类。OMO 默认注册 13 个 core definitions，其中 `grep/glob/task/skill` 覆盖同名 OpenCode 工具，因此只新增 9 个 unique names，`interactive_bash` 仅在 tmux 可用时再增 1。两者默认合并为 20–23 个 unique tools；启用默认关闭的 4-tool task system 后约 24–27 个。ArchCode 的 30 个 base tools 并不少，首轮 tool token 差距不能再归因于默认工具数量。

| ArchCode tool | 竞品同类工具 / 证据 | 证据支持的新增内容 |
| --- | --- | --- |
| `file_read` | CC-160-A `Read`；OC `read`；GB `read_file` | 行号、分页、截断/上限和大文件策略 |
| `file_write` | CC-B `Write`；OC `write`；GEMINI3 `write_file` | 完整内容、创建父目录、不覆盖及与 edit 的边界 |
| `file_edit` | CC-160-A `Edit`；OC `edit`；GB `search_replace` | 先读、精确缩进、去行号、唯一匹配和失败恢复 |
| `grep` | CC-160-A/OC/GB `Grep/grep` | regex、内容/文件名边界、输出模式和结果上限 |
| `git_status` / `git_diff` | OC-CURRENT `shell` Git workflow | dirty-state、staged/unstaged、untracked 文件与完整审查链 |
| `bash` | CC-160-A `Bash`；OC-CURRENT `shell`；GB `bash` | shell 状态、timeout、专用工具边界、Git 授权与失败恢复 |
| `todo_write` | CC-160-A `TaskCreate/TaskUpdate`；OC/OC-CURRENT `todowrite` | when/when-not、完整列表、及时更新与阻塞状态规则 |
| `ask_user` | CC-160-A `AskUserQuestion`；OC `question` | 只问用户决策、先调查、推荐项在前 |
| `delegate` | CC-160-A `Agent`；OC/OC-CURRENT `task`；OMO-D；CX-MA/CX-CURRENT `spawn_agent` | Agent 用途、fresh context、独立任务、不重复、同步/后台语义 |
| `background_output` | CC-160-A `TaskOutput`；OMO-B；GB `task_output`；CX-CURRENT `wait_agent` | status、blocking、30 分钟 timeout、通知后取结果和完整 Session 过滤 |
| `wait_for_reminder` | OMO-B；CX-MA/CX-CURRENT `wait_agent` | wait 只消费通知、不返回交付物、禁止轮询、count 与 30 分钟 timeout 边界 |
| `memory_read` | GB `memory_search/memory_get` | 历史决策、偏好、陌生模块和 compact 后的使用时机 |
| `goal_create` | CX-LOCAL `create_goal` | 只响应明确 Goal 意图，不从普通长任务推断 |
| `automation_create` | CC-160-A `CronCreate`；CX-LOCAL Automation tool | 仅定时/重复/提醒/监控意图，区分触发与 action |
| `skill_list` | CC-160-A/OC/OMO-CURRENT `Skill/skill` | System 已列清单；只在需要机器可读刷新时 list，不猜名称 |
| `skill_read` | CC-160-A/OC/OMO-CURRENT `Skill/skill` | exact name、任务匹配时先读取、Skill 不扩大能力 |
| `glob` | CC-160-A/OC `Glob/glob` | 文件名搜索，与内容 grep 分工 |
| `ast_grep_search` | OMO-A | AST shape/regex 边界、`$VAR/$$$`、可解析 pattern |
| `ast_grep_replace` | OMO-A | preview -> review -> apply 两阶段 |
| `lsp_diagnostics` | OMO-L | diagnostics 的 severity 与不能替代测试/运行 |
| `lsp_goto_definition` / `lsp_find_references` / `lsp_symbols` | OC-CURRENT `lsp` | 需要 language mapping/可用 LSP server，缺失时返回错误 |
| `web_fetch` | CC-160-A/OC/OC-CURRENT `WebFetch/webfetch` | 专用/认证工具优先、响应头与重定向共享 30 秒 deadline、响应可能转换或截断 |
| `resume_session` | CC-160-A `Agent` continuation；OMO-D `task_id`；CX-MA `resume_agent` | continuation 必须复用原 child context |

实现时不得因竞品描述更长就复制内容。每条新增事实必须同时标注上表 evidence id，并由 ArchCode 当前源码或回归测试证明 runtime 确实如此；竞品独有能力不得移植成虚假承诺。

## Contract Changes

### 重点补强

| Tool | 完成后模型必须看见的事实 |
| --- | --- |
| `file_read` | 路径基准、`N: content` 行号格式、`offset/limit` 语义、50KB 单次输出上限、10MB 文件上限、大文件先定位再分段读取 |
| `file_edit` | 必须先读；`oldString` 不含行号前缀且保留精确缩进；默认唯一匹配；无匹配时重读，多匹配时扩大上下文；整组 edits 原子执行 |
| `grep` | regex 内容搜索；文件名搜索用 `glob`；优先于 Bash `rg/grep`；三种 `output_mode`；最多 100 条结果 |
| `bash` | 每次是非持久 shell；cwd/env 不跨调用；stdin 关闭；`timeoutMs` 为毫秒且省略时无 wrapper timeout；专用工具优先；正常或非零退出完成时返回 stdout/stderr/exit code，timeout/abort/signal 使用各自真实结果，不承诺统一三元组 |
| `todo_write` | 适用与不适用场景；输入是完整替换列表；保留已有 id；最多一个 `in_progress`；完成并验证后才能标 `completed` |
| `ask_user` | 只询问真正属于用户且会改变执行方向的决策；可从请求、代码或合理默认得到的答案不询问；推荐项放首位 |
| `delegate` | 五类可委派 Agent 的用途；只委派具体、独立、有明确交付物的任务；父 Agent 不重复工作；同步与后台返回语义 |
| `background_output` | 返回 child 状态与结果；`block=false` 默认；通常在完成提醒后调用；timeout 单位；full-session 过滤参数 |
| `wait_for_reminder` | 只等待并消费 terminal reminder，不返回最终交付物；不得轮询；成功后用 blocking `background_output` 取结果 |
| `memory_read` | 用于历史工作、既有决策、用户偏好、陌生模块和 compact 后缺失的上下文；只描述现有 `name` 选择语义，不虚构 `scope` 或语义搜索 |
| `goal_create` | 只在 Goal-create Skill 完成明确确认后调用；普通长任务不自动创建 Goal；只允许未绑定 root Engineer |
| `automation_create` | 只在用户明确要求定时、重复、提醒或监控且完成确认后调用；区分 trigger、timezone 与 action；立即任务不创建 Automation |
| `skill_list` | 只负责发现当前 Agent 可用 Skill；不得猜测名称；选定后读取正文 |
| `skill_read` | 名称必须来自允许列表；匹配任务时在执行前读取；Skill 不扩大工具、权限、目标 Agent 或 workspace 范围 |

### 小幅补强

- `file_write`：明确创建缺失父目录、必须提供完整内容、绝不覆盖已有文件，已有文件使用 `file_edit`。
- `glob`：明确“按文件名搜索、内容用 grep”和 100 条结果上限。
- `git_status` / `git_diff`：明确 status -> unstaged diff -> staged diff、untracked 内容需另读，以及 Git Skill 路由。
- `ast_grep_search`：明确 AST shape 与文本 regex 的边界、`$VAR/$$$`、pattern 必须是合法代码节点。
- `ast_grep_replace`：明确先 `dryRun:true` 审查匹配，再以相同 pattern/rewrite 应用。
- `lsp_diagnostics`：明确返回 error/warning/information/hint，不能替代测试或真实运行。
- `lsp_goto_definition`、`lsp_find_references`、`lsp_symbols`：明确 language mapping/LSP server 前提及缺失时的错误边界。
- `web_fetch`：明确有专用 MCP 时优先使用、不继承浏览器登录态、响应头与重定向共享 30 秒 deadline（body 读取不受该 timer 约束），以及大响应可能被转换或截断。
- `resume_session`：明确复用 direct child 的持久上下文，不得用新 `delegate` 代替 continuation。

### 保持不变

`cancel_session`、`view_tool_output`、`compress`、`memory_write`。没有直接竞品证据或当前契约已等价，不为追求统一格式而扩写。

### 明确禁止的错误承诺

ArchCode 当前不具备或语义不同，因此文案不得声称支持：`file_read` PDF/图片/notebook、`file_edit.replaceAll`、Bash 后台任务、持久 shell cwd/env、浏览器登录态、任意外部路径无审批访问。

## Plan

1. 按 evidence matrix 更新现有 tool descriptors 和字段 `.describe()`；每条新增事实保留 evidence id 与 ArchCode runtime 对照，禁止无来源扩写。
2. 直接修正 `file_read` 的分页顺序，使 50KB 源文本窗口作用于所选行区间而非文件固定前缀；同时纠正 >10MB 错误恢复提示，保留二进制检测、权限与 read-snapshot hook。
3. 让 `delegate` 的 Skill 拒绝结果返回目标 Agent 的精确 `allowed_skills` 与重试提示，并明确新 child 不继承父 conversation history；不改变 Skill 授权来源或委派能力。
4. 将 `background_output` 与 `wait_for_reminder` 的默认值和最大等待值统一为 30 分钟，并同步 schema、模型可见说明和边界测试。
5. 增加 model-visible contract tests：通过实际 `ResolvedToolSet.toAITools()` 断言关键事实进入 AI SDK tool spec，而不是只匹配源码字符串。
6. 新增 `file_read` >50KB 高 offset、50KB 截断和 >10MB 拒绝/提示回归测试；不得声称已有并不存在的超大文件测试。
7. 增加 dev-only、非 runtime 的 wire 导出与 token 计量脚本；固定 OpenAI-compatible 序列化及 tokenizer 后，复算修改前后 30 个 base tools，并按同一口径对比已捕获的 Claude Code、Codex 和 OMO 工具定义。
8. 依据 OC-CURRENT/OMO-CURRENT，把 `file_read/file_edit/bash/todo_write/delegate/background/skill/Git/LSP` 的 when/when-not、一次正确调用示例、恢复动作与跨工具链放回各自 Tool Contract；不把操作手册塞回 System Prompt。
9. 完成 typecheck、test、build、diff 检查和逐项验收。

## Acceptance Criteria

以下 AC-01 至 AC-07 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：架构与 Tool surface 未改变

- `engineerAgentDefinition.tools.tools` 经 `resolveForAgent(...).toAITools()` 后仍恰好包含原有 30 个 base tools，名称集合完全一致。
- MCP、Session worktree 与 `extraTools` 的现有合并行为无改动；30 个 base tools 与这些动态增量使用分开的 token 统计口径。
- Agent definitions、ToolRegistry/AI SDK 转换、权限/guard/hook 所有权没有新增第二套路径。
- 不存在动态加载、provider 特判、新 Tool Contract abstraction、feature flag、旧 description fallback 或兼容 alias。

### AC-02：26 个目标工具的事实完整可见

- “重点补强”与“小幅补强”的 26 个工具逐项满足对应事实；每项新增事实可追溯到 evidence matrix 的竞品 id 和一个 ArchCode source/test id。
- 测试从 `ResolvedToolSet.toAITools()` 读取 description/schema 并断言这些事实，证明它们确实对模型可见。
- 4 个“保持不变”工具的 description 与 schema 文案无无关改写。

### AC-03：文案与真实能力一致

- 不出现“明确禁止的错误承诺”中的任何能力表述。
- Schema validation shape、字段名称和 required/optional 语义保持不变；除 `file_read` 执行与错误恢复、`delegate` 的 Skill 拒绝错误详情，以及用户确认的两个后台等待默认值/最大值改为 30 分钟外，本 Goal 只允许修改 description/字段说明和对应测试/计量脚本。
- `delegate` 的拒绝结果只回显目标 Agent 已有的 Skill allow-list；不得扩大、合并或另建 Skill 授权来源。
- permission/guard/hook 仍是强制边界；description 只预告真实行为，不把提示词描述成安全保证。

### AC-04：`file_read` 真正支持后续分页

- 对超过 50KB 的文本文件，使用落在首个 50KB 之后的 `offset` 能返回对应真实行，行号正确。
- `limit` 仍限制最大行数；每次所选源文本窗口仍受 50KB byte 上限约束并给出 truncation 提示（行号格式化后的字符数不冒充原始 byte 上限）。
- 二进制文件仍拒绝展示，超过 10MB 的文件仍返回 `TOOL_FILE_TOO_LARGE`，权限与 read snapshot 行为不退化。
- >10MB 的 description 与错误结果均明确为硬拒绝，不再建议用 `offset/limit` 绕过上限。
- 旧的“固定截取文件前 50KB 再应用 offset”实现被直接删除，不保留 fallback。

### AC-05：Token 变化透明可比较

- 计量对象固定为 definition 顺序下 30 个 base tools 的 minified UTF-8 JSON 数组，合法 wire 形状为 `[{"type":"function","function":{"name":"file_read","description":"...","parameters":{}}}]`；`parameters` 来自 `toAITools()` 的 Zod -> JSON Schema 结果，省略 `strict`，对象键序固定如上。
- tokenizer 口径固定为 `o200k_base`；仓库实现精确锁定 Bun 原生 `js-tiktoken@1.0.21`，并以 Python `tiktoken==0.12.0` 对同一 wire 做一次交叉校验。实现提供唯一可重复命令 `bun run tool-contract:measure`，该命令不得依赖 `/private/tmp` 或未声明的全局包。
- 四个诊断计数分别 tokenize minified `JSON.stringify(names[])`、`JSON.stringify(descriptions[])`、`JSON.stringify(parameters[])`，以及把 30 项均替换成 `{"type":"function","function":{"name":"","description":"","parameters":{}}}` 后的 minified skeleton 数组；独立计数因 token 边界不要求相加等于 full wire 总数。
- 最终报告必须列出 ArchCode 修改前/后的工具数、full wire、name、description、parameters 与 skeleton token，并给出绝对增量和百分比；当前 ArchCode full-wire 基线为 6,284 tokens。
- 最终报告必须用同一 `o200k_base` 口径列出已捕获的 Claude Code、Codex 和 `OMO-CAP` 工具数与 full-wire token；其中 `OMO-CAP` 必须单列 OpenCode base、OMO/plugin、MCP 增量，其他竞品的插件/MCP 等额外 surface 也不能与 base/core tools 混算后直接下结论。
- Token 数值不作为 `DONE/NOT_DONE` 门槛。Reviewer 只拒绝无 evidence id、与 runtime 不符、重复表达同一事实或仅为增加篇幅的文案；不得为了压低 token 删除本 Goal 要求的真实契约。

### AC-06：验证与验收证据完整

- 目标 contract tests、`file_read` 回归测试和 `delegate` Skill 恢复测试全部通过。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- Reviewer 按 AC-01 至 AC-07 给出代码、测试、搜索和运行证据，不能用“文案更详细”或“测试通过”代替逐项验收。

### AC-07：源码支持的操作手册与示例完整

- 文档固定记录 OC-CURRENT/OMO-CURRENT 的 commit、默认非 MCP 去重公式和 20–23（task system 开启时约 24–27）范围；不得再用“OMO 工具更多”解释 ArchCode 的首轮 token 差距。
- `file_read/file_edit/bash/todo_write/delegate/background_output/wait_for_reminder/resume_session/skill_list/skill_read` 均含至少一个真实字段名的一次正确调用示例；`grep/glob`、Git、LSP 与 background 生命周期均含明确跨工具链。
- `delegate` 与 `todo_write` 含 when/when-not；`file_edit`、`bash`、background 生命周期含失败/未完成恢复动作。model-visible contract tests 必须从 `toAITools()` 后的 description/schema 逐项断言。
- 最终 token 只报告真实结果和竞品对照，不设上限或通过阈值。
