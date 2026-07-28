# Bash 实时输出统一事件计划

## Objective

让正在运行的 `bash` Tool 在现有 ToolCard 中持续显示 stdout/stderr，同时保持 ArchCode 当前的事实边界：

- 实时内容只是运行中的有界预览；
- `tool-result` 仍是唯一最终结果，现有 Tool Output Plane 仍负责 preview、artifact、错误和恢复；
- 后端一旦形成 `FinalizedToolResult`，必须先持久化到 SessionFile 才能向客户端发布，并在 ring 淘汰、SSE 断线和 Runtime 重启后仍可由权威 snapshot 恢复；
- 实时事件进入现有 Session Store、占用 Session event ID，并通过现有全局 SSE 到达 Web；
- 不新建 Store、SSE route、数据库、日志协议或第二套工具状态。

本 Goal 只做“执行后的 stdout/stderr 实时显示”，不做 LLM 尚未生成完整参数时提前调用 Tool。
这里的“最终不丢”指既有 Tool Output Plane 定义的有界 `FinalizedToolResult` 业务事实，不扩大为无限原始 process log；未形成 terminal result 的运行中 partial output 没有持久化或跨重启恢复承诺。

## Evidence and Decisions

### 当前架构

- `ProcessRunner` 已通过 `ProcessOutputSink` 排空 stdout/stderr；`BashCanonicalOutputSink` 已负责串行化两路输出并写入 `STDOUT/STDERR/EXIT_CODE` 标签。
- Registry 在执行前创建 `StreamingToolOutputCapture`，执行后由 `ToolOutputFinalizer` 恰好一次产出 `FinalizedToolResult`。
- Session Store 已统一完成 event ID 分配、`MAX_EVENTS = 10_000` rolling ring、reducer 投影和 Global SSE 发布；Web Store 使用相同 reducer，并在 SSE 重连时刷新 Session snapshot。
- 既有 [Tool Output Plane Goal](./tool-output-plane-hard-cut-plan-goal.md) 把 live log tail 列为当时非目标。本 Goal 只补上实时投影，不重开 artifact、finalization 或权限架构。

### 竞品源码结论（核对于 2026-07-28）

- Codex `3418498f` 使用 `item/started -> outputDelta -> item/completed`，明确要求最终 `aggregatedOutput`/completed item 为权威结果；output delta 是 transient、non-durable，并对单次命令最多发送 10,000 个 delta。见 [app-server contract](https://github.com/openai/codex/blob/3418498f01422f5f650ea645d4bd19e05c3a9616/codex-rs/app-server/README.md#L1444-L1506)、[rollout policy](https://github.com/openai/codex/blob/3418498f01422f5f650ea645d4bd19e05c3a9616/codex-rs/rollout/src/policy.rs#L121-L153) 和 [exec cap](https://github.com/openai/codex/blob/3418498f01422f5f650ea645d4bd19e05c3a9616/codex-rs/core/src/exec.rs#L72-L80)。
- OpenCode `3cc70160` 在 shell chunk 到达时更新同一个 running Tool Part，经过 Session update/event/projector 到客户端 Store；其当前实现会持久化这些 PartUpdated events，而 SSE 自身不设置 `id`，重连依赖 `server.connected` 后刷新。见 [shell metadata](https://github.com/anomalyco/opencode/blob/3cc70160deb0eda7f67fbf5b0c0780000f5c342d/packages/opencode/src/tool/shell.ts#L438-L529)、[Tool Part update](https://github.com/anomalyco/opencode/blob/3cc70160deb0eda7f67fbf5b0c0780000f5c342d/packages/opencode/src/session/tools.ts#L59-L80)、[event persistence](https://github.com/anomalyco/opencode/blob/3cc70160deb0eda7f67fbf5b0c0780000f5c342d/packages/core/src/event.ts#L315-L349) 和 [SSE](https://github.com/anomalyco/opencode/blob/3cc70160deb0eda7f67fbf5b0c0780000f5c342d/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts#L16-L54)。

取舍：采用 Codex 的“transient delta + final authoritative”，采用 OpenCode 的“更新同一 Tool Part”，但复用 ArchCode 已有 event ID/ring/SSE，不复制 OpenCode 的逐 chunk durable 写放大。

## Locked Architecture

### 1. 唯一数据流

```text
ProcessRunner bytes
  -> BashCanonicalOutputSink
  -> StreamingToolOutputCapture canonical chunk
  -> LiveToolOutputPublisher (100 ms coalesce)
  -> SessionStore.append(tool-output-delta)
  -> existing event ID + EventRing + Global SSE
  -> shared protocol reducer
  -> running Bash ToolPart.liveOutput
  -> existing ToolCard

terminal:
Registry finalization
  -> optional artifact commit
  -> durable toolBatches[].calls[].result checkpoint
  -> SessionStore.append(tool-result) + existing SSE
  -> same ToolPart completed/error

restart repair:
durable tool-batch result -> missing settled ToolPart projection -> persist -> first snapshot
```

实时 publisher 只能观察由 `BashCanonicalOutputSink` 标记为 live-eligible、且已经过 capture incremental UTF-8 canonicalization 和既有落盘前 policy 的 chunk；finalizer/hook 普通写入不触发 observer，禁止从 `ProcessRunner` raw bytes 另接旁路。实时发布失败只关闭实时预览，不得阻塞 pipe drain、Tool 执行、capture 或 finalization。

浏览器/SSE 中断不能取消后端 capture、finalization 或最终持久化：只要后端成功写入 durable tool-batch result checkpoint，重连必须从 Session snapshot 得到它。若 Runtime 或 Tool 在 checkpoint 前中断，则 ring delta、`liveOutput` 和临时 capture 可以丢弃；重启后不得把 partial output 伪造成 final。

### 2. 严格协议与状态

新增一个 strict event：

```ts
type ToolOutputDeltaEvent = {
  type: "tool-output-delta";
  toolCallId: string;
  toolName: "bash";
  delta: string;
  omittedBytes: number;
  liveLimitReached: boolean;
};
```

- `delta` 是已 canonicalize、保持 Bash 标签和到达顺序的文本；每个 event 最多 4 KiB UTF-8。
- publisher 每 100 ms 最多 append 一次；窗口内超过 4 KiB 时只保留最新的 UTF-8 完整后缀，并通过 `omittedBytes` 明示本窗口未发送的 canonical bytes。
- 单次 Bash 最多发布 10,000 个 delta；另外，publisher 在每次 append 前读取 Session 的 `nextEventId - publishableNextEventId`，不得让自己把 unpublished suffix 推过 `MAX_EVENTS`。任一上限将触发停止；尚有最后一个安全 slot 时，该 event 设置 `liveLimitReached: true`。ProcessRunner/capture/finalization 继续，UI 明示“实时预览已到上限，最终结果仍在收集”。
- `RunningToolPart` 新增 transient `liveOutput: { preview: string; omittedBytes: number; liveLimitReached: boolean }`。reducer 只接受匹配的、仍在 running 的 Bash part；preview 始终保留最新 50 KiB UTF-8 后缀，超出的 bytes 累加到 `omittedBytes`；`liveLimitReached` 一旦为 true，在 `tool-result` 清除整个 live state 前保持 true。
- `CompletedToolPart` 和 `ErrorToolPart` 不允许 `liveOutput`。`tool-result` 到达时原子清除实时状态并显示 finalized result；model/full-history projection 与 finalized-result hooks 均不得消费 `tool-output-delta/liveOutput`。
- 新增无 `result/liveOutput` 的 `InterruptedToolPart`。除 `waiting_for_human` 外，`execution-end` 把仍为 pending/running 的 ToolPart 转为 interrupted；重启 repair 对被判定为 interrupted 的 Execution 做同样转换。该状态只说明“没有 durable final”，model/full-history projection 忽略它，UI 不再显示永久 running。
- strict `ToolResultEvent` 与 result-bearing（`completed | failed`）`SessionToolBatchCall` 同时新增必填 `settledAt: number`。scheduler 为每个 call 只生成一次该时间并同时写入 checkpoint/event；正常 append 与 load repair 都用它生成 `startedAt/endedAt`，不得再以 event envelope 或 batch `updatedAt` 代替。

这些常量为内部安全边界，不增加配置项。

### 3. Store、ring 与持久化

- `tool-output-delta` 必须调用普通 `SessionStore.append`，获得普通递增 event ID，进入现有 10,000-event rolling ring，并由现有 SessionEventBridge/Global SSE 发布；不得 direct-emit SSE。
- event ring 硬切为纯运行时传输窗口：从 SessionFile 和公共 Session detail 中删除 `events`；SessionFile 独立、必填地持久化当前 `promptTraces`，加载时不得再从 ring event 重建 Prompt trace。其他 canonical 状态继续由 messages、executions、steps、toolBatches 等现有 snapshot 字段持久化。
- delta 不触发 Session 持久化；持久化投影必须删除 running part 的 `liveOutput`。`eventCursor` 在 SessionFile、公共 Session detail 和完整权威 snapshot 中必填；加载固定使用 `eventCursor + 1` 初始化空 ring，删除完整 snapshot 从 `events` 推断 cursor 的 fallback。
- `toolBatches[].calls[].{result,settledAt}` 是 Tool final 的唯一 durable authority；settled ToolPart 是供 UI/model 使用的 projection。optional artifact 先 commit，scheduler 再通过 `updateToolBatches` 原子保存完整终态，成功后才能 append 带同一 `settledAt` 的 `tool-result` 并进入 SSE；checkpoint 保存失败时不得 append、不得发布 terminal success。
- `tool-result` event 本身不新增 durable-control barrier。checkpoint 后 append 产生的 messages 保存可以异步；若 Runtime 恰在 checkpoint 与 append/消息保存之间中断，Session load 必须在暴露第一个 snapshot 前按固定顺序 repair：先扫描唯一 active durable batch 中带 result 的 calls，把对应 pending/running/interrupted projection 都视为未完成 projection，并通过共享 reducer 和该 call 的 `settledAt` 升级为 settled、恰好一次更新 `stats.tools.completed/failed`；相同 settled no-op，不同 settled 才按损坏拒绝加载。完成 checkpoint repair 后，才把其余没有 durable result 的 pending/running ToolPart 转为 interrupted，并一次持久化。repair 不扫描 archived batches，不能复活已 compact 的历史；也不伪造 SSE event 或占用新 event ID。现有 scheduler 内的 missing-result fallback 随之删除，避免两个 repair owner。
- 所有生产 `tool-result` 必须收敛到 scheduler 的一个 checkpoint-first commit 函数：正常、system/recovery 和 cancel 复用它。删除 QueryLoop 在“无 active batch”时直接合成/append `TOOL_RESULT_UNKNOWN` 或 `TOOL_NOT_EXECUTED` 的路径；checkpoint 前遗留 ToolPart 只能进入 interrupted non-final state，不能制造第二 durable authority。
- SessionStoreManager 为每次排队持久化分配内部单调 revision，并记录最后成功 revision。`getSessionReadSnapshot()` 必须循环执行“捕获目标 revision → 等待该 revision durable → 同步读取 state 并确认 latest revision 未变化”；若变化则重试，若目标保存失败则返回错误。最终 revision check 是 snapshot 的线性化点，避免 `flush` 返回与 `getState()` 之间插入新 checkpoint 的 TOCTOU。checkpoint 已成功后，SSE 中的 final 即使早于 messages 二次落盘也仍有 durable authority。
- event ID 只保证同一 Runtime 内单调；server crash 后，尚未持久化的 transient ID 可以回退。Global SSE 断线、`lagged` 或 `shutdown` 时，现有 Web Session Store 进入带 generation 的“等待权威 snapshot”恢复门：先缓冲同 generation 的新 SSE，不做旧 cursor 比较；只有当前 generation 的完整 snapshot 可以用更低 cursor 完整替换 reducer 投影并清空旧 `liveOutput`。随后丢弃 `<= snapshot cursor` 的重复项；仅当剩余 buffer 为空或首个 ID 恰为 `cursor + 1` 时才顺序 drain 并解除恢复门。若 snapshot 请求失败、现有 1,000-event buffer 溢出、剩余首个 ID 不连续，或旧 generation snapshot 迟到，则丢弃无效 buffer/snapshot、保持恢复门并请求更新的权威 snapshot，禁止静默跳号或边用旧状态边吞新事件。
- 局部 child metadata patch 与完整 snapshot 分成两个明确入口；metadata patch 不需要 cursor，也不能解除恢复门。
- 不增加 terminal 专用 ring 剪枝。server/Web 继续只使用现有 `MAX_EVENTS = 10_000` rolling eviction 和 publication barrier；缺失的 transient delta 不补写、不重放、不伪装成完整历史。

`MAX_EVENTS` 保持 10,000，但语义写准为 publication barrier 解除后的稳态上限，而不是任何时刻的绝对硬上限：barrier 未解除时，Store 不能删除未发布后缀，现有非 live event 仍可能令 ring 临时超过上限；barrier 解除后立即剪回 10,000。新增 live publisher 以 Session unpublished suffix 为共享预算，因此 live delta 最多把该后缀填到 10,000，不会继续放大持久化停顿；100 ms、4 KiB/event、50 KiB preview、10,000 delta/call 和现有 recovery 共同构成这项功能的资源边界。

### 4. UI

- running Bash 收到首个 `liveOutput` 后自动展开现有 ToolCard terminal surface；用户手动折叠后，本次运行不再强制展开。
- terminal 显示最新 preview、`Live` 状态，以及非零时的 `N B earlier output omitted`；达到 10,000-event 上限时显示预览暂停提示；不显示假的 exit code。
- final result 到达后同一卡片无闪烁地切换为现有 `ShellOutput`，以 finalized preview、omitted、artifact 和 process details 为准。
- 长行保持当前可横向/换行阅读行为；更新不得抢焦点、重置用户折叠状态或造成整条 Execution timeline 重挂载。

### 5. Scope and Hard Cut

本期只允许 `bash` 产生实时输出。非目标：Tool 参数流式执行、PTY/交互终端、stdin、其他 Tool/MCP、完整日志直播、跨重启恢复 partial log、无限原始 process log、新 SSE/Store/数据库、用户配置、修改既有 finalized artifact 的大小/保留 policy 或提高 `MAX_EVENTS`。

这是单一协议硬切：不存在 feature flag、旧/新 event union、dual write、alias、兼容 parser 或 fallback transport。SessionFile/完整 Session snapshot 的 `eventCursor` optional/fallback、SessionFile `events`、从 event 恢复 Prompt trace 的路径一次删净；局部 metadata patch 不属于完整 snapshot。fixtures 直接更新为新 strict contract。只保留正向行为/架构测试，不增加为旧名称或旧路径站岗的墓碑测试。

## Plan

1. 在 protocol 中加入 strict `ToolOutputDeltaEvent`、running `liveOutput`、non-final `InterruptedToolPart`，并让 `ToolResultEvent`/result-bearing batch call 必填同一个 `settledAt`；reducer/guard 明确 settled/interrupted 都丢弃 transient state，且 model projection 不读取 live/interrupted 内容。
2. 在 `tool-output/` 增加小型 `LiveToolOutputPublisher`：fake-clock 可测的 100 ms coalescing、4 KiB UTF-8 safe delta、10,000-event per-call cap、Session unpublished-suffix 共享预算、omitted 计数、flush/dispose；capture 为写入携带内部 live-eligible source 标记，只有 `BashCanonicalOutputSink` 标记的 chunk 在 canonicalization 后触发 observer，finalizer/hook 的普通写入永不触发。
3. QueryLoop 只为 Bash context 注入 publisher；Registry 在返回 settled outcome 前 flush/dispose，确保最后一个 delta 的 event ID 严格早于 `tool-result`。scheduler 用一个 checkpoint-first commit 函数覆盖 normal/system/cancel，单次生成 `settledAt`，保持 artifact commit → durable tool-batch 终态 checkpoint → 同时间戳 append/SSE 的最终顺序；删除 QueryLoop direct synthetic-final 路径。
4. 把 ring 收敛为纯运行时状态：SessionFile 删除 `events`、独立必填持久化 `promptTraces`、`eventCursor` 成为完整 snapshot authority；加载以 cursor 建空 ring，严格按“active durable result 升级 projection/stats → 其余无 result ToolPart 标记 interrupted”的顺序一次修复并持久化，删除 scheduler 的重复 repair owner，持久化投影剥离 `liveOutput`。
5. 在 SessionStoreManager 增加内部 persistence revision fence；完整 Session snapshot 只能在线性化确认其所读 state 已被成功持久化后返回。
6. 在 Web Store/SSE context 增加同 Store 内、带 generation 的权威恢复门，并拆开 metadata patch 与完整 snapshot；断线/lagged/shutdown 后允许完整 snapshot 向后重置 cursor，只有 buffer 未溢出且从 `cursor + 1` 连续时才 drain，否则丢弃并重新取更新 snapshot。
7. 改造 ToolCard：running live terminal、首次自动展开、手动折叠优先、达到 live cap 的提示、terminal 到 final 的原位切换；保持 artifact viewer 和 settled error 逻辑不变。
8. 补齐 protocol/store/capture/query/Web unit tests、真实延迟 Bash integration 和 Browser interaction QA；最后执行全仓验证。

## Acceptance Criteria

以下 AC-01 至 AC-07 必须全部为 `DONE`，否则 Goal 未完成。

### AC-01：只走统一 Session 事件架构

- 真实 Bash 先输出 `FIRST_SENTINEL`，等待至少 300 ms，再输出 `LAST_SENTINEL`；在进程结束前可观察到至少一个 `tool-output-delta`，每个都有普通连续 Session event ID，并经现有 Global SSE 到达 Web。
- 生产代码不存在 live-output 专用 SSE route、EventSource、Store、数据库表或绕过 `SessionStore.append` 的 direct emit。
- `tool-result` 的 event ID 大于该 call 的所有 delta ID，且仍由现有 Registry/finalizer/scheduler 路径产生；对应 `toolBatches[].calls[].result` checkpoint 已在 append/SSE 前持久化。

### AC-02：输出顺序、UTF-8 与资源边界确定

- fake-clock 测试证明 100 ms 内任意 chunk 数最多产生一个 event；`flush()` 会立即发送剩余内容，`dispose()` 后不再发送。
- stdout/stderr 交错 fixture 的 live 文本保持 `BashCanonicalOutputSink` 顺序和标签；多字节字符跨 raw chunk、4 KiB delta 和 50 KiB preview 边界时无额外 `U+FFFD`、无半字符。
- 高吞吐测试证明单 event `delta <= 4 KiB`、running preview `<= 50 KiB`，丢弃量可由 UI 明确看到；单次 Bash 的第 10,000 个 event 标记上限且之后零 delta。另一个人工 barrier 测试证明多个并发 publisher 共享 Session unpublished-suffix 预算：最后一个安全 delta 标记上限，live delta 不把该 suffix 推过 10,000；工具执行和最终 capture 不受 publisher 慢、抛错、预算耗尽或关闭影响。

### AC-03：同一 Tool Part，final 结果唯一权威

- delta 只更新匹配的 running Bash part；未知 call、错误 toolName、pending/settled part 和迟到 delta 都是 no-op。
- success、nonzero、timeout、abort、signal、capture failure 六种 terminal path 均先 flush/关闭 publisher，再以一个 finalized `tool-result` 清除 `liveOutput`；settled part 不含 transient 字段。
- spawn failure、execute-before-output throw 和 finalizer 合成 text 均产生零 delta，只显示 finalized result；只有 `BashCanonicalOutputSink` 的 live-eligible 写入可触发 observer。
- 最终 ToolCard 内容逐字来自 `FinalizedToolResult.output.preview`，artifact/ref、omitted 和 process details 与未实现实时功能前相同。结构性测试证明 `tool-output-delta/liveOutput` 不进入 model/full-history projection，也不改变 finalized-result audit/logger hook 输入；用一个不在 finalized preview 中的人工 delta 验证模型投影不可见。
- 串行/并行 call 测试证明 batch call 与 `tool-result` 使用完全相同且各自独立的 `settledAt`；正常 append 和 load repair 产出的 settled ToolPart 逐字段一致。缺失 projection 时共享 reducer 恰好增加一次 completed/failure stats，已有相同 projection 时不重复计数，冲突 projection 时 strict fail。
- fault-injected checkpoint 测试证明 `updateToolBatches` 保存失败时不会 append `tool-result`、不会进入 SSE，也不会出现在 snapshot。checkpoint 成功后分别在 append 前和 messages 二次保存前模拟 crash；两种情况重启加载都必须在首个 snapshot 前由 batch result 补齐并持久化。浏览器在收到首个 delta 后断开、后端正常完成再重连，也必须得到同一 final。
- 无 active batch 的 pending/running ToolPart 在 execution terminal/restart 后变为 interrupted，清空 `liveOutput`、没有 `result`、不增加 completed/failed stats，也不进入 model projection；实现不得再为它合成 `TOOL_RESULT_UNKNOWN`/`TOOL_NOT_EXECUTED` final。

### AC-04：ring、cursor 与重启语义无歧义

- 运行中 delta 占普通 ID 且可在 server/Web 内存 ring 中观察；SessionFile/Session detail 都没有 `events`，SessionFile 没有 `liveOutput`，也不会因每个 delta 产生一次写盘。
- `eventCursor` 在 SessionFile、公共 Session detail 和完整 snapshot 中必填；加载只使用它建立空 ring。局部 metadata patch 走独立入口，不伪造 cursor。
- 正向持久化测试执行 `prompt-trace -> 多个 transient delta -> SSE disconnect -> durable batch final -> ring eviction -> restart`，重启后 Prompt trace、既有有界契约内的 final result 和 artifact/ref 完整，ring 为空并从持久 cursor 后继续分配；另一个 `Runtime 在 durable batch final 前中断` fixture 证明 partial delta 不落 SessionFile，重启后不伪造 final。
- snapshot revision-fence 测试在 checkpoint save 和 messages save 两处人为挂起，并覆盖“旧 revision 刚完成、读取 state 前同步排入新 checkpoint save”的交错：读取必须等待覆盖最终所读 state 的 revision；成功后返回 durable state，失败时返回错误，不能把未落盘 live state 当成权威 snapshot。
- Browser/store 测试执行 `收到高 ID delta -> server crash/断线 -> 较低 cursor 权威 snapshot -> 清除 partial preview -> 缓冲事件按新 cursor drain -> 后续 final/new event 正常接收`；同样覆盖 `lagged`、`shutdown`、snapshot 请求失败、恢复期 buffer 超过 1,000、snapshot 后首个剩余 ID 不连续，以及旧 generation snapshot 迟到。后三类竞态必须保持恢复门、丢弃无效数据并重新取更新 snapshot，不得静默 drain；系统不承诺补发已丢 transient delta。
- 人工延迟 durable publication barrier 并交错 delta/final 的测试证明仍由现有 barrier 保序，rolling eviction 不删除未发布事件；barrier 期间 ring 可因不可删除的非 live event 临时超过 10,000，解除后立即剪回 10,000。实现不存在 terminal 特判剪枝，也不把稳态上限误验成绝对硬上限。

### AC-05：UI 行为可操作且稳定

- Browser interaction 证明：首个 live delta 自动展开 Bash 卡片并显示 `Live`；用户折叠后后续 delta 不重新展开；展开时 omitted bytes 非零会显示；达到 cap 后显示预览暂停但 Tool 仍为 running。
- final 到达后同一 DOM ToolCard 切换为 settled output，不残留 `Live`/partial preview，不丢 artifact viewer，不抢焦点。
- individual ToolCard 与 grouped ToolRunCard 都必须穷举 `interrupted`：显示 `Interrupted`/`Stopped`，既不保留 loading 动画，也不能落入默认 `Completed` 或 `Error`；group summary/count 同样区分 interrupted。
- session reload、窄屏、超长行和连续更新下无横向页面溢出、明显跳动、console error 或 timeline 全量重挂载。

### AC-06：Hard cut 且无旁路

- SessionFile/公共 Session detail/完整 snapshot 的 `eventCursor` optional、SessionFile `events` 与“从 events 推断 next ID/Prompt trace”的生产路径删除；没有 migration、compat schema、feature flag、dual write 或 fallback。metadata patch 的无 cursor 类型与完整 snapshot 类型严格分开。
- Tool final 只认带必填 `settledAt` 的 durable tool-batch result；load-time projection/stats repair 是唯一 repair owner，scheduler 不再保留同功能 fallback。
- 结构性测试枚举生产 `tool-result` append site，只允许 scheduler 的 checkpoint-first commit；QueryLoop 和 cancel 专用 direct append 均不得存在。InterruptedToolPart 是非 final 状态，不得携带 synthetic result。
- live producer 只能由 capture 内部标记为 Bash-live 的写入在 post-canonical 阶段触发；源码审查证明 finalizer/hook 普通写入和 raw `ProcessRunner` bytes 都不能直达 Store/SSE/UI。
- 更新现有正向 tests/fixtures；不保留旧行为测试，也不新增只断言旧 symbol/文件不存在的墓碑测试。

### AC-07：验证闭环

- 目标 protocol、agent-core、server、Web unit/integration/interaction tests 全部通过；真实 Bash 用户故事覆盖运行中、成功、nonzero、timeout 和 abort。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码 0。
- Reviewer 必须逐项给出 AC-01 至 AC-07 的源码位置和测试/运行证据；任何一项只有推断、没有证据，记为 `NOT_DONE`。

## Risks

- **输出旁路泄漏**：只允许 post-canonical observer；禁止 raw pipe 直连 UI。
- **事件/内存放大**：100 ms coalesce、4 KiB/event、50 KiB live tail、10,000 delta/call 与 Session unpublished-suffix 共享预算同时生效；`MAX_EVENTS` 是 barrier 解除后的稳态上限，持久化失败期间既不删除未发布事件，也不允许 live delta 继续放大后缀。
- **transient ID 与持久 cursor 分叉**：明确 ID 只在单 Runtime 单调；断线后的 Web 恢复门必须允许权威 snapshot 向后重置并重放 buffer。
- **ring 与 durable audit 混用**：SessionFile 删除 events，Prompt trace 改为独立 canonical 字段，避免 rolling/transient 事件承担审计持久化。
- **把 partial 误当持久事实**：只有成功写入 durable tool-batch checkpoint 的 `FinalizedToolResult` 才承诺不丢；SSE/ring 断线不影响后端 final，checkpoint 前 Runtime 中断则明确不恢复 partial。
- **checkpoint 与 projection 双写错位**：batch result 是单一 durable authority；append/SSE 只在 checkpoint 后发生，load-time repair 单向重建 projection，snapshot 等待持久化队列，禁止把 messages 提升为第二 authority。
- **snapshot TOCTOU**：内部 persistence revision fence 让 snapshot 对其实际读取的 state revision 负责；一次普通 `flush()` 不算验收通过。
- **旧 synthetic-final 旁路**：无 checkpoint 的遗留 ToolPart 只允许标记 interrupted；所有真实 final 统一由 scheduler checkpoint-first commit 产生。
- **restart repair 顺序颠倒**：active durable result 永远优先于 interrupted 标记；只有没有 durable result 的残留 ToolPart 才能进入 interrupted。
- **终态竞态**：Registry 先 flush/dispose publisher，scheduler 后 append final；settled reducer 拒绝迟到 delta。
- **旧 Session 文件**：带旧 `events` 或缺少 `eventCursor/promptTraces` 的文件不会迁移或 fallback；实施与验收使用隔离 QA runtime，发布前必须把这一 hard-cut 数据风险写入 release note。
