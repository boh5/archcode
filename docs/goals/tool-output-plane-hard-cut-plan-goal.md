# Tool Output Plane 彻底重构计划

## Objective

把 Tool 输出从“执行完得到一个大字符串，再由全局 hook 截断”改成唯一的 **Tool Output Plane**：执行时有界捕获，落盘前完成脱敏，Session 只保存结构化结果、预览和不透明引用，模型只看到有预算的投影，用户和 Agent 通过有界读/搜恢复所需片段。

完成后的用户行为是：大命令照常运行；卡片直接显示开头、结尾、总量和“查看输出”；Agent 可搜索错误并只读取附近片段；刷新、重启和 compact 后仍可发现并使用引用。无法保存、被截掉或已淘汰的内容必须明确标识，不再静默丢失。

## Locked Architecture

### 第一性原则

1. **输出是数据，不是聊天字符串。** 完整正文、Session 记录、UI 展示和模型上下文是四种用途，不再共用一个 `string`。
2. **捕获与投影分离。** 进程排空和 artifact 保存不由模型预算决定；模型投影不反向修改 artifact。
3. **恢复必须有界。** 完整正文不得一次性重新进入模型；只允许 cursor 分页或有上限的搜索。
4. **恢复跟随数据源。** 稳定源使用原工具分页；不稳定结果使用 artifact。
5. **安全高于可恢复性。** 未脱敏正文/metadata 不得落盘或进入 Session/SSE/UI/模型/日志；引用不暴露本地路径；跨 Project/root Session family 访问必须拒绝。

### 唯一执行边界

`Tool/Bash/MCP -> RawToolResult -> ToolOutputFinalizer -> FinalizedToolResult -> {Session/SSE/UI, Model Projection, Artifact Read/Search}`

内部和持久化类型必须硬分离：

```ts
type RawToolResult = {
  isError: boolean;
  draft: TextDraft | SourcePageDraft | CaptureDraft;
  details?: RawToolDetails;
  sidecar?: ToolExecutionSidecar;
};

type RegistryExecutionOutcome =
  | { kind: "settled"; result: FinalizedToolResult; sidecar?: ToolExecutionSidecar }
  | { kind: "blocked"; request: ToolBlockedRequest };

type ToolOutput = {
  preview: string;
  completeness: "complete" | "partial";
  observed: { bytes: number; lines: number };   // 脱敏前收到的量
  canonical: { bytes: number; lines: number };  // 脱敏后的逻辑正文
  stored: { bytes: number; lines: number };      // inline/artifact 实际保留量
  omitted: { bytes: number; lines: number };     // canonical 中未保留量
  recovery:
    | { kind: "none" }
    | { kind: "source"; toolName: string; nextInput: JsonObject }
    | { kind: "artifact"; outputRef: string; expiresAt: number; canRead: true; canSearch: true };
};

type FinalizedToolResult = { isError: boolean; output: ToolOutput; details?: ToolResultDetails };
```

- `ToolDescriptor.execute` 和 tool-specific after hooks 只处理 `RawToolResult`，不得返回 `string`、blocked 或最终 `ToolOutput`。
- Registry 对 execute 产生的 raw result 恰好 finalization 一次并返回 `settled`；guard/permission/ask-user suspension 的 `blocked` 分支 finalization 零次并原样返回，且不产生 settled event/part。audit/logger 只消费 settled finalized result。
- `ask_user` 是唯一 suspendable descriptor：它声明 strict `prepareBlock(input)` 与 `resume(input,response)`，初次调用由 Registry 在 execute 前返回 blocked；回答或取消后，SessionToolBatchScheduler 只能调用 `Registry.resumeBlocked`。Registry 复验原 call/input/requestKey/response，resume mapper 生成 `RawToolResult`，再恰好 finalization 一次。scheduler 不得直接构造/追加任何 tool result；permission deny、batch cancel 和 recovery error 同样调用 Registry 的 system-result lane。
- `HitlBoundaryCodec` 唯一拥有完整 strict request/response union，HTTP route、ProjectHITLQueue 与 Session batch persistence 不得另建 schema。所有 id/name/approvalPoint 最多 128 bytes，permission fingerprint 固定 64 hex；redacted display 序列化最多 32 KiB，ask-user 最多 3 questions/每题 3 options，question/description 最多 2 KiB，header/label 最多 256 bytes；permission description/reason/decisionDisplay 各最多 4 KiB、ruleId 最多 256 bytes，整个 `ToolBlockedRequest` 最多 48 KiB。
- response 必须先脱敏再校验才可落 queue：原 secret 值零持久化，合法的 redacted response 可继续；仅当脱敏后的 shape/字段/总量不合法时，整笔返回 4xx/bounded policy violation且 HTTP、queue、batch 均零写入。question-answer 最多 3 项、单项 16 KiB、comment 4 KiB、actor 256 bytes、总计 64 KiB；permission/budget comment 4 KiB、actor 256 bytes、总计 8 KiB；cancel reason 4 KiB、actor 256 bytes、总计 8 KiB。delivery error 最多 2 KiB且先脱敏，整个 HitlRecord 最多 128 KiB；HITL HTTP body 在 JSON parse 前硬限 128 KiB。不得截断问题、答案或 permission rationale。
- Registry 对每个 `artifact` policy 调用都必须在 execute 前创建通用 capture sink 并注入 context；是否已经发生 effectful attempt 是独立状态，不能拿它决定是否捕获。finalizer/sink 失败必须走 bounded system-result constructor：尚未 attempt 时返回稳定错误；已经 attempt 时同时设置 `unknownResult: true`，继续排空并丢弃无法安全保存的后续字节，不得回退为原始正文或旧截断结果。
- permission/schema/doom/cancel/restart-recovery 等合成结果同样只使用 bounded system-result constructor。`blocked`、`executionControl`、`sessionCwdChanged` 等调度控制是内部 sidecar，不进入持久结果。
- `ToolResultEvent`、settled `ToolPart` 和 `SessionToolCallResult` 只接受 `FinalizedToolResult`；completed/error part 都使用 `output`，删除 `errorMessage`。

### 严格公开 metadata

删除 `meta?: Record<string, unknown>`。唯一可持久化的 `ToolResultDetails` 是 strict object：

- `error?`：`kind/code/name` 各最多 128 UTF-8 bytes，`hint` 最多 2 KiB；原始 exception/stack/details 不持久化。
- `process?`：仅 `exitCode/signal/timedOut/aborted/durationMs` 标量；`signal` 最多 32 bytes。
- `unknownResult?: true`。
- `presentations?`：最多 2 项的 strict union，仅允许 `diff` 或 `ask_user`。diff 最多 20 files、2,000 lines、每个 path/header/line 4 KiB，序列化后最多 256 KiB；ask-user 最多 3 组 answers、单个 answer 16 KiB、合计 64 KiB。

所有 details 先用同一 SecretRedactionPolicy 脱敏，整个序列化 details 上限 256 KiB；超限时只按各 union 的既定截断规则收缩并设置其 `truncated`，不得把正文塞入新字段。`presentations` 只供 Session/SSE/UI，模型投影明确排除。Tool input 继续保存既有 resolved+redacted input，本 Goal 不得削弱该边界。

`recovery` 也不是 metadata 逃生口：序列化后最多 16 KiB、深度最多 8、全对象最多 64 keys、全数组最多 256 items，key 最多 128 bytes、单个 string 最多 8 KiB。`source.nextInput` 必须先用同一 policy 深度脱敏，再通过目标 descriptor 的 strict input schema；任一限制或校验失败均返回 bounded `TOOL_OUTPUT_POLICY_VIOLATION`，原对象不得持久化。

### 穷尽的 output policy

每个 descriptor 必须显式声明 policy 和 preview 方向，不存在 default：

| Policy | Tools | 超限语义 |
| --- | --- | --- |
| `source` | `file_read`、`grep`、`glob`、`background_output`、`output_read`、`output_search` | 工具自身返回 bounded page 与可通过原 schema 校验的 `nextInput`；无下一页时 `none`；永不生成 artifact。 |
| `artifact` | `file_write`、`file_edit`、`ast_grep_search`、`ast_grep_replace`、`git_status`、`git_diff`、`bash`、`ask_user`、4 个 LSP、`web_fetch`、`delegate`、`resume_session`、`skill_read`、`memory_read`、8 个 GitHub tools、所有 `mcp__*` | 小结果 inline；超过模型 preview 上限时保存 artifact。所有 process-backed descriptor 使用流 capture，其余为 bounded one-shot finalize。默认 `head-tail`。 |
| `inline` | `todo_write`、`project_todo_update`、`wait_for_reminder`、`cancel_session`、`skill_list`、`memory_write`、`goal_create`、`goal_manage`、`automation_create`、`compress`、`worktree_enter`、`worktree_exit` | 必须在 finalization 前满足上限；超限返回 `TOOL_OUTPUT_POLICY_VIOLATION`，effectful attempt 同时为 unknown，不得自动改走 artifact。 |

`view_tool_output` 被直接删除；`output_read`、`output_search` 加入 `BuiltinToolName` 并提供给全部八类 Agent。Architecture test 必须证明所有 builtin、session-extra、GitHub 和 dynamic MCP descriptor 均被穷尽分类。

### 固定边界与生命周期

- Session preview 同时满足有效 UTF-8、最多 50 KiB 正文、最多 2,000 行；artifact 默认等额 head-tail，source 默认 head。单次模型 tool-result 投影的总序列化预算也是 50 KiB，预算覆盖 preview、可见 details 与 recovery，`presentations` 不进入模型；projection 必须在总预算内确定性收缩。
- canonical text 使用同一个 incremental UTF-8 decoder；非法 byte sequence 一律替换为 `U+FFFD`，observed 统计原 bytes、canonical 统计替换后 bytes。二进制原 bytes 不保存，符合本 Goal 的 binary artifact 非目标。
- ProcessRunner 的 `1 MiB` 只指内存 head-tail ring，不是 artifact 截断：stdout/stderr 各 `<= 1 MiB`；每流 decoder+redactor+writer queue 合计 `<= 64 KiB`，双流总内存 `<= 2 MiB + 128 KiB`。ProcessRunner 只产 raw stdout/stderr；每个 process-backed artifact descriptor 必须声明 bounded canonical adapter，只有 adapter 输出进入 capture sink。passthrough 与 transform 都只能从该 canonical stream 生成 inline preview/artifact，禁止分别重算两份结果。
- `ast_grep_search` 硬切为官方 [`--json=stream`](https://ast-grep.github.io/guide/tools/json.html) 的 NDJSON canonical 输出，不再构造旧 `{count,matches}` 大对象；`ast_grep_replace` 使用 state `<=64KiB` 的增量 tokenizer，单 record 最多 1 MiB，apply 前最多 10,000 matches/1,000 unique files/4 MiB path bytes，超限在任何 mutation 前失败。其 dry-run/apply canonical 正文均为同一 NDJSON stream，diff 只走 bounded presentation。其他 process adapter 必须显式证明 raw stream 是 canonical，或使用有界增量 transform。
- BinaryManager 对每个 ast-grep PATH/cache candidate 运行真实 capability probe：`run --pattern foo --lang JavaScript --stdin --json=stream`，输入 `foo`，要求成功且 stdout 为单个 JSON-object line。失败 candidate 直接跳过并解析/安装 manifest 固定的 `0.42.3`，固定 binary 仍 probe 失败则 fail closed；绝不回退旧 `--json` array 模式。
- capture sink 使用 bounded queue；每次等待 queue capacity 最多 1 秒，writer reject/不 resolve/超时后立即切到 discard mode，finalize 总等待最多 5 秒。失败后的字节只计 observed 后丢弃，但 ProcessRunner 始终继续读 stdout/stderr 到 EOF。ProcessRunner 不依赖 Project/Session/artifact 实现。
- 每个 capture 有 generation fence + AbortController；任一 deadline/failure 会永久 revoke commit 权、abort/close writer 并清理 temp。目录 rename 必须在串行 commit mutex 内再次校验 active generation；任何 late writer/finalizer completion 都不得提交、恢复 ref 或改写已返回的 unavailable 结果。
- 单个 artifact 最多 64 MiB canonical 正文；超出时 head/tail **分别最多** 63 MiB/1 MiB：head end 收缩到不大于 63 MiB 的最后 UTF-8 code-point boundary，tail start 前进到不小于 `canonicalBytes - 1 MiB` 的首个 boundary。gap 只存在于 metadata/虚拟读取结果，omitted bytes/lines 按两个实际 boundary 计算并标 `partial`；所有 preview/page byte cut 同样只能落在 boundary。
- 完成态正文使用独立 body quota：总计最多 500 MiB、active body 最多 10,000 个；body 从创建起保留 7 天，read/search 更新 `lastAccessedAt` 供 LRU 使用但不延长 TTL。授权 metadata 与 tombstone 使用独立有界 ledger：active+tombstone 最多 100,000 entries、序列化后最多 64 MiB；active artifact 创建时即占一个 ledger slot，TTL/eviction 只原位转换为 tombstone，不增加 slot。新 artifact admission 在清理超过 7 天的 tombstone 后仍无 ledger slot 时 fail closed 为 unavailable。这样 quota/TTL 删除 body 后仍保证最小 tombstone 7 天，并稳定区分 `EXPIRED/EVICTED/NOT_FOUND`。
- cleanup 优先级固定为：TTL 删除优先于 lease；压力下先撤销最旧 query lease，再按 LRU 淘汰未 pin 的 completed body；active temp/producing artifact 永远不是 body eviction 候选。producer Session/subtree 被明确删除时，其 refs 直接变为 `NOT_FOUND`，不伪装为 TTL 或 quota tombstone。
- Store 启动时清理过期 body、过期 tombstone 和 stale redacted temp；每次 finalize 后立即执行 quota，再每小时清理。read-time 强制 TTL。Runtime shutdown 必须 dispose timer/active writer。
- `projectIdentity = SHA-256(realpath(workspaceRoot))`，只作内部授权键，绝不通过 ref/API/UI 暴露路径或 digest。每个 artifact 同时记录授权 owner `{projectIdentity, rootSessionId}` 与生命周期 owner `producerSessionId`。删除 child subtree 时按实际 `sessionIds` 删除；删除 root family 时删全 family。Project DELETE 保持当前 **unregister** 语义，不删 Session 或 artifact；即使原 slug 被其他 Project 占用，原 workspace 重新注册为新 slug 后，未过期引用仍可用。数据 purge 不在本 Goal。
- 每个 artifact 写入临时目录，strict metadata/body 完成后以目录 rename 一次提交；并发 finalize/quota commit 串行化。未脱敏 temp 不允许存在。

### 恢复契约

- `output_read({outputRef,cursor?,limit?})`：默认 200、最多 1,000 个 line records，正文最多 50 KiB。cursor 是按 logical segment + byte offset 的认证不透明值，并绑定 project/root/outputRef；超长单行按 UTF-8 boundary 分段，返回 `continuedFromPrevious/continuesNext`，保证 cursor 前进且无字节重叠/缺口。
- `output_search({outputRef?,pattern,cursor?,limit?})`：默认 50、最多 100 个命中，pattern 最多 1 KiB UTF-8，正文最多 50 KiB，5 秒硬超时。带 ref 的 cursor 绑定 project/root/ref/pattern digest；省略 ref 时搜索当前 family，用于 compact 后重新发现 ref。
- family search 首页创建 5 分钟内存 query lease：按 `(createdAt, outputRef)` 升序冻结当时 active artifact refs，并在 lease 内阻止这些 body 被 LRU 淘汰；之后新增 artifact 不进入本次查询，last-access 变化不改顺序。每 lease 最多 10,000 refs、全 Runtime 最多 64 leases/40,000 pinned-ref slots、每 family 最多 8 leases；quota/slot 压力时先撤销最旧 lease。cursor 只含随机 lease id、artifact index 和 intra-artifact cursor，并绑定 project/root/pattern digest；撤销、缺失、过期或跨 scope/pattern 使用统一返回 `TOOL_OUTPUT_INVALID_CURSOR`。terminal page 立即释放 lease/pins；TTL 仍优先，Runtime shutdown 清空全部 lease。该临时 lease 不是持久索引。
- 搜索由 artifact-store 内部使用可终止的 ripgrep 进程完成，不使用不可中断的 JS regex；pattern 非空、禁止 CR/LF 和 multiline，5 秒是单次 Tool/API call 的总 deadline。rg 只输出 line/byte offset + match，stream parser 最多保留 128-byte numeric prefix并丢弃任意长 match，再按 byte offset读取每个最多 1 KiB 的 UTF-8 snippet，因此超长行/匹配不会整行入内存。search cursor 记录 original segment 上 rg 的严格 match ordinal + start/end；翻页重跑时跳过 `<= ordinal` 的结果。零宽命中只发一次，EOF 零宽命中后直接标记 segment complete，因此 `^`/`$`/`a*` 均严格前进。partial artifact 的 head/tail 是两个独立 segment，不允许跨 gap 伪命中；结果返回 `searchCompleteness: complete | partial_artifact`，无命中也明确 omitted 区域未搜索。
- Tool 与 HTTP 共用同一 store 方法和错误码：`TOOL_OUTPUT_FORBIDDEN`、`TOOL_OUTPUT_NOT_FOUND`、`TOOL_OUTPUT_EXPIRED`、`TOOL_OUTPUT_EVICTED`、`TOOL_OUTPUT_UNAVAILABLE`、`TOOL_OUTPUT_INVALID_CURSOR`、`TOOL_OUTPUT_INVALID_PATTERN`、`TOOL_OUTPUT_SEARCH_TIMEOUT`。
- HTTP 固定为 `GET /api/projects/:slug/sessions/:sessionId/tool-outputs/:outputRef`（read）和 `POST .../:sessionId/tool-outputs/search`（search）；两者均执行 project/root-family authorization，绝不返回真实路径。

### 安全与消费规则

- SecretRedactionPolicy = 现有 assignment/token patterns + Runtime `SecretLiteralRegistry`。配置解析必须暴露 provider/MCP 已解析 literal；GitHub token 在 Runtime 创建期按配置 tokenEnv、`GITHUB_TOKEN`、`GH_TOKEN` 的既有优先级只解析一次并由 connector 复用；Server 把 `ARCHCODE_SERVER_PASSWORD` 作为 external literal 传入 `createRuntime`。Runtime 必须在任何 descriptor/MCP/GitHub 调用前一次性注册所有 resolved provider `apiKey/headers/queryParams` values、user MCP URL/header values、实际选中的 GitHub token 和 server password。去重后最多 256 条、UTF-8 总计最多 64 KiB，每条 8 bytes 至 16 KiB；任一边界不满足都在 Runtime 启动前以语义配置错误拒绝。matcher 全 Runtime 共享一次，per-stream carry 计入 64 KiB 上限，并与 one-shot policy 等价且跨任意 chunk boundary 工作。
- one-shot producer 不能先生成无界对象再交 finalizer：`web_fetch` 保留 parse 前 5 MiB body cap；MCP、GitHub 和 LSP 的单次 transport payload 在 parse/serialization 前各硬限 8 MiB，超限返回 bounded `TOOL_OUTPUT_POLICY_VIOLATION`。finalizer 的 64 MiB artifact cap 不是网络或反序列化内存预算。
- source cursor 语义固定：`grep`/`glob` 对每次调用的结果按稳定 path/position 排序后使用 offset cursor；它们不承诺文件系统 snapshot，分页期间工作区变化可改变后续集合，response 必须明确 `snapshot: false`，但单个响应仍无重复且 cursor 严格前进。
- SessionToolBatch 的 recovery/manual-inspection failure 与 pending/running ToolPart 生命周期信息必须改为 strict、脱敏且 bounded 的 typed fields；不得继续使用任意 `meta` 或无上限 string 作为持久 side channel。
- exception、before/after-hook failure 和 sink failure 在任何日志前先经过该 policy；日志只记录 redacted message 与稳定 code/name，不能记录 raw output、stack、URL/header 或 path。
- hard compact 后确定性注入 bounded notice：当前 family 有多少可恢复 artifact，并提示无 ref 调用 `output_search`；不依赖 LLM 自行把 ref 写进 summary。
- store model/full-history projection、DCP fingerprint/error grouping/original-range、background_output、memory extraction、Goal evidence 和 Web UI 均只消费统一 preview/details/ref；它们不得自行读 artifact。compact 不再二次持久化或生成假 ref。

### 竞品取舍（证据固定于 2026-07-18）

- Claude Code 为闭源实现；公开 [changelog @ `07dcb0e`](https://github.com/anthropics/claude-code/blob/07dcb0e13580b21174ff1bf6a7e1d5ead3b61d60/CHANGELOG.md) 只能确认其已处理大 Shell 输出的无界 RSS 和 MCP 结果持久化阈值；不臆测其内部结构。
- Codex [model formatting @ `2895d82`](https://github.com/openai/codex/blob/2895d82b5e449407712439ba4f89954f3fa0c7e3/codex-rs/core/src/tools/mod.rs)、[truncation utility](https://github.com/openai/codex/blob/2895d82b5e449407712439ba4f89954f3fa0c7e3/codex-rs/utils/output-truncation/src/lib.rs) 与 [1 MiB/stream app-server contract](https://github.com/openai/codex/blob/2895d82b5e449407712439ba4f89954f3fa0c7e3/codex-rs/app-server/README.md) 证明捕获和模型投影应分层，并保留首尾。
- OpenCode [truncate service @ `3476e6b`](https://github.com/anomalyco/opencode/blob/3476e6baa5a7296e37136c8b7d740c62174178f9/packages/opencode/src/tool/truncate.ts) 使用 50 KiB/2,000 行、完整文件、Read/Grep 恢复和 7 天独立清理。借鉴 artifact/恢复/retention，不复制绝对路径暴露和整串入内存。

最终方案组合三者优点，并按 ArchCode 的 Project、Session family、SSE、compact 和 Web UI 边界实现。非目标：数据库、内容寻址、二进制/图片 artifact、live log tail、持久跨-artifact 索引、用户可配置限额，以及 Agent/权限/QueryLoop/Goal/HITL/Automation 的重构。

## Plan

1. 在 protocol/agent-core 中落地 strict `RawToolResult -> FinalizedToolResult`、`RegistryExecutionOutcome`、`ToolOutput`、details/presentation、`HitlBoundaryCodec` 和 system-result constructor；迁移 reducer、SSE、tool batch、错误 helper 与 restart recovery。
2. 把 ToolRegistry 改成唯一 finalization owner：blocked 零次、result 恰好一次，ask-user 回答和所有 system result 也重新进入 Registry；创建/注入 capture sink，运行 execute/after hooks，调用 redaction+artifact+projection finalizer，再运行 audit/logger。
3. 在 `packages/agent-core/src/tool-output/` 实现 canonical adapter、capture/redaction、generation-fenced artifact-store、bounded query lease、projection 和 strict errors；ProcessRunner 只依赖带等待上限的 bounded byte sink。
4. 按 policy matrix 一次性迁移所有 builtin、session-extra、GitHub 和 MCP descriptors；source tools 补齐 nextInput，process tools 明确 passthrough/transform canonical adapter，BinaryManager 增加 ast-grep stream probe，Bash 保留各终态的已产生输出，`web_fetch.maxLength` 直接删除。
5. 接入 Runtime start/dispose、Session subtree deletion 和 unregister 语义；增加共享 read/search methods 与固定 Server routes。
6. 迁移 model/full-history、compact、DCP、original-range、background_output、memory extraction、Goal evidence、ToolCard/CompressionBlock；Web viewer 使用同一 cursor/search API。
7. 删除 `persist-output.ts`、truncate hook、tool-output-cache、`view_tool_output`、Agent quota flag/触发、`fullOutputPath`、旧 marker 解析和全部旧 exports/tests。
8. 完成 unit/integration/architecture/Web tests，再跑真实 Bash、timeout、刷新、进程重启、compact 后 family search、TTL/eviction 和跨 family 拒绝的完整用户故事。

## Acceptance Criteria

AC-01 至 AC-10 必须全部通过；任一缺失即为 `NOT_DONE`。Reviewer 必须给出逐项源码、搜索和测试/运行证据。

### AC-01：类型与 finalization 唯一

- descriptor/after-hook 只返回 strict `RawToolResult`；Registry 对 raw result 恰好一次产出 finalized settled result，对 blocked finalization 零次且不产生 settled event；control sidecar 不进入 Session。permission/schema/doom/cancel/recovery 合成结果只使用 bounded constructor。
- ask-user 初次调用只产生 bounded blocked；answer/cancel 经 `Registry.resumeBlocked` 变成 raw result 后恰好 finalization 一次。scheduler、HITL route 与 recovery path 均不能直接构造/append finalized result；request、permission、全部四类 response、delivery 和完整 record 只通过同一 `HitlBoundaryCodec`。secret fixture 可继续但只有 marker 被 HTTP/queue/batch 持久化；脱敏后 shape/字段/总量无效时三处均零写入。
- settled event/part/batch 成功与失败均使用 strict `ToolOutput`；裸 string、`string | ToolExecutionResult`、`errorMessage`、任意 result meta 均不存在。batch recovery/manual-inspection 与 pending/running lifecycle fields 也必须经过 strict bounded schema，不能成为第二条输出通道。
- finalizer/sink failure 在 attempt 前后分别产生 bounded error / `unknownResult`，不返回原始正文；serialized output、details、recovery 分别满足锁定上限。单次 model projection 含 preview/details/recovery 的总序列化大小不超过 50 KiB 且不含 presentation。source nextInput 深度脱敏后仍通过目标 strict schema；Tool input 仍是 resolved+redacted。没有正文、secret、路径或 control 可借 details/recovery 绕过 Output Plane。

### AC-02：policy 穷尽且无隐式降级

- architecture test 对 `BuiltinToolName`、session-extra、8 个 GitHub tools 与 dynamic MCP adapter 做穷尽断言，集合与 policy matrix 完全一致；descriptor 缺 policy 不能编译/注册。
- `source` 从不产 artifact，`artifact` 只在超 preview 上限时落盘，`inline` 超限稳定返回 `TOOL_OUTPUT_POLICY_VIOLATION`；不存在 default、自动换 policy 或失败后返回原始大串。
- 两个恢复工具对全部八类 Agent 可见，`view_tool_output` 不再进入任何 model-visible surface。

### AC-03：捕获有界且进程不被输出反压卡死

- 256 MiB synthetic stdout + 256 MiB synthetic stderr 测试证明：每流 ring `<=1MiB`、每流 decoder+redactor+queue `<=64KiB`、双流总内存 `<=2MiB+128KiB`；queue wait `<=1s`、finalize wait `<=5s`，达到 cap 或 sink reject/永不 resolve/超时均切到 discard 并读取到 EOF，不调用 reader cancel。
- ProcessRunner 只依赖通用 sink interface；server files、binary、LSP、worktree、version-control、AST/Git 的现有行为回归通过。
- Bash、`git_diff` 和 `ast_grep_search` 的大输出测试证明各 canonical adapter 全部流入 sink，`<=64MiB` canonical 可通过 cursor 完整读取，且 Session/model 无同量级 string；inline preview 与 artifact read 来自同一 canonical stream。AST search/replace 使用 `--json=stream`，旧 normalized 大对象不存在，replace tokenizer state `<=64KiB`，超过 1 MiB/record、10,000 matches、1,000 files 或 4 MiB path bytes 时 mutation 数为零。
- 一个会通过旧 `--version` 检查但不支持 stream 的 fake PATH ast-grep 必须被拒绝并选中 manifest `0.42.3`；固定 binary probe 失败则返回稳定 binary error，源码不存在 array-mode fallback。
- writer/finalizer 在 5 秒后才 resolve 的 fake-clock 测试证明 generation 已 revoke：没有 committed artifact/ref、没有 late rename/结果改写，writer settle 后没有 temp 残留。

### AC-04：artifact、cursor 与 search 可证明正确

- `<=64 MiB` canonical 内容经连续 cursor 无重叠/缺口读完；超长 UTF-8 行可跨 page 继续，非法 UTF-8 fixture 只以 `U+FFFD` 出现且 observed/canonical bytes 准确。多字节字符正跨 63 MiB head、1 MiB tail 和 50 KiB page/preview 截点时，实际 head/tail 只收缩、不产生额外 replacement，gap/omitted 仍准确。
- partial artifact 的 read/search 明确 segment/gap，不跨 gap 匹配；单行 64 MiB/超长 match 的 search 内存有界且 snippet `<=1KiB`；`^`、`$`、`a*` 以 limit=1 跨页均无重复并在 EOF 终止。灾难性 regex fixture 在单次调用 5 秒内终止并返回 timeout，空/CRLF/multiline pattern 与 invalid cursor 返回锁定错误码。
- `output_search` 带 ref 搜单 artifact，不带 ref 搜当前 family 并返回 ref；所有 cursor 均绑定 authorization scope/ref/pattern。family query lease 期间并发 finalize、last-access 和 LRU eviction 不造成重复/跳项，新 artifact 只进入下一次查询；5 分钟、10,000 refs/lease、40,000 pinned refs/global、64 leases/global、8/family、quota 撤销及 terminal release 均可测，失效 cursor 返回锁定错误码。所有响应同时满足 item/line 与 50 KiB content 上限。

### AC-05：授权与生命周期一致

- 同 root family 的父/子可读；跨 Project/另一 root family 返回 `TOOL_OUTPUT_FORBIDDEN`。producer child subtree 删除只删除该 subtree artifacts；root family 删除全删。
- Project unregister 前后 Session/artifact 均保留；另一个 Project 占用旧 slug 后，原 workspace 以新 slug 重新注册，基于 `SHA-256(realpath(workspaceRoot))` 的 identity 不变且未过期 ref 可用。不得把 unregister 偷换成数据 purge。
- fake clock/小配额测试覆盖 body 的 500 MiB/10,000 active 双 quota、ledger 的 100,000 entries/64 MiB 双 quota、无可用 slot 的 fail-closed admission、read-time TTL、lastAccess LRU、finalize 后即时 quota、启动/每小时 cleanup、stale temp、producing 保护、timer dispose、并发 commit；TTL 优先于 lease，压力顺序为撤销最旧 lease 后淘汰未 pin completed body；tombstone 在锁定窗口内稳定区分 expired/evicted/not-found，producer deletion 直接得到 not-found。

### AC-06：任何持久/展示边界都只有脱敏内容

- assignment/token 每个 chunk split，以及 provider apiKey/header/queryParam、MCP URL/header、GitHub resolved token、server password 的非 assignment literal 测试，在 temp/body/metadata/tombstone、preview/details、Session、SSE、model、HTTP、DOM、audit/logger 中均找不到原值；8 bytes/16 KiB/256 条/64 KiB aggregate 边界均覆盖，过短、过长、过多或总量超限配置启动失败。
- throw、before/after-hook、sink write/finalize failure 均在写日志前脱敏；扫描失败现场时不存在 raw temp、raw exception/stack、MCP URL/header 或 artifact path。
- outputRef 恰好为 128-bit CSPRNG 的 22-char base64url；body/strict metadata 通过临时目录整体 rename 提交，任何消费者都拿不到真实 path。

### AC-07：source 与 one-shot 工具没有静默丢失

- source matrix 中六个工具自身满足 50 KiB/2,000 行并提供 schema-valid nextInput；分页能到达首 page 外 sentinel，且结果永远没有 outputRef。grep/glob 按稳定 path/position 排序并使用严格前进的 offset cursor，明确返回 `snapshot: false`。
- `web_fetch.maxLength` schema/实现/文案为零；5 MiB response body 硬上限保持，超过模型 preview 的已提取正文通过 artifact 恢复。
- artifact/inline matrix 每个 group 至少一个边界测试，MCP adapter、GitHub connector 与 LSP transport 分别证明 parse/serialization 前 8 MiB cap，web 保持 parse 前 5 MiB cap；超限时没有无界中间对象。

### AC-08：所有消费者共享同一事实

- model/full-history、DCP fingerprint/error grouping/original-range、background_output、memory extraction、Goal evidence、ToolCard/CompressionBlock 只消费统一 preview/details/ref，不读取 artifact path/body。
- hard compact 不新建 artifact、不改 ref/计数；post-compact model context 确定性提示 family artifact 数量。E2E 不重新注入 ref，只凭该提示调用 family `output_search` 找回 sentinel/ref。
- 浏览器刷新与真实 Runtime 进程重启后 ref 可用；TTL/quota 后 UI 显示明确 expired/evicted，不空白、不无限重试。

### AC-09：Hard cut 无兼容层

- architecture scan 固定覆盖 `packages/agent-core/src`、`packages/protocol/src`、`apps/server/src`、`apps/web/src`。对 `fullOutputPath`、`view_tool_output`、`createOutputTruncator`、`persistToolOutput`、`enforceToolOutputQuota`、`ToolOutputCache`、`[Output truncated; full output saved to:` 七个 literal 分别执行 fixed-string 搜索（等价于 `rg -F`，不得拼 regex）；每次都精确排除 `!**/*.test.ts`、`!**/*.test.tsx`、`!**/*.integration.test.ts`、`!**/__arch__/**`，生产源码结果必须为零。
- 旧实现文件/exports/tests 全删；不存在旧/新 schema union、旧 Session parser、migration、alias、双写、feature flag、compatibility/fallback path。
- fixtures 直接改为新 strict schema。验收使用 isolated HOME/QA Project，保留其 config，先删除旧 tool-output 与 QA `.archcode` runtime state；生产代码不迁移或自动兼容旧数据。

### AC-10：真实用户故事与全仓验证通过

- isolated E2E Bash 依次输出 `HEAD_SENTINEL`、大正文、`ERROR_SENTINEL`、`TAIL_SENTINEL`：模型/ToolCard 看到 head+tail/ref，search/read 找到 error 附近；浏览器 reload、真实 server process restart、hard compact 后 family search 重复成功。
- timeout fixture 先输出 `PARTIAL_SENTINEL` 再挂起：最终为 error/timeout，UI、模型和 artifact 均保留 sentinel 与 timeout details。
- Browser interaction 断言 `tool-output-open`、`tool-output-viewer`、`tool-output-expired` 三个稳定 test id；目标 unit/integration/architecture/Web tests 通过。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码 0；Reviewer 对 AC-01 至 AC-10 全部给出 `DONE` 才能完成 Goal。
