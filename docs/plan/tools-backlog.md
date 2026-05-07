# Tools 系统 — 未来模式储备

跨项目研究中发现的、尚未纳入当前工具系统设计（`tools-system.md`）的模式。
开发时按需引入，按优先级排列。

来源项目：Claude Code、OpenCode、oh-my-openagent、oh-my-opencode-slim、pi-mono。

---

## 1. `contextModifier` + `newMessages`（Claude Code）

**问题**：当前 `execute() → string` 没有副作用通道。工具无法修改 agent 状态、注入消息、或改变后续工具调用的上下文。

**模式**：ToolResult 携带可选的 `contextModifier: (ctx) => ctx` 和 `newMessages: Message[]`。
例如 `EnterPlanModeTool` 用 `contextModifier` 把权限模式切到 `'plan'`。

**参考**：`claude-code-sourcemap/restored-src/src/Tool.ts` — ToolResult 类型定义

---

## 2. 工具搜索 + 延迟加载（Claude Code）

**问题**：30+ 工具时不可能把所有描述放进 prompt，token 预算爆炸。

**模式**：`ToolSearch` 工具让 LLM 按关键词搜索 + `select:<name>` 激活。工具标注 `shouldDefer: true` / `alwaysLoad: true`，每个工具有 `searchHint: string` 帮助关键词匹配。已加载的工具返回 no-op（不触发重试风暴）。

**参考**：`claude-code-sourcemap/restored-src/src/tools/ToolSearchTool/ToolSearchTool.ts`

---

## 3. 可插拔 Operations（pi-mono）

**问题**：工具硬编码后端。无法用 mock 文件系统测试、SSH 远程执行、或沙箱封装。

**模式**：每个工具暴露 operations 接口（`BashOperations`、`ReadOperations`、`WriteOperations` 等），构造时注入。SSH 扩展把所有工具换成远程 ops。沙箱扩展用 OS 级沙箱封装 bash。测试注入内存文件系统。

**参考**：`pi-mono/packages/coding-agent/src/core/tools/bash.ts`、`edit.ts`、`read.ts`、`write.ts`

---

## 4. `prepareArguments` 兼容层（pi-mono）

**问题**：模型总是产生略微错误的格式——JSON 字符串代替数组、旧参数名、扁平 `oldText/newText` 代替 `edits[]`。

**模式**：在 Zod schema 验证前运行的 shim，自动规范化模型的各种格式问题，不拒绝调用。

```typescript
function prepareEditArguments(input: unknown): EditToolInput {
  // 模型把 edits 发成 JSON 字符串而非数组
  if (typeof args.edits === 'string') {
    try { const parsed = JSON.parse(args.edits); if (Array.isArray(parsed)) args.edits = parsed; } catch {}
  }
  // 模型用扁平 oldText/newText 而非 edits[]
  if (typeof legacy.oldText === 'string') {
    edits.push({ oldText: legacy.oldText, newText: legacy.newText });
  }
}
```

**参考**：`pi-mono/packages/coding-agent/src/core/tools/edit.ts`

---

## 5. 文件变异队列（pi-mono）

**问题**：并行工具调用编辑同一文件 → 竞态条件、写入损坏。

**模式**：按文件序列化写入 `withFileMutationQueue(filePath, fn)`。用 `realpath` 解析符号链接。不同文件并行执行，同一文件串行执行。约 39 行代码。

**参考**：`pi-mono/packages/coding-agent/src/core/tools/file-mutation-queue.ts`

---

## 6. 模糊编辑匹配（pi-mono）

**问题**：精确 `oldText` 匹配在模型改了空白、智能引号、或 Unicode 破折号时失败。

**模式**：匹配前的规范化管线：智能引号 → ASCII、Unicode 破折号 → 连字符、NFKC 规范化、尾空格剥离。精确匹配失败后回退到模糊匹配。

**参考**：`pi-mono/packages/coding-agent/src/core/tools/edit-diff.ts`

---

## 7. Doom 循环检测（OpenCode）

**问题**：LLM 用相同参数反复调用同一工具，浪费 token。

**模式**：按消息范围检测（非全局计数器）。检查当前 LLM 响应中最近 N 个工具部分。当最近 3 个部分有相同工具名 + 相同序列化输入时 → 触发权限提示。用户决定继续或停止。

**参考**：`opencode/packages/opencode/src/session/processor.ts:350-375`

---

## 8. Tool Metadata Store 存后取模式（oh-my-openagent）

**问题**：平台层（如 `fromPlugin()`）覆盖工具 execute() 的 metadata（`{ sessionId, title }`）为 `{ truncated, outputPath }`。

**模式**：独立内存 store。`execute()` 中存 → `storeToolMetadata(sessionID, callID, data)`。平台覆盖 metadata。`tool.execute.after` 钩子取回 → `consumeToolMetadata(sessionID, callID)` → 合并回去。一次性消费，15 分钟 TTL 自动清理。

**参考**：`oh-my-openagent/src/features/tool-metadata-store/store.ts`

---

## 9. File Write Guard — 先读后写（oh-my-openagent）

**问题**：LLM 覆盖它没读过的文件，可能破坏内容。

**模式**：`read` 注册读权限（按 session 追踪，LRU 最多 1024 路径）。`write` 已存在文件需要已消费的读权限。写入后使其他 session 的权限失效。新文件始终允许。

**参考**：`oh-my-openagent/src/hooks/write-existing-file-guard/`

---

## 10. 错误恢复注入（oh-my-openagent）

**问题**：工具失败时 LLM 只收到原始错误，没有修复指导。

**模式**：`tool.execute.after` 钩子检测错误模式并追加恢复指导。JSON 解析错误 → 正确格式提示。Edit `oldString not found` → hashline 用法提醒。非阻塞——追加到输出，不替换。

**参考**：`oh-my-openagent/src/hooks/json-error-recovery/`、`edit-error-recovery/`
