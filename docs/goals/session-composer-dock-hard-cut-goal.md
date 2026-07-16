# Session Composer Dock Hard-Cut Goal

## Objective

将 Session 输入区彻底重构为统一的 Composer Dock：HITL 位于输入卡上方，输入、模型/运行状态、发送/排队和停止操作收敛到同一张卡片；排队与发送中的用户消息继续作为普通聊天气泡留在 transcript，并在气泡下显示状态。视觉参考 Codex App 的单一输入容器，但沿用 ArchCode 现有颜色、字体和 conversation rail。

本次直接替换旧 footer slab，不保留旧 DOM、假功能入口、动画边框、feature flag 或兼容分支。

## Plan

1. 新增业务级 `SessionComposerDock`，统一订阅 Session runtime 与 HITL；路由只负责放置 Dock。
2. `ChatMessages` 统一投影 canonical、pending 与 local sending 消息；queued/sending/retryable 使用与用户消息一致的右侧气泡，并保留 Edit/Delete/Steer/Retry 状态操作。
3. 将 `ChatInput` 收敛为单一 Composer Card：无边框 textarea、内嵌状态栏与单一主按钮；空闲时发送，运行时原位切换为停止，同时保留 Enter 排队。
4. 统一 HITL 卡片、slash menu、响应式和 focus 状态；多问题 Ask User 使用逐题 Tab 与最终 Confirm，保持 880px conversation rail 与现有 Agent 配色不变。
5. 用组件测试、全量 Web 验证和真实浏览器覆盖宽屏、窄屏、空闲、运行、Queue 与 HITL。

## Acceptance Criteria

- **AC-01 Architecture**：`SessionComposerDock` 只组合 root Session composer 与 HITL；`ChatMessages` 是 canonical、queued、sending、retryable 消息的唯一显示所有者，并负责相关 Queue 操作；root Session 不重复订阅 HITL。Protocol、Server 与 Session Store 契约不变。
- **AC-02 Unified card**：输入区不存在全宽 `border-top` footer slab；textarea 自身无独立边框/背景，Composer Card 统一拥有圆角、边框、背景、阴影和 `focus-within`；模型、运行状态和唯一主操作都位于卡内。
- **AC-03 Honest controls**：空闲时主按钮为 Send/Queue，运行时同一位置只显示 Stop；运行中点击按钮停止、按 Enter 仍可排队；停止中正确禁用；未实现的 attachment 入口与 `Coming soon` 完全删除；运行状态不使用 conic/旋转边框。
- **AC-04 Transcript and attention**：queued、steering、sending、retryable 必须显示为 transcript 内的普通右侧用户气泡，状态和 Edit/Delete/Steer/Retry 位于气泡下方，不得出现独立 Queue 卡片或 Queue 区；Composer Card 上方只显示 HITL。多问题 Ask User 只显示当前问题，单选自动进入下一题，多选/文本经 Next 前进，最后必须在 Confirm 汇总提交；卡片无横向溢出且常规问题不触发右侧滚动条。
- **AC-05 Responsive and visual**：Dock 与 transcript 继续共享 880px rail；窄屏保留 16px gutter、无横向滚动；slash menu 与 Composer Card 边界一致；窄屏隐藏冗长快捷键提示但保留核心状态和操作。
- **AC-06 Verification**：定向组件/交互测试、`bun run typecheck`、`bun run test`、`bun run web:build`、`git diff --check` 全部通过；真实浏览器验证宽屏、窄屏、空闲、运行、Queue 编辑/删除与 HITL 响应，console error 为 0。
