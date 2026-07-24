# 首次设置与可选登录 Goal 进度

状态：已完成
开始日期：2026-07-24
分支：`codex/first-run-setup-auth`
Worktree：`/Users/bo/.codex/worktrees/019f91b2/archcode`

## 目标

依据 `docs/plan/first-run-setup-authentication.md` 完成首次设置与可选密码登录，
并通过独立审查与完整验证。

## 执行记录

### 2026-07-24

- 从 `main@8a943a0` 创建独立 Codex worktree。
- 主 checkout 中已有的 `design/prototypes/signal-workbench/*` 修改保持不动。
- 开始核对 Config、Server Host、Auth、Protocol 和 Web bootstrap 的当前实现边界。
- 独立架构审计确认方案方向可行，同时发现并锁定以下修正：
  - Setup 由 `ArchCodeServerHost.completeSetup()` 统一编排，Route 不串联领域事务。
  - Config 初始化使用 OS 级原子 no-replace；进程内锁不能代替跨进程互斥。
  - 首次 Provider/MCP Secret mutation 由 Config 领域 materialize，只允许
    `replace`，不允许无历史值的 `preserve/delete`。
  - Runtime activation 与 Auth credential 分离投影，Password Hash 不进入
    AgentRuntime。
  - 有效 Config 的普通启动先完成 Runtime 构造/恢复再监听；`activating` 只属于
    Setup 提交。
  - Web 的 fetch/SSE 401 必须统一触发认证失效并卸载 Workbench。
  - Auth 增加密码输入字节上限、Session 数量上限和 credential generation，
    防止资源滥用及旧密码并发签发 Session。
- 已实现并验证进程内一次性 `SetupGrant`；开始实现 `ServerAuthService`。
- Config 领域已硬切到 `activateForStartup()`、create-only
  `initialize()` 与显式 `ServerConfigActivation`；`AgentRuntime` 不再读盘，也不
  接收 Auth Hash。
- `ArchCodeServerHost` 已成为唯一 HTTP 外壳和首次设置用例协调者；Setup、
  Config Error、Startup Error 与 Ready 共享 listener 和中间件，Runtime routes
  只负责 Runtime API 组合。
- Auth 已实现 Argon2id、固定绝对有效期的有界进程内 Session、HttpOnly
  SameSite Cookie、同源 Origin 校验、登录限速、密码变更串行化和全 Session
  撤销。输错当前密码返回 403，不会把有效 Session 误判成过期。
- Protocol 已增加不携带 Hash/Token/Session ID 的严格 bootstrap/auth DTO；
  Setup 请求是 `requireLogin` 判别联合，HTTP 边界拒绝客户端夹带
  `auth.passwordHash`。
- Web 已在 Query、SSE 和 Router 外增加 `BootstrapGate`，复用现有
  Models/Profiles 受控组件，并增加 Login 与 Settings Security。REST/SSE 401
  共用认证失效入口，清空 Query cache 后卸载工作台。
- 认证仅由 Config、专用 Auth API 和 opaque Session Cookie 组成；Server 启动
  不读取或识别其他密码来源。
- 自审和真实浏览器流程发现并修复：
  - 嵌入式静态响应会覆盖外壳预写安全头，改为响应完成后统一附加
    `Referrer-Policy: no-referrer` 与 `X-Content-Type-Options: nosniff`。
  - Setup 完成后 Router 仍保留 `/setup` 并显示 404；现在 Ready 授权挂载前
    归一化到 `/` 并同步 Browser Router，首次完成和重启登录都进入 Dashboard。
- 架构边界测试已随职责迁移改为约束 `ServerHost` 中
  Session continuation → Todo recovery → Automation scheduler → Runtime app 的
  唯一顺序，不再保留对 `boot.ts` 旧职责的断言。
- 独立高强度审查发现并推动完成以下安全与职责修复：
  - 登录验证使用独立串行门禁，使并发请求无法同时穿透失败限速并放大
    Argon2id 内存占用。
  - Auth 专用写只持久化 credential，不 prepare/publish ModelRuntime；
    ModelRuntime 使用不含 Auth 的 canonical revision，改密和 Auth-only no-op
    保存均不会触发模型运行时变更。
  - Auth Session 绑定 SSE lease；登出、改密、绝对到期和 Session 淘汰都会主动
    abort 旧流、释放订阅，旧 Cookie 重连返回 `401`。
  - `config.json` 悬空 symlink 通过 `lstat` 判为 `config_error`，不误进 Setup。
  - 远程部署文档明确反向代理必须保留原始 `Host`，且 ArchCode 不信任
    `X-Forwarded-*`。
- 独立审查最终结论：`VERDICT: APPROVED`，无剩余阻断项。

## 已完成验证

- 全仓测试所有 lane 通过；Server 211、Web unit 506、
  Web interaction 88、Agent Core unit 2646、integration 131、architecture 95、
  Protocol 107、Utils 11 均为零失败。
- `bun run build`：全仓 typecheck、Vite 生产构建和 arm64 单二进制编译通过。
- 生产二进制隔离 HOME 冒烟：
  - 缺失 Config 启动 Setup，不构造 Runtime；
  - Bearer Setup Grant 完成密码 Setup 后同进程 Ready；
  - 未登录 Runtime API 401，首个 Session Cookie 可访问；
  - `~/.archcode` 为 `0700`，Config 为 `0600`；
  - 仅落盘 Argon2id Hash，明文密码不存在；
  - 重启后旧 Session 失效，正确密码重新登录；
  - 旧环境变量存在时进程 fail closed。
- 浏览器验收：
  - 真实 Setup 表单配置 Provider/Model/Profile/密码并进入 Dashboard；
  - Token fragment 立即从地址栏删除；
  - 进程重启和旧 `/setup` 链接登录后均归一化到 `/`；
  - Security 面板可见，390px 页面与弹窗无横向溢出；
  - 浏览器控制台零 warning/error。
- 静态硬切搜索与 `git diff --check` 通过；旧认证名称只出现在允许的 guard、
  对应测试、当前 Plan/进度和 README 迁移说明中。

## 独立审查

高强度独立审查完成了多轮发现 → 修复 → 聚焦测试 → 复审，并在最终树上给出
`VERDICT: APPROVED`。两个非阻断后续建议中，反向代理 `Host` 说明已纳入
README；Logout UI 可作为独立产品改进，不扩张本次最小认证范围。
