# Server Config Settings Progress

## Status

`DONE`

## 2026-07-13

- 当前 Session 已接管 Codex Worktree `/Users/bo/.codex/worktrees/f774/archcode`；先前独立任务及其子 Agent 已全部中断，未产生实现修改。
- 已锁定以 `server-config-settings-goal.md` 的 AC-01 至 AC-07 为唯一验收标准；执行过程只记录在本文件。
- Worktree 已切换到 `codex/server-config-settings`；开发配置已手工复制到 `~/.archcode/config.json` 并设置为 `0600`，生产实现不会自动迁移或 fallback。
- 已并行启动当前 Session 内的架构审计、后端配置领域和 Web Settings 三个子 Agent；正式 API DTO 要求由 protocol 显式描述，禁止 Web 重复弱类型契约。
- README 已切换到全局配置路径并删除 Provider 环境变量展开的错误承诺，同时保留 MCP/GitHub 现有行为说明。
- Worktree 的 Bun 依赖已在获批的非沙箱安装中补齐；此前 533 个链接失败已确认是沙箱环境问题，不是代码或测试失败。
- 架构预审要求密钥改用不可碰撞的判别式 DTO，并将 Provider/Agent/MCP 跨引用校验集中到配置领域；内置 MCP 的用户覆盖语义必须从运行时、测试和注释中一起删除。
- 只读架构预审已完成：确认保持“单一配置服务 + 启动快照 + 全局 API + 本地 draft”，禁止热更新、分区保存、通用 schema 表单和 MCP Agent assignment；同时补充 startup revision 必须在启动时捕获、临时文件创建即 `0600`、完整校验返回 422、并发 PUT 串行等验收风险。
- 后端 focused TDD 曾依次暴露 root barrel 未导出、测试未挂 Hono error handler、startup revision 测试 setup 不完整等红态；修正后 `bun test packages/agent-core/src/config/server-config-service.test.ts apps/server/src/routes/config.test.ts packages/agent-core/src/mcp/manager.test.ts` 为 43 pass / 0 fail，覆盖配置服务、400/409/422 API 映射及 built-in MCP collision。
- 后端扩展验收后，`bun run --cwd packages/agent-core test -- server-config-service.test.ts main.test.ts runtime-mcp.test.ts` 为 37 pass / 0 fail，`bun run --cwd apps/server test -- config.test.ts app.test.ts` 为 18 pass / 0 fail；已证明缺失/EISDIR/JSON/schema 启动失败、旧 CWD 文件不回退、secret 三态、并发 revision、no-op、runtime 启动快照及全局 API/project 404。
- 主审额外发现不可信 PUT 可用非法 secret mutation 静默触发删除，以及 built-in MCP 名称多处硬编码；已退回后端补严格判别式运行时校验和共享名称常量，尚未视为最终完成。
- Web 已完成 protocol view→draft 转换、五菜单与主要编辑面板，当前 focused typecheck/static/API/JSDOM 测试为绿；主审未接受仅 5 个交互用例，已退回补 Agent 联动、secret 提交体、close、built-in 锁定及实际职责拆分。
- 后端安全复审已关闭：PUT 会在合并前严格拒绝 string/null/未知 secret mutation，只有精确 `delete` 才删除；built-in MCP 名称由 protocol 单一常量提供；route 仅依赖窄 `ConfigServicePort`。focused 回归为 agent-core 39 pass、server 18 pass。
- Web Settings 交互覆盖扩展到 17 个专项用例：五菜单、Provider→Model→Variant 连续编辑、Agent variant 重命名联动、dirty/409/422、Provider/MCP 四类 secret 的 preserve/replace/delete 提交体、精确字段错误、MCP 重命名与 built-in 锁定、非法 providerOptions 不污染 draft、restart banner、close。全 Web interaction 为 36 pass / 0 fail。
- 干净 Worktree 构建暴露根构建脚本直接读取 `css-tree`/`jsdom` 但未声明根依赖；已补为根 devDependencies，`bun install` 后生产二进制构建可复现。
- 最终命令已在实现完成后重跑：`bun run typecheck` 5/5 workspace 通过；`bun run test` 8/8 Turbo task 通过（agent-core 3089 pass / 0 fail，Settings interaction 17 pass）；`bun run build` 通过并生成 308 资产 manifest 与二进制；`git diff --check` 无输出。
- 浏览器验收使用临时 HOME `/tmp/archcode-settings-qa` 和无敏感 QA 配置，未触碰真实全局配置。桌面验证五菜单、Provider/Model、七 Agent、MCP 配置+实时状态、Memory/GitHub、保存后 restart banner。390×844 初验发现横向菜单隐藏 Memory/GitHub，改为三列两行后五项均完整在视口内并可切换；Radix 缺少即时 DialogTitle 的控制台错误也已修复，最终控制台 0 error。
- 静态边界检查确认 `packages/agent-core/src/agents/definitions/**`、`agents/tool-filter.ts`、`mcp/tool-adapter.ts`、`tools/permission/**` 零 diff；本 Goal 未改变自定义 MCP 的 Agent visibility/permission。
- 最终 Reviewer 发现 GitHub section 存在但省略 `enabled` 时，UI 错误显示为关闭，而 Runtime 既有默认是启用。新增交互回归先得到 17 pass / 1 fail（expected true, received false），随后将显示语义改为“section 存在时 `enabled ?? true`，section 不存在时 false”，专项测试 18 pass / 0 fail。
- Reviewer 修复后，完整 Web 测试为 555 unit + 37 interaction 全绿，最终 `bun run build`（含全仓 typecheck）与 `git diff --check` 通过。全仓并发测试曾随机让未改动的 SessionExecutionManager 用例读到缺失父 Session；同一失败点随后单测 1/1、整文件 98/98 通过，且 `execution/**`、`store/**` 零 diff。此前本 Goal 最终架构已取得两次全仓 3089/3089；该既有并发测试隔离抖动未扩进配置任务。
- 最终架构复核无阻塞 findings；AC-01 至 AC-07 全部通过，Goal 判定为 `DONE`。
- 用户实测后发现 Settings 弹窗整体向视口下方偏移并被底部裁切。根因是 Settings 向通用 `DialogContent` 传入 `relative`，覆盖了组件自身的 `fixed` 居中定位，但仍保留 `top-1/2` 与 translate。已删除调用方冲突类，并将 Dialog 的 fixed 定位提升为组件不可被普通 class 覆盖的 `!fixed` 约束；新增定位回归测试先红后绿。
- 修复后完整 Web 测试 556 unit + 37 interaction 全绿，Web typecheck 通过。真实开发页面桌面 1280×720 验证 Dialog 为 fixed、边界 top=60/bottom=660、底栏完整；390×844 验证五菜单、内容滚动区和底栏完整可见。
- 用户实测后收窄 Model/Agent 表单：Provider package、`limit.context`、`limit.output` 与 `modalities` 保留；Model `options`、完整 `variants`、Agent `options` 改为 JSON object 编辑器，Model 与 Agent 条目默认折叠，减少供应商差异导致的过细字段建模。
- `pricing` 与配置层 `maxRetries` 已从 Zod schema、protocol DTO、Provider model、resolver/LLM 选项、Settings UI、测试和当前配置文档中纵向删除，不保留 fallback 或旧兼容；ArchCode 托管 LLM 调用仍在内部强制 AI SDK `maxRetries: 0`，这不是用户配置项。
- JSON 编辑器保留未完成/非法输入并就地报错，非法 JSON 会阻止保存；服务端返回的 options/variants 嵌套 422 错误会映射到对应 JSON 编辑器。专项回归为 Settings interaction 21/21，完整 Web 为 557 unit + 40 interaction 全绿。
- 真实 `~/.archcode/config.json` 已原子删除既有 `maxRetries` 字段并保持 `0600`，随后通过 `ServerConfigService.loadForStartup()` 完整启动校验；文件内容和密钥未输出。
- 最终在具备 worktree 临时目录写权限的环境重跑 Agent Core 全量测试为 3089/3089；`bun run build`（5 个 workspace typecheck、Web production build、308 资产 manifest、二进制）与 `git diff --check` 通过。真实开发页确认保留 Provider package、output/modalities，Model/Agent 折叠与 JSON 编辑器生效，非法 JSON 保留原始输入并禁用保存；API health 200，开发服务继续运行在 4096/5173。
- 用户实测发现 MCP 配置整合后只剩工具数/错误说明，原有明确状态 Badge 丢失。已为每个 built-in/custom Server 恢复 `Ready`、`Pending`、`Failed`、`Disabled`、`Not reported` 状态 Badge，工具数与错误继续作为详情；状态使用语义化 `role=status` 和明确 aria-label。单元测试与 40 个 Web interaction 用例通过，真实开发页确认三个 built-in 均显示绿色 `Ready`。
- 未提交变更首轮审查发现 6 个问题并完成修复：secret 省略不再隐式删除、含 secret 的 Provider/MCP 标识禁止直接重命名、稀疏编号不再覆盖、非法 JSON 跨菜单保留、保存期间锁定输入、Goal 验收删除已退役 pricing。对应后端配置服务 16/16、配置与 MCP focused 52/52、Web 557 unit + 46 interaction 全绿。
- 二次审查继续修复标识符输入逐键 remount、重载期间旧快照可编辑、保留旧快照时重载失败不可见三个交互问题；标识符统一在 blur 提交，保存/重载期间整表锁定，并以请求序号丢弃过期重载响应。最终 `bun run build`（5 个 workspace typecheck、Web production build、308 资产 manifest、二进制）与 `git diff --check` 通过。全仓测试仅复现未改动 SessionExecutionManager 的既有共享临时目录竞态（3089 pass / 1 fail）；失败点单独执行 1/1 通过，且 `execution/**`、`store/**` 零 diff。
