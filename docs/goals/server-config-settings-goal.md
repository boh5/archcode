# Server Config Settings Goal

## Objective

将 ArchCode 配置硬切为服务器实例唯一的 `~/.archcode/config.json`，彻底删除从启动目录或项目目录读取、查找、合并、覆盖配置的路径。Settings 提供与当前配置 schema 一一对应的表单页面，安全编辑并原子写入该文件；运行时仍只在启动时加载配置，保存后必须重启才生效。

## Locked Architecture

```text
~/.archcode/config.json
  -> config domain service
  -> AgentRuntime startup snapshot

Settings UI -> global /api/config -> config domain service -> atomic file write
```

- 配置领域服务集中拥有固定路径、读取、完整校验、敏感字段脱敏、revision 冲突检测和原子写入；Server route 只做 HTTP 适配，Web 只依赖 protocol DTO。
- Runtime 使用启动时的不可变配置快照；Settings 写盘不得替换 Provider、Agent、Tool 或 MCP 运行时对象。
- Settings 左侧分组名固定为 `Server`，菜单固定为 `Models`、`Agents`、`MCP`、`Memory`、`GitHub`。
- `Models` 在同一页面完成 Provider 选择/维护及其 Models、Variants 配置，不能拆成两个菜单。
- MCP 页面合并配置与状态：`context7`、`grep.app`、`exa` 为不可编辑、不可删除、不可覆盖的 built-in；自定义 server 只负责现有配置和状态展示。

## Non-goals

- 不实现热重载、文件 watcher、应用内重启或运行时代际管理。
- 不实现首次配置/配置修复模式；全局配置缺失或无效时 Server 启动失败，并指出固定配置路径。
- 不读取、迁移或兼容旧的 CWD/项目 `.archcode.json`，也不提供 project config API、覆盖或合并语义。
- 不新增配置字段、整份配置的通用 JSON 编辑器、Provider 连通性测试或 Server 环境变量设置页面。
- 不新增 Provider 环境变量展开；只修正文档，不改变现有 MCP/GitHub 环境变量行为。
- 不修复或扩展自定义 MCP 的 Agent 可见性、权限策略或 tool filtering。

## Acceptance Criteria

以下 AC-01 至 AC-07 必须全部有代码、测试或审计证据；任一条件缺失即为 `NOT_DONE`。

### AC-01：全局配置硬切

- 生产启动唯一读取 `~/.archcode/config.json`；不以 `process.cwd()`、workspace root、已注册项目或项目内 `.archcode.json` 推导配置。
- 删除旧默认路径、配置查找/覆盖/fallback、迁移器、别名及相关生产分支；不读取或复制旧文件。
- 缺失、不可读、JSON 无效或 schema 无效时启动失败，错误包含 `~/.archcode/config.json` 的解析后绝对路径。
- 测试可以通过显式依赖注入隔离用户目录，但该 seam 不得形成生产配置覆盖入口。

### AC-02：配置领域边界

- 固定路径解析、加载、保存、revision 和敏感字段处理只有一个领域所有者；Runtime、Server route 和 Web 不得分别实现文件读写或 schema 规则。
- `@archcode/server` 通过窄接口调用配置服务；`@archcode/web` 只依赖 `@archcode/protocol`，不得依赖 agent-core/server。
- GET/PUT 使用全局 `/api/config`，不存在 `:slug` 或 project-scoped config endpoint。
- GET 返回磁盘配置的安全编辑视图、revision、配置路径和 `restartRequired`；PUT 必须携带 `expectedRevision`，过期 revision 返回明确冲突且不写盘。

### AC-03：校验、安全保存与重启语义

- PUT 在写盘前完成严格 schema 和跨引用校验，包括 Provider package、Agent model、Model variant、MCP URL 以及 built-in MCP 保留名称；失败时文件保持逐字节不变。
- 成功保存使用同目录临时文件加原子 rename，最终文件权限为 `0600`，JSON 使用稳定的两空格格式和结尾换行。
- Provider `apiKey`、Provider headers/query params 以及 MCP headers 的值不得通过 GET 明文返回；未修改的遮罩值保存后保持原值，显式替换或删除有确定行为和测试。
- 保存只更新磁盘配置；当前 Session、Goal、Automation、Provider、Agent 和 MCP 继续使用启动快照。内容变化后 `restartRequired=true`，无变化或重启加载相同 revision 后为 `false`。

### AC-04：Server Settings 信息架构

- Settings 分组标题为 `Server`，菜单恰为 `Models`、`Agents`、`MCP`、`Memory`、`GitHub`；删除现有无效的 `General`、独立 `Providers` 和独立 `Models` 占位结构。
- `Models` 页面按 Provider 组织 Models，支持当前 schema 已有的 Provider、Model、limit、modalities、options 和 variants 字段；固定的 OpenAI-compatible package 只读或由 UI 隐式写入，开放结构的 `providerOptions` 使用仅接受 JSON object 的字段级编辑器。
- `Agents` 固定展示七个 Agent，model 只能选择已配置的 `provider:modelId`，variant 只能选择对应 Model 的现有 variant，并支持当前 agent options。
- `Memory` 和 `GitHub` 只呈现当前 schema 已有字段；`$schema` 等元数据被保留但不作为产品设置。
- 不出现 schema 中不存在的 General、项目覆盖、热更新、Server port/auth 或其他未来配置。

### AC-05：MCP 配置与状态整合

- MCP 页面同时展示 server 配置及实时 discovery 状态/tool count，不再保留独立 MCP Status 菜单。
- `context7`、`grep.app`、`exa` 始终显示 `Built-in` 标识和固定信息，UI 无编辑/删除操作；后端拒绝自定义配置使用这三个名称，不能依赖前端限制。
- 自定义 MCP 只支持当前 schema 的 name、HTTP URL、headers、timeout 及添加/编辑/删除；不增加 enabled、Agent assignment 或权限字段。
- 本 Goal 不改变任何 AgentDefinition 的 `mcpTools`、MCP annotation/permission 策略或自定义 MCP 工具可见性。

### AC-06：文档与旧契约清理

- README 的配置路径、示例、启动说明和安全说明统一使用 `~/.archcode/config.json`，明确项目目录配置不会被读取。
- 开发文档允许开发者手工把现有仓库配置复制到新路径一次，但生产代码不得自动探测、复制或回退到旧文件。
- 删除 Provider `apiKey` 支持 `${VAR}` / `${VAR:-default}` 展开的错误示例和泛化承诺；不得误删当前 MCP/GitHub 已实现的环境变量说明。
- 活动文档、用户可见文案和生产代码不存在 CWD/项目 `.archcode.json` fallback、project override 或 built-in MCP override 的承诺。

### AC-07：TDD 与验收证据

- 配置路径硬切、缺失/无效启动失败、revision 冲突、完整校验、敏感值保留/替换/删除、`0600` 原子写入和 built-in MCP 拒绝均先有失败测试，再实现生产代码。
- Web 测试覆盖菜单切换、Models 连续操作、字段级错误、dirty state、保存冲突、敏感字段遮罩、MCP built-in 锁定和 restart banner。
- 浏览器验收确认桌面与窄屏 Settings 可完整导航、滚动、编辑和保存，且不存在空壳菜单或被遮挡的保存/错误状态。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- Reviewer 按 AC-01 至 AC-07 给出逐项证据，并审计旧配置路径/fallback、跨层文件逻辑、项目配置 API 和自定义 MCP 越界改动；不能只以测试通过代替验收。
