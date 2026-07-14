# Shared Code Unification Hard-Cut Progress

## Status

`DONE`

## 2026-07-14

- AC-01：全部 Server route 已统一为 `hono/validator` + Zod 薄适配；handler 只读取 `c.req.valid(...)`，旧 request/query helper 与手工解析已删除。
- AC-02：Goal review receipt 由 `goals/review-schema.ts` 唯一持有；Web 提交完整 receipt，HTTP 在 claim 前严格拒绝缺失或 verdict 不一致的数据，Core 不再补值或 fallback。
- AC-03：Automation 四个限制归 Protocol，Core Schema 统一 create/persist/update，Tool、Server、Web 直接复用；未新增创建 API。
- AC-04：删除 `tools/groups.ts` 和旧导出；七个 Agent 复用 Skill 能力包，五个可委派 Agent 与 Factory 复用 delegation 能力包，完整权限表仍留在 definition。
- AC-05：Protocol guards、retry、Compression normalization、Session tree、稳定 JSON 排序与文件级 atomic write 已收敛；重复实现和转发 wrapper 已删除。
- AC-06：三个 Goal 视图共享状态映射，两个 delegation 视图共享 view-model；DOM、交互和布局保持独立。
- AC-07：barrel、AGENTS.md、fixture 与架构测试已更新；文本审计未发现旧 group、route-local 请求读取、重复契约或兼容层。
- 首轮 Reviewer 的 Server 路由遗漏、delegation 能力包未实际复用、terminal-status wrapper 与测试缺口均已修复；另修正测试模拟重启时未销毁旧 `ResumeCoordinator` 导致的 1 秒重试竞态，未改生产行为。

## Verification

- `bun run typecheck`：5/5 tasks，退出码 0
- `bun run test`：8/8 tasks；Agent Core 3104 pass，0 fail；退出码 0
- `bun run build`：Web build、308-asset manifest、Bun binary compile 全部完成，退出码 0
- Server request/HITL 定向测试：29 pass，0 fail
- Web Automation 限制交互测试：1 pass，0 fail
- Agent definition/架构定向测试：22 pass，0 fail
- ResumeCoordinator 竞态回归：连续 3 轮共 33 pass，0 fail
- `git diff --check`：退出码 0
- 最终独立 Reviewer：`DONE`，AC-01 至 AC-07 全部通过，首轮 4 个 P1 与 2 个 P2 均关闭
