# Automation Hard-Cut Refactor Progress

## Status

`DONE`

## 2026-07-13

- 旧产品 Loop 的 core、protocol、server、Web、持久化读取及专属 Goal/HITL/权限接线已硬切删除；无 fallback、别名或数据迁移。
- 新结构固定为 `Schedule -> durable Invocation -> Dispatcher -> ordinary Session API`；支持 once、interval、cron + timezone，以及 start Session / send message 两种 Action。
- Session 继续唯一拥有 Agent 执行、Skill、权限、HITL、worktree 和结果；Goal、Agent 与通用 GitHub connector 行为保持独立。
- 幂等恢复、离线不补跑、coalesce、waiting-for-human、pause/delete 及 accepted-but-uncheckpointed 竞态均有回归测试。
- Reviewer 逐项复验 AC-01 至 AC-09，全部判定 `DONE`，无剩余 P0/P1。

## Verification

- `bun run typecheck`：通过，5/5 tasks。
- `bun run test`：通过，8/8 tasks；Agent Core 3076 tests，0 fail。
- `bun run build`：通过，Web build、manifest generation 完成。
- `git diff --check`：通过。
- 生产遗留审计：旧 `loops/` 目录、`/loops` 路由及 Loop 产品标识均无命中；保留的 `agents/query/loop.ts` 仅是通用 LLM query loop。
