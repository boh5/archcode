# Internal Metadata Hard-Cut Goal

## Objective

彻底删除 ArchCode 内部持久化、跨层协议、工具元数据和浏览器状态中的格式版本及冗余标记，使系统只存在一个当前契约。重构同时修正已确认的语义误名和死事件合同，但不改变 Session、Goal、HITL、Automation、Permission 与 Compression 的既有业务行为；不保留 fallback、旧字段别名、双读双写或迁移代码。

## Locked Architecture

```text
Domain-owned strict current schema -> Protocol current wire type -> Server -> Web
Session event routing             -> payload.type
Goal durable state commit         -> narrow change callback -> resource.changed -> Web refresh
```

- 每个领域继续拥有自己的严格 Schema、持久化和不变量；不引入通用 `Versioned<T>`、迁移注册表、Repository/DTO 层或元数据框架。
- `packages/protocol` 只承载当前跨层类型与纯判断；Web 仍不得依赖 Agent Core 或 Server。
- 不为本次重构拆分存储模型与公开 API；同一当前契约由 Server 与随版本一起发布的 Web 使用，不增加映射层。
- Web 对工具 `meta` 这类 `unknown` 输入做结构校验，不能用 `version` 代替数据校验。
- LSP document version、MCP ClientInfo version、package/依赖/二进制版本、Git `--porcelain=v1`、HTTP `/v1` 等外部协议或资源身份必须保留。

## Non-goals

- 不改变 Goal/HITL/Automation 状态机、Session 执行、权限语义、压缩算法或 SSE event cursor/replay 规则。
- 不新增 API v2、兼容解析、数据迁移器、旧浏览器 storage key 回退或公开扩展点。
- 不借机建设公共事件基类、通用校验框架、配置 transport 插件体系或新的抽象包。

## Hard-Cut Constraint

- 切换前先停止 ArchCode，并将以下内容作为人工清理前置条件：删除 `~/.archcode/projects/index.json`、`~/.archcode/memory/`、每个旧 workspace 下承载 Session、Goal、HITL、Automation、Permission、Compression、project memory 与 cwd removal journal 的 `.archcode/` 运行数据，以及浏览器中的旧 workbench layout key；不删除源码目录或 `.archcode-worktrees/`。
- 在本次 hard cut 涉及的持久化状态中，只保留启动所需的 `~/.archcode/config.json` provider/agent 配置；实现不得新增清理脚本、转换器、迁移入口、旧数据探测或兼容读取。完成 smoke test 前必须确认上述旧状态不存在。

## Acceptance Criteria

以下 AC-01 至 AC-07 必须全部有代码、测试或审计证据；任一条件缺失即为 `NOT_DONE`。

### AC-01：内部格式版本全部删除

- 删除 Session `schemaVersion`，以及 Goal、Automation state、HITL owner file、Session HITL blocker/journal、Permission approvals、Project registry、cwd removal journal、Compression summary/state/snapshot、ToolDiff、`ask_user` result metadata 和 AuditEvent 的 `version` 字段。
- 删除对应常量、Zod literal、类型属性、producer、consumer、prompt 文案、fixture 和只为版本存在的分支；`archcode.workbench.layout.v1` 改为无版本键，不读取旧键。
- 当前严格 Schema 仍拒绝未知字段、缺失字段和非法跨字段关系；带旧 `version`/`schemaVersion` 的对象不得被兼容接受。
- 审计证明内部契约不存在 `schemaVersion`、`COMPRESSION_STATE_VERSION`、`COMPRESSION_SUMMARY_FORMAT_VERSION` 或 `version: z.literal(...)`；剩余 `version` 均属于 Locked Architecture 中明确保留的外部版本。

### AC-02：冗余标记删除且判别能力不退化

- `SessionEventEnvelope` 与 `GlobalSessionEventEnvelope` 删除 `kind`，持久化、SSE 转发和 Web reducer 统一使用并校验 `payload.type`；event id、顺序、去重、gap buffer、reset 和 replay 行为不变。
- Session HITL durable entry 删除重复 `kind`，只由 `source.type` 判定 `ask_user | tool_permission`，权限 metadata 与 response 类型仍严格匹配。
- 删除 `DirectoryEntry.kind: "directory"`、内部 ripgrep `MatchResult.type: "match"`、HITL realtime payload 中重复的 `status`，以及仅包装测试清单的 DCP parity `status/coveredBy` 结构。
- Automation trigger/action、HitlSource、ProcessResult、Goal/HITL status、`redacted: true` 与 ToolTraits 等真实判别或安全字段保持不变。

### AC-03：语义命名完成硬切

- Goal 与 Automation 全链路将实际保存 slug 的 `projectId` 改为 `projectSlug`；生产类型、Schema、方法参数、错误信息、API/Web 使用和测试中不再保留旧名。
- phaseful durable HITL 类型和文件统一使用 `SessionHitlJournalEntry`、`SessionHitlJournalFile` 与 `hitl-journal.json`；Session 投影中的等待状态使用 `SessionHitlBlocker`，不再混用 checkpoint/journal。
- `GoalRunner` 按其创建、激活、恢复、review、retry 与生命周期命令协调职责改为 `GoalLifecycleService`；它只负责 root lifecycle command/activation 的编排与 execution claim，不吸收 `GoalStateManager` 的状态持久化与不变量、`GoalCancellationService` 的 family stop/cleanup 或 `GoalLeadContinuationService` 的 continuation/backoff 调度。旧类名、error 名、导出、wrapper 和 alias 全部删除，不新增中间 adapter。
- 清理受影响生产注释与活动文档中的退役 Workflow/Loop 误称，不重写明确标注为历史记录的文档。

### AC-04：Compression 与工具元数据保持完整行为

- Compression prompt、tool input、summary validator、内部 state、protocol snapshot、reducer 和 Session persistence 同时切换到无版本结构；required sections、child refs、placeholder、overlap、protected refs、hard compact 清理和重启恢复规则不变。
- `ask_user` 成功结果只产生 `{ answers: string[][] }`；Web 仅接受顶层键集合严格等于 `{ answers }`，并在问题与答案结构、数量都合法时渲染 Q/A。缺失、损坏或带额外键的 metadata（明确包括 `{ version: 1, answers }`）必须展示原始 output，不猜测裸答案，也不隐藏结果。
- ToolDiff 顶层只允许 `files` 以及可选的 `truncated`、`unsupportedReason`、`warning`；Web 对顶层及 file/hunk/line 按 Protocol 当前类型逐层拒绝未知键、缺失必要字段和非法字段类型后再渲染。带旧 `version` 或 nested malformed 的 diff 必须被安全忽略，但工具原始结果仍可见；测试必须明确覆盖 `{ version: 1, files }` 被拒绝。

### AC-05：死合同与固定配置项收敛

- 删除无生产 producer 的 `goal.state_change`、重复 `goalId/status`、对应 reducer 分支和 Session `goals` 投影。
- `resource.changed` 从 Protocol、Goal/Automation producer、Server bridge、Web consumer 与测试中删除 `reason`；事件本身只表达指定 resource 已变化，Web 不按变化原因分支。
- 每次成功的 durable Goal 状态提交在原子持久化完成后恰好调用一次领域无关的窄回调；Goal 模块不得依赖 Server event bus。通知链路失败只能记录日志，不得回滚已提交状态、改变 command result、重试 commit 或引入 outbox。Web 对 Goal list、active list 与 detail query 的实时刷新有测试；Goal 状态变化不得额外刷新 Session query。
- MCP server 配置删除固定 `transport: "http"`；HTTP transport 作为 MCP client 私有实现。GitHub 配置/API/UI 删除只能等于常量的 `apiBaseUrl`，客户端内部继续使用 GitHub.com 常量；删除无运行消费的 `$schema` 配置字段。
- Settings 读写、脱敏 secret preservation、MCP discovery 和 GitHub connector 回归通过，不新增 transport/provider 抽象。

### AC-06：领域边界和关键流程无回归

- 架构测试继续证明 `server -> agent-core -> protocol`、`web -> protocol` 的依赖方向，Protocol 与 Utils 保持零运行时依赖。
- 回归至少覆盖：Session 创建/重启/SSE replay；多问题 `ask_user`；工具权限批准、拒绝与冷恢复；Goal 创建、状态变化、review、retry、cancel；Automation 调度与重启；Permission fail-closed；Compression commit/hard compact/reload；ToolDiff malformed UI。
- 不增加新的跨领域 manager、共享 mutable state、双重事实来源或仅有一个生产调用方的公共抽象。

### AC-07：彻底删除与完成证据

- 生产代码审计不存在旧字段、旧类型名、旧文件名、fallback、deprecated alias、双读双写、格式迁移分支或仅测试消费的遗留导出；合法的 cwd removal 事务不因名称含 migration 而被误删。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 在清空旧运行数据后的全新状态完成项目注册、Session 消息、HITL 回答、Goal 状态刷新和 Automation 创建/调度 smoke test。
- Reviewer 必须逐项给出 AC-01 至 AC-07 的文件、测试、搜索和运行证据；不能只用“测试通过”代替验收。
