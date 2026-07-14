# Shared Code Unification Hard-Cut Goal

## Objective

彻底统一当前重复的跨层契约、常量和纯机制：每条规则只有一个权威定义，各调用方直接复用；删除旧实现、旧导出、别名和兼容分支。重构必须保持现有产品入口与领域边界，高内聚、低耦合，不借机改造 Runtime、Session 或产品流程。

## Locked Architecture

```text
packages/protocol/src/                         -> 跨 Core / Server / Web 的常量与纯判断
agent-core/src/goals/review-schema.ts          -> Goal review receipt 权威 Schema
agent-core/src/automations/schema.ts           -> Automation 权威 Schema
apps/server/src/validation.ts                  -> Hono-Zod 到 BadRequestError 的薄适配
agent-core/src/agents/constants.ts             -> 两个 Agent 功能能力包
agent-core/src/llm/retry.ts                    -> Retry-After 与 abortable sleep
agent-core/src/compression/normalize.ts        -> Compression 专用 normalization
agent-core/src/execution/session-tree.ts       -> Session tree ID traversal
packages/utils/src/sort-json-value.ts          -> 跨 Core / Server 的稳定 JSON 排序
agent-core/src/utils/safe-file.ts              -> 文件级 atomic write
```

- 只因代码相同或规则必须同步变化而提取；仅仅“长得像”不构成公共抽象。
- 不建立 `common.ts`、BaseController、DI 容器、通用 Repository 或 Agent tools 大合集。
- 完整 Agent 权限表只属于各自 `AgentDefinition`；共享集合仅限不可拆分的功能能力包。
- Hard cut 仅覆盖本 Goal 触及的请求 helper、HITL receipt、Automation contract、Agent group 和重复纯函数：其旧名字、旧实现、re-export、deprecated alias、fallback 与双写全部删除；不得据此删除或改造其他 Session、Goal 或项目持久化数据。

## Non-goals

- 不新增 Automation HTTP 创建接口，不改变现有 Tool/Core 创建与 HTTP 管理流程。
- 不重构 `AgentRuntime`、ProjectContext、SessionExecutionManager、SessionStoreManager 或 Dashboard 语义。
- 不改变 Goal、HITL、Automation 的生命周期；只收紧已确认的输入契约。
- 不建设通用校验框架、遍历框架、重试框架或 UI 组件框架。

## Acceptance Criteria

以下 AC-01 至 AC-07 必须全部有代码、测试或审计证据；任一条件缺失即为 `NOT_DONE`。

### AC-01：Server 请求校验统一使用 Hono

- 使用 `hono/validator` 和现有 Zod Schema 处理 `json`、`param`、`query`；Hono 负责请求提取，唯一薄适配只负责把 Zod 失败转换为现有 `BadRequestError` 响应。
- 删除 route-local `requiredParam`、`readJsonBody`、`readOptionalJsonBody`、`readMessageBody`、`readCommandBody` 以及所有 Zod-backed route input 的手工 `safeParse` 分支，不保留 wrapper alias。
- 路由参数存在性由 Hono 路由匹配负责；UUID、enum、body 和 query 格式由 validator schema 负责，handler 只读取 `c.req.valid(...)`。
- malformed JSON、缺少必填 body、非法 UUID/enum/query 均有 400 回归测试；成功响应、错误 envelope 和业务行为不变。

### AC-02：HITL Review Receipt 只有一个权威契约

- `GoalEvidenceRefSchema`、`GoalReviewReceiptSchema` 及长度限制只在 `goals/review-schema.ts` 定义一次；该叶子模块只能依赖 Protocol 类型与 Zod，不得依赖 Goal State、HITL、Tool 或 Server。
- Goal State、HITL route、owner store、Goal adapter 和 `goal_manage` 直接复用该叶子模块或其字段级 schema；owner store 不得为复用 Schema 而导入 `goals/state.ts`。
- HTTP claim/persist 前完成严格校验，并强制 `review_outcome.outcome === receipt.verdict`；非法 receipt 不得进入 owner store，也不得进入 delivery retry。
- 删除 Server、HITL persistence 和 Tool 中的重复 schema；不保留宽松解析、默认补值或旧 receipt fallback。既有不符合新契约的数据直接拒绝。

### AC-03：Automation 常量与 Schema 跨层一致

- Protocol 统一导出 `AUTOMATION_NAME_MAX_LENGTH = 200`、`AUTOMATION_MESSAGE_MAX_LENGTH = 10_000`、`AUTOMATION_TIMEZONE_MAX_LENGTH = 100`、`MIN_AUTOMATION_INTERVAL_MS = 30_000`；Automation schema、Tool、route 和 UI 不再使用对应数字字面量。
- Agent Core 的 Automation trigger/action schema 是创建、持久化和 HTTP update 的唯一领域校验；Tool 与 Server 直接复用，Web 使用 Protocol 常量做等价前置校验和 `maxLength`。
- 删除 Server 的重复 Trigger/Action/Name/Message/Timezone schema，不保留宽松 Core schema、兼容分支或迁移；不新增创建 API，不改变现有 Automation 字段和流程。

### AC-04：Agent tool policy 单一且可审计

- 删除 `tools/groups.ts`、`EXPLORER_READ_ONLY_TOOLS`、`DELEGATION_EXECUTION_TOOLS` 及全部导出、测试依赖和兼容别名。
- 每个 Agent 的完整 tools 权限表继续留在自己的 definition；不得新增 `ENGINEER_TOOLS`、`BASE_AGENT_TOOLS`、`READ_ONLY_AGENT_TOOLS` 等 Agent 级合集。
- 仅在 `agents/constants.ts` 保留 `SKILL_ACCESS_TOOLS = [skill_list, skill_read]` 与 `DELEGATION_CORE_TOOLS = [delegate, background_output, wait_for_reminder]` 两个功能能力包；前者由有 Skill 的七个 Agent 使用，后者由五个可委派 Agent 及 Factory 深度过滤共同使用。
- `view_tool_output`、`cancel_session`、Bash、Memory、源码写入和 Goal 工具保持角色内显式声明；测试直接审计真实 definitions 的允许/禁止矩阵。

### AC-05：重复纯机制收敛到最小公共内核

- Protocol 统一 StreamEvent 类型判断和 terminal child status 判断；Core、Server、Web 删除各自集合副本。
- `llm/retry.ts` 导出 `parseRetryAfter`、`sleepAbortable` 供 Query Loop 复用，各自退避公式保持独立；`compression/normalize.ts` 只服务 Compression 内部 text/value normalization。
- `execution/session-tree.ts` 统一 Session delete、family stop、Goal cancellation 的 tree ID traversal；返回不同数据的 HITL aggregation 不被强行合并。
- `@archcode/utils` 的 `sortJsonValue` 只负责稳定排序，compact/pretty 格式仍由调用方决定；`safe-file.ts` 统一 Goal state、Session HITL checkpoint、transcript 和 Config 的文件级 temp-write-rename，并支持权限选项与失败清理；目录级原子事务保持独立。
- 每个新公共函数至少有两个生产调用方；原重复实现全部删除，不保留转发 wrapper。

### AC-06：Web 重复展示逻辑统一但视图不合并

- Goals list、Goal detail、ChatHeader 使用同一个 Goal status class 映射，状态到样式的结果保持不变。
- ChatMessages 与 CompressionBlock 共享 delegation card view-model；实时视图和历史视图继续保留各自 DOM、交互和布局。
- 不建立通用 Card、状态主题系统或新的 UI abstraction hierarchy。

### AC-07：Hard-cut 审计与完成证据

- 采用 TDD：先增加共享契约/行为测试，再替换生产调用方；架构测试证明 Web 仍不依赖 Agent Core/Server，Agent definitions 是权限唯一来源。
- 文字审计确认生产代码中不存在旧 group 名、route-local 请求读取 helper、重复 HITL receipt schema、重复 Automation 限制和被替代的纯函数实现。
- 更新受影响的 barrel exports、AGENTS.md 架构描述和测试 fixture；不得留下无生产调用的导出或兼容层。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- Reviewer 必须逐项给出 AC-01 至 AC-07 的文件、测试与删除证据；不能仅用“测试通过”代替验收。
