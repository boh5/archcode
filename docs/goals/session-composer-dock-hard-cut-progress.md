# Session Composer Dock Hard-Cut Progress

## Status

`DONE`

## 2026-07-16

- 已锁定 hard-cut 边界：Web-only，不修改 Protocol、Server 或 Session Store 数据契约。
- 已确认当前割裂同时来自视觉和所有权：Queue 位于 `ChatMessages`，HITL 位于 route，runtime/HITL 状态又由 `ChatInput` 重复订阅。
- 已锁定最终结构为 `Transcript(canonical + transient user messages) + SessionComposerDock(HITL + Composer Card)`；Agent 颜色和完整 Diff 工作区均不在本次改动范围内。
- 已新增业务级 `SessionComposerDock`：它统一订阅 root Session runtime 与 HITL，并将派生状态传给 `ChatInput`；root route 不再持有第二份 HITL 订阅。
- `ChatMessages` 统一投影 canonical、pending 与 local sending：queued/sending/retryable 保持普通右侧用户气泡，只在气泡下显示状态与 Edit/Delete/Steer/Retry，不存在独立 Queue 卡片或 Queue 区。
- Composer 已收敛为单一 16px 圆角卡：textarea 透明且无独立边框，模型/状态与唯一主按钮均在卡内；空闲时按钮为 Send/Queue，运行时原位变为 Stop，Enter 继续排队；假 attachment、`Coming soon` 与 conic thinking border 已删除。
- Composer 上方 Attention Stack 只承载 HITL；HITL 控件同步补齐了真实的 token 样式，删除无实现的 `btn-primary`/`btn-secondary` 类。
- 已恢复被覆盖的多问题 Ask User 状态机：问题以等宽 Tab 展示，单选自动前进，多选和文本使用 Next，最后在 Confirm 汇总并一次提交；卡片与 Attention Stack 同时收紧 `min-width`/横向 overflow 边界，常规多问题不再触发右侧滚动条。

## Verification

- `bun run typecheck`：5/5 workspace，退出码 0。
- `bun run test`：8/8 task，退出码 0；Web 532 unit + 53 interaction，Agent Core unit/integration/architecture 全部通过。
- `bun run web:build`：Vite 2670 modules，退出码 0；只有既存 chunk-size warning。
- `git diff --check`：退出码 0。
- 真实浏览器默认双侧栏：Composer Card 为 `534.5 × 88px`、`16px` 圆角、透明无边框 textarea、无全宽 top border、无 attachment；页面横向溢出为 0。
- 真实浏览器宽屏 `1728 × 900`：conversation rail 为 `880px`，Composer Card 为 `840px`；窄屏 `600 × 800`：rail 使用全宽与 `16px` gutter，Card 为 `568px`，冗长快捷键提示隐藏，横向溢出为 0。
- Slash menu 在窄屏与 Card 均为 `x=16 / width=568px`；textarea focus 后整卡边框为 accent，3px focus shadow 生效。
- 临时真实 Session 验证：运行态卡内只有 Stop，按 Enter 仍成功创建 queued message；DOM 断言 `queuedInRail = 1`、`queuedInDock = 0`、独立 Queue 区为 0，queued message 作为普通右侧聊天气泡显示并带状态。成功创建三问题 ask_user HITL，单选自动前进、多选经 Next、文本经 Review answers，最后由 Confirm Answers 提交。
- `1280 × 800` 与 `600 × 800` 的真实 Confirm 页面均为 `scrollHeight = clientHeight = 506px`，Attention Stack、HITL Card 与 Tabs 的横向 overflow 均为 0；修复前同一场景为 `scrollHeight 506px > clientHeight 446px`，会出现右侧滚动条。
- 浏览器 console error 为 0；临时 Session 已删除，项目 pending HITL API 返回空数组。
- 清场搜索确认生产代码不存在 `Coming soon`、attachment、thinking border、conic gradient、旧 composer surface、无实现 button class；Queue 显示只存在于 `ChatMessages`，HITL 显示只存在于 Composer Dock。
