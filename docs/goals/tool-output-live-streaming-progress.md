# Bash 实时输出 Goal 进展

对应方案：[tool-output-live-streaming-plan-goal.md](./tool-output-live-streaming-plan-goal.md)

## 当前状态

- 状态：完成
- 当前阶段：验收完成
- Goal 文档保持验收契约；本文件只记录实施进展、验证证据和风险。

## 实施记录

### 2026-07-28

- 已确认工作区当前只有 Goal 文档及无关 `.DS_Store` 为未跟踪文件；后者不纳入本 Goal。
- 已按目录边界拆分并行工作：Protocol、Web、Agent Core/Server，避免子 agent 重叠修改。
- 已锁定用户确认的数据边界：运行中 partial delta 只保留在内存 ring，允许在断流或 Runtime 中断时丢失；只有成功写入 durable tool-batch checkpoint 的最终结果承诺恢复。
- Protocol 已加入 strict `tool-output-delta`、running `liveOutput`、non-final `interrupted` 与必填 `settledAt`；共享 reducer 负责 live tail、terminal 清理和 restart/retry 状态转换。
- Bash 输出只从 capture 的 post-policy canonical 边界进入有界 publisher；publisher 复用 Session Store 普通 append、event ID、rolling ring 和 Global SSE，未增加 transport、Store 或数据库。
- 所有生产 terminal 已收敛到 scheduler 的 checkpoint-first commit：先持久化 `toolBatches[].calls[].{result,settledAt}`，再 append `tool-result`；QueryLoop synthetic final 路径已删除。
- SessionFile 已硬切删除 `events`，独立持久化 `promptTraces` 和必填 `eventCursor`；load-time repair 以 durable batch result 重建 settled projection，其余未结算 ToolPart 进入 `interrupted`。
- SessionStoreManager 已加入 persistence revision fence；Web 已加入带 generation 的权威 snapshot 恢复门和 1,000-event 有界缓冲。
- ToolCard/ToolRunCard 已支持 Bash live terminal、omitted/cap 提示、手动折叠优先、final 原位替换及 `interrupted` 穷举显示。

## 验证证据

- Protocol reducer + StoreManager 定向验证：`140 pass / 0 fail`。
- 真实 Bash 集成（success、nonzero、timeout、abort）：`4 pass / 0 fail`；验证进程结束前 delta、ID 顺序、checkpoint/result 同 `settledAt` 和 transient 不进模型投影。
- Agent Core hard-cut fixture 迁移：`312 pass / 0 fail`；Agent Core typecheck 退出码 0。
- Web 初轮验证：typecheck、`531` unit、`102` interaction 和 production build 均通过。
- Tool Output ownership 架构测试：`5 pass / 0 fail`，确认 live append、terminal append 与 Bash live capture 各只有一个生产 owner。
- 全仓 `bun run typecheck`、`bun run test`、`bun run build` 均退出码 0；第二轮全仓测试为 `8/8` workspace 成功，Agent Core unit 为 `2689 pass / 0 fail`，全部 integration/architecture lane 通过。
- `git diff --check` 退出码 0。
- 真实 Browser interaction QA 已通过：首个 Live 自动展开、手动折叠后增量不重开、final 原位替换并保留 artifact 入口、individual/grouped interrupted 正确；379 px 窄屏长行无页面溢出，连续更新后 console 无 error/warn。临时 QA harness 已删除，未进入交付物。
- 第一轮独立 `gpt-5.6-sol` `xhigh` review 发现一个真实恢复缺陷：authoritative snapshot 正常请求及默认 retry 均失败后，Web Store 会保持 recovery gate，但低流量下不会再次请求更新 snapshot；同时指出 AC-02/03/04 缺少直接 fixture。
- Web 阻断已修复：打开中的 root/focused Session 各自持有唯一恢复 retry controller，只在 Query 已 terminal failure、对应 Store 仍 awaiting 时按 `1s → 2s → 4s → 8s → 15s` 封顶重试；成功、新 generation 或卸载会取消旧 timer，普通非恢复查询仍使用原有限 retry。Web `535` unit、`102` interaction 与 typecheck 通过。
- AC-02 直接证据已补齐：真实第 10,000 个 delta 标记上限、第 10,001 个零输出，并发 publisher 共享 suffix 预算，publisher 延迟/抛错/预算耗尽不阻塞 capture/final。
- AC-03 terminal matrix 已补齐：真实 signal、spawn failure、execute-before-output throw、finalizer synthetic result、capture failure 均直接验证 publisher 在 finalized hook 前停止，零伪 delta或仅保留明确 transient，durable checkpoint 与 terminal final 一致。定向集成 `9 pass / 0 fail / 113 assertions`。
- AC-04 复合 fixture 已补齐：`prompt trace → 多个 transient delta → SSE 断线 → durable final → ring 淘汰 → restart` 后 prompt trace、final、artifact/ref 完整，ring 为空且 cursor 续接；publication barrier 可保留 10,001 个未发布 event，解除后按序发布并立即裁回 10,000。
- 新增 Agent Core 证据定向验证合计 `140 tests / 517 assertions / 0 fail`，Agent Core typecheck 与 `git diff --check` 通过。
- 第二轮独立复审确认上述恢复缺陷和强 fixture 已闭环，并发现 `?focus=<root-session>` 会让同一 Session 同时持有 root/focused 两个恢复 owner；入口现已把空值和 self-focus 统一归一为 `null`，真实路由测试确认 endpoint 只请求一次。
- self-focus 修复后的 Web 验证为 `537` unit、`102` interaction、typecheck 和 `git diff --check` 全部通过。
- 第三轮独立终审为 clean、无 findings，AC-01 至 AC-07 全部 DONE；独立定向验证 `114 pass / 0 fail`、typecheck `5/5`、`git diff --check` 退出码 0。
- 最终全量 `bun run build` 再次通过（含 typecheck `5/5`、Web production build 与二进制构建），最终 `git diff --check` 退出码 0。

## 风险与决策

- 当前无待用户决策项。
- Hard cut 会使旧 SessionFile 因缺少新必填字段而无法加载；按 Goal 要求不提供 migration、fallback 或兼容 parser。
