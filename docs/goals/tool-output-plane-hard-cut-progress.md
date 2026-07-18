# Tool Output Plane 执行进度

## 当前状态

- 状态：`COMPLETE`
- Worktree：`/Users/bo/.codex/worktrees/70b0/archcode`
- Branch：`codex/tool-output-plane-hard-cut`
- 计划：`docs/goals/tool-output-plane-hard-cut-plan-goal.md`

## 执行记录

### 2026-07-18

- 完成 hard cut：唯一主链为 `Registry → ToolOutputFinalizer → FinalizedToolResult`。Raw result、blocked request 和 internal sidecar 严格分离；没有旧 schema、migration、alias、双写或 fallback。
- 输出在 capture/finalizer 边界先脱敏，再进入 artifact、Session/SSE/UI、模型投影、audit/logger。artifact 只暴露不透明 ref，`output_read` / `output_search` 提供授权且有界的恢复；`view_tool_output` 和全局 redact/truncate hook 已移除。
- tombstone strict-parser 的 6/7-key 边界已从根因修复：strict writer 与 parser 统一为 6 字段，无兼容分支；artifact tests 为 21/21 通过。
- 关键验证：全仓 `bun run typecheck`、`bun run test` 均为 exit 0；修复后标准 `bun run build` 为 exit 0；AC-09 的 7 个 fixed-string 生产源码扫描均为 zero；`git diff --check` 为 zero。
- 当前浏览器验收已验证 live `output_read` / `output_search`、页面 reload 和真实 server process restart。重启后 API 返回 `410 TOOL_OUTPUT_EXPIRED`，稳定 testid `tool-output-expired` 显示 `This output has expired.`；`tool-output-open` / `tool-output-viewer` 亦保持稳定。
- 第一轮独立 `sol(max)` Review 结论为 `NOT_DONE`，发现四类缺口，均已在本轮修复：
  - AC-04 bounded read：补齐 artifact/read 的严格页大小与 UTF-8 边界约束，避免恢复读取超出有界响应。
  - AC-06 runtime/LSP log redaction：Runtime 在构造 `SecretRedactionPolicy` 后统一注入日志安全边界；LSP client/pool/transport 的 child logger、错误与 stderr 均不再泄漏 runtime literal、workspace 或 artifact/local path。
  - AC-04 family lease validation：补齐 family scope 的 lease/cursor 校验，拒绝跨 family 或失效 lease 的读取与搜索。
  - AC-05 lifecycle fixtures：补齐 lifecycle fixture 覆盖，使 TTL/LRU、删除、重启和 tombstone 路径使用同一严格事实。
- 第二轮 fresh 独立 `sol(max)` Review 结论为 `NOT_DONE`，三个有效 findings 已完成 hard-cut 修复；其观察到的 concurrent-edit transient 是复审期间文件变化，不是代码 finding：
  - shutdown raw logger：shutdown callback 统一经过 Runtime 日志安全边界，不再保留可绕过脱敏的 raw logger。
  - Store duplicate/unbounded HITL schema：删除 Store 内重复且无界的 HITL schema/旁路，只保留 strict bounded canonical schema。
  - quota lease order：quota 压力严格先撤销最旧 family lease，再按既定 LRU 淘汰未 pin body。
- AC-08/10 精确补测进一步暴露 blocker：compact summarizer 会从旧 artifact ToolPart 重新注入 tool input、preview 和 outputRef。现已在 compact summarizer 投影前剔除 artifact ToolPart，compact 后只注入有界 family artifact count notice；真实 Registry Bash artifact → hard compact → 无 ref family `output_search` E2E 为 3/3，通过 sentinel 找回原 ref，compact 前后 artifact 计数不变。
- 最新静态候选证据：全仓 `bun run typecheck` PASS；`bun run test` PASS（Agent Core 2708 unit / 145 integration / 116 arch）；`bun run build` PASS；`git diff --check` PASS；AC-09 七项 fixed-string 生产源码扫描均为 zero。既有真实浏览器 reload/server restart 验收继续有效，新 compact→no-ref family search E2E 为 3/3。
- 最终 fresh 独立 `sol(max)` Review：`Findings: None`，AC-01～AC-10 全部 `DONE`，`VERDICT: DONE`。Reviewer 独立执行 `bun run test -- --force`（8/8 tasks、0 cached）、typecheck、build 和 diff check，全部通过；真实编译进程跨 restart 仍可读取/搜索同一 ref，过期 ref 稳定返回 410。
- 最终真实浏览器验收：live ToolCard 显示 126,092 B / 6,008 lines；Viewer 可分页并搜索到 `ERROR_SENTINEL_nearby-diagnostic`；页面 reload 后同一 ref 仍可打开和搜索；expired 输出只显示一次 `This output has expired.`，没有搜索控件或自动重试。

## 验收跟踪

| AC | 状态 | 证据 |
| --- | --- | --- |
| AC-01 类型与 finalization 唯一 | DONE | Registry owns exactly-once Raw→Finalized settlement; blocked has no settled result; strict protocol/store/HITL paths use bounded system results. |
| AC-02 policy 穷尽 | DONE | All descriptors declare explicit `source`/`artifact`/`inline` policy; matrix and agent-visibility checks cover builtins, GitHub, and MCP; recovery is `output_read` / `output_search`. |
| AC-03 有界捕获与 drain | DONE | Streaming capture, ProcessRunner rings/sink deadlines, discard-to-EOF, AST stream probe, and one-shot caps are covered by targeted tests. |
| AC-04 artifact/read/search | DONE | Opaque ref/cursor, UTF-8-safe bounded pages, gap semantics, and family lease validation are covered by artifact and runner tests. |
| AC-05 授权与生命周期 | DONE | Project identity plus root-family authorization, lifecycle fixtures for subtree deletion, TTL/LRU/quota, restart, and tombstone are covered. |
| AC-06 脱敏边界 | DONE | Finalizer/streaming redactor plus the Runtime/LSP log safety boundary exclude secrets and local paths from artifact, wire, model, HTTP/DOM, audit, and logger boundaries. |
| AC-07 source/one-shot 无静默丢失 | DONE | Source tools expose strict forward cursors; artifact producers use bounded capture and one-shot adapters enforce transport/parse caps. |
| AC-08 消费者统一 | DONE | Consumers share finalized output facts; hard compact omits old artifact ToolParts and emits only a bounded family-count notice before no-ref family search recovery. |
| AC-09 hard cut 无兼容层 | DONE | Legacy files/exports are removed; all seven required fixed-string production scans are zero. |
| AC-10 真实用户故事与全仓验证 | DONE | Live read/search, browser reload, true server restart, expired UI, and real hard compact→no-ref family search pass; full typecheck/test/build/diff checks are green. |

## 待处理风险

- 无未关闭的验收风险。最终独立 Reviewer 已给出 `VERDICT: DONE`。
