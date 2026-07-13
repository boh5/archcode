# HITL Owner Continuation Hard-Cut Goal

## Objective

修复 Goal 子 Session 在权限或 `ask_user` 回答后进入 `resume_failed` 的问题，并彻底理顺 HITL、Session 与 Goal 的所有权：HITL 统一持久化人类请求和不可变回答；Session 与 Goal 分别幂等应用回答；Goal 生命周期不再用 `blocked` 表达等待用户；用户不再承担通用 Resume 操作。

## Locked Architecture

```text
HITL pending -> answered -> resolved | cancelled
                    |
                    +-> Session owner handler -> exact Session continuation
                    +-> Goal owner handler    -> Goal decision application

Goal lifecycle: running -> reviewing -> done | not_done
                failed -> running
                non-terminal -> cancelled

Goal attention/runtime activity are derived from HITL and Session family state.
```

- HITL Core 保留 owner store、脱敏投影、回答持久化、幂等、项目聚合、SSE 与冷启动恢复；不执行领域 continuation。
- 回答必须先持久化，再异步交给 owner handler；暂时失败自动恢复，不产生用户可操作的 `resume_failed`。
- Session handler 只按 `sessionId` 定位；完整 `agentName`、`parentAgentName`、Goal attempt、Session tree 与 cwd 身份由 Runtime 从持久化状态解析。
- Goal-owned approval、budget、review HITL 保留；Goal 执行中的问题和工具权限仍属于准确发起它们的 Session。
- 不迁移旧 Goal/HITL/Session 数据，不保留 fallback、别名或双写兼容。

## Acceptance Criteria

### AC-01：共享 HITL 不被 Session 私有化

- Session 与 Goal owner 的 HITL 创建、聚合、响应、取消、SSE 和冷启动恢复均保留并有测试。
- `HitlRecord` 明确区分等待回答、已回答待应用和终态；回答一经接受不可被不同响应覆盖。
- owner handler 可独立失败和重试，不要求用户重新提交原回答。

### AC-02：Session 回答恢复准确且自动

- Goal Lead 主 Session 的 `ask_user`、Plan/Build 子 Session 的 `ask_user`、Build 子 Session 的工具权限都恢复准确的原 Session。
- 普通消息与 HITL continuation 使用同一持久化身份解析；调用方不手工拼装缺字段的执行 subject。
- 回答持久化后即从待处理 UI 消失；进程重启可自动继续已回答但未应用的 Session HITL。

### AC-03：Goal 生命周期不再承载等待用户

- Goal status 只包含 `running | reviewing | not_done | failed | done | cancelled`；删除 `blocked`。
- 删除 model-facing `goal_manage.block`、`goal_manage.resume` 及 Goal Lead 的 block + ask_user 双写协议。
- Goal-owned HITL 在不覆盖原 Goal status 的前提下设置和清除执行门禁；删除 `resumeStatus`。

### AC-04：不再暴露通用 Resume

- 从 protocol、server、web 和测试中删除 `resume_failed`、`retry_resume`、`resumeStatus` API 投影与 Resume 按钮。
- 自动恢复失败只记录可诊断的内部投递错误；未知外部副作用使用明确的 inspection/cancel 语义，不伪造用户回答重试。

### AC-05：真实失败链路回归

- 集成测试覆盖：Goal Lead 委派 Build，Build 请求 bash 权限，Goal 仍为 `running`，批准后 Build 精确继续且 Goal Lead 不创建重复 Goal blocker/question。
- 测试不得 stub 掉真实 Goal Session execution scope validator。
- Goal approval、budget、review 的 owner handler 回归测试继续通过。

### AC-06：彻底重构与验证

- 删除旧状态、旧 schema、旧 UI action、旧 prompt 和无生产调用的兼容路径；文字搜索无遗留。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部通过。
- 使用隔离测试项目完成浏览器级问题回答和工具权限两条流程，且不修改被测项目源码之外的预期文件。
