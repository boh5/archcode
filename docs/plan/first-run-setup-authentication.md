# 首次设置与可选登录硬切 Plan

状态：Implemented
日期：2026-07-24

## 1. 决策

ArchCode 的默认首次使用路径固定为：

```text
下载二进制 -> 运行 archcode -> 打开浏览器 -> 完成首次设置 -> 进入工作台
```

不要求用户预先创建 `~/.archcode/config.json`，也不增加必须执行的
`archcode init`。

- Config 缺失时，Server 启动受限的 Setup Mode，不创建空的
  `AgentRuntime`。
- Setup 页面一次完成最小模型配置和可选密码设置。
- Setup 成功后在同一进程、同一端口激活完整 Runtime，不要求重启。
- `auth.passwordHash` 存在就要求登录；不存在就不登录，不判断本地或远程。
- 登录默认开启；用户可以明确选择 `Run without login`。

## 2. 状态模型

磁盘 Config 状态只有三种，不增加通用安装工作流或可扩展状态机：

```text
missing config -> setup
valid config   -> ready
invalid config -> config_error
```

Host 仅额外拥有两个非持久运行态：Setup 提交期间的 `activating`，以及有效
Config 无法构造完整 Runtime 时的 `startup_error`。二者都不是新的 Config
状态。

| 状态 | 可用能力 |
|---|---|
| `setup` | Web 静态资源、health、bootstrap 状态、Provider Adapter Catalog、完成 Setup |
| `ready` | 登录接口和完整 ArchCode API；启用密码时，未登录请求只能访问公开入口 |
| `config_error` | Web 静态资源、health 和只读错误信息；不创建 Runtime，不允许覆盖 Config |
| `startup_error` | Web 静态资源、health 和脱敏的启动错误；不开放 Setup 或完整 API |

`config_error` 不回退到 Setup。已有但无效的 Config 必须由用户明确修复，防止
首次设置流程覆盖真实密钥和配置。

## 3. 锁定架构

```text
                     +------------------------+
HTTP listener -----> | ArchCodeServerHost     |
                     | shared middleware      |
                     | active mode dispatcher |
                     +-----------+------------+
                                 |
              +------------------+------------------+
              |                  |                  |
         Setup API          Config error       Full Server App
              |                                     |
              v                                     v
     ServerConfigService ----------------------> AgentRuntime
              |
              v
     ~/.archcode/config.json
```

### 3.1 职责边界

| 所有者 | 唯一职责 |
|---|---|
| `ServerConfigService`（agent-core） | 固定 Config 路径、启动状态判定、严格校验、敏感字段保护、create-only 初始化、revision、原子 `0600` 写入和 ModelRuntime 发布 |
| `ArchCodeServerHost`（server） | 拥有唯一 HTTP listener、当前模式、`completeSetup()` 用例编排、Setup 到 Ready 的串行切换，以及可选 Runtime 的启动与关闭 |
| `SetupGrant`（server） | 生成、校验和消费当前进程的一次性 Setup Token；不读写 Config |
| `ServerAuthService`（server） | 密码散列/验证、认证配置变更事务、登录限速、内存 Session、Cookie 和会话撤销；通过 Config service 的窄方法持久化，不直接读写文件 |
| Config / Setup / Auth routes（server） | HTTP DTO 适配和错误映射，不实现领域校验、文件写入或 Session 规则 |
| `BootstrapGate`（web） | 在挂载 SSE、项目查询和工作台 Router 前选择 Setup、Login、Config Error 或 Workbench |
| Config editor（web） | 受控 draft 和字段交互；不推断 Server 状态，不复制后端校验 |

Web 继续只依赖 `@archcode/protocol`，不得依赖 server 或 agent-core。

## 4. Config 领域硬切

### 4.1 启动读取

以新的显式启动协议替换当前
`createRuntime() -> loadForStartup() -> bootServer(runtime)`：

1. `ServerConfigService.activateForStartup()` 返回严格判别结果：
   `setup | ready | config_error`；只有文件不存在的 `ENOENT` 属于 `setup`，
   权限、目录占位、无效 JSON 和无效 schema 都属于 `config_error`。
2. `ready` 表示 Config 已完成 schema、跨引用和 Provider Adapter 校验，
   且 ModelRuntime snapshot 已准备并发布，同时返回 agent-core 内部、不可序列化的
   `ServerConfigActivation`。
3. `createRuntime({ configService, activation })` 显式要求同一次激活产生的
   `ServerConfigActivation`，不依赖“调用者应该已经加载”的隐式状态，不再读盘，
   也不再把缺失 Config 当作普通异常。
4. 删除旧 `loadForStartup()` 入口及其所有生产调用，不保留双路径。

测试通过显式 `homeDir` seam 创建隔离服务，但生产配置路径仍只有
`~/.archcode/config.json`。

### 4.2 首次创建

`ServerConfigService.initialize(candidate)`：

- 仅在 Config 不存在时可调用；并发调用只有一个成功。
- 在写盘前执行与正式启动相同的完整校验和 ModelRuntime prepare。
- 使用 create-only、同目录临时文件和原子提交，目录权限 `0700`，文件权限
  `0600`。
- Config 已出现时返回冲突，不覆盖、不 merge、不尝试迁移。
- 成功后返回同一种 `ServerConfigActivation`，供 Runtime factory 使用。

Provider 连通性测试不阻塞初始化；Setup 只保证配置有效且 Runtime 可构造，
不把临时网络故障变成无法完成安装。

### 4.3 Auth 字段

持久配置只增加：

```json
{
  "auth": {
    "passwordHash": "$argon2id$..."
  }
}
```

- 只接受 Argon2id PHC 字符串，不接受明文、bcrypt 或可逆密文。
- Hash 不进入 `ServerConfigEditableView`、日志、错误详情或 Web draft。
- Auth Hash 只投影给 ServerAuthService，不进入 AgentRuntime、Prompt、Tool 或
  SSE。
- 通用 Config PUT 必须保留当前 Auth 字段；密码变更只走专用 Auth API。
- Setup 请求携带临时明文密码，ServerAuthService 完成散列后，将内部 Config
  candidate 交给 ServerConfigService；明文不落盘。
- 日常密码设置/修改/移除由 ServerAuthService 串行执行：先通过
  ServerConfigService 的窄方法原子提交 Hash，再替换内存 credential snapshot
  并撤销 Session。通用 Config 保存与 Auth 保存共享同一个 Config 写锁。

## 5. Server Host 与模式切换

### 5.1 单一外壳

只保留一个 HTTP listener 和一套共享外壳，统一负责 request logger、错误处理、
CORS、安全响应头、health、bootstrap 状态和 Web assets。当前模式只决定业务
API 的委派目标，不复制三套完整 Hono 应用。

`ArchCodeServerHost` 的转换固定为：

```text
setup -> activating -> ready
```

- `activating` 期间拒绝第二次 Setup 提交，并让 Web 显示正在完成设置。
- 普通启动遇到有效 Config 时先构造并恢复 Runtime，再启动 Ready listener；
  构造失败则以 `startup_error` 启动受限外壳，不挪用仅属于 Setup 的
  `activating`。
- Config 创建成功后构造 Runtime、执行现有恢复、启动 Automation scheduler，
  再原子切换到完整 Server App。
- Runtime 激活失败时进入只读 `startup_error`，不伪装成 Config 校验错误，不
  重新开放 Setup，也不删除已经写入的 Config；重启后按正常有效 Config 再次尝试。
- Graceful shutdown 改由 Host 持有可选 Runtime：Setup/Error 模式只停止
  listener，Ready 模式先通知并关闭 Runtime，再停止 listener。

这只是首次从 Setup 激活 Runtime，不建设通用 Runtime 热重启、代际管理或
Config watcher。

### 5.2 Setup Grant

- Config 缺失时用 CSPRNG 生成至少 256-bit Token，只保存在当前进程内。
- 终端打印本机可点击的 `http://localhost:<port>/setup#token=...`，同时提示远程
  用户把同一 `/setup#token=...` fragment 用于实际 HTTPS 地址或通过 SSH 隧道
  访问；Server 不猜测公网 hostname。
- Fragment 由 Web 读取后立即从地址栏清除；调用 Setup API 时改放
  `Authorization: Bearer`。
- Setup 页面不加载第三方脚本；logger 不记录 Token 或 Authorization。
- Grant 在 Setup 成功后立即消费，进程退出后自然失效。
- 除 bootstrap 状态和静态页面外，所有 Setup API 都要求有效 Grant。

不使用默认账号、默认密码、公开的“第一个提交者成为 Owner”或持久 Setup
Secret。

## 6. 登录与会话

### 6.1 行为

```text
auth.passwordHash absent  -> Auth middleware bypass
auth.passwordHash present -> 除公开入口外，所有 API/SSE 要求有效 Session
```

Setup 的 Security 步骤默认勾选 `Require login`。用户取消时必须确认：

> Anyone who can reach this server can control ArchCode.

不根据 IP、hostname、开发模式或部署环境改变该规则。

### 6.2 最小实现

- `POST /api/auth/login`：限速验证密码，成功后创建随机 opaque Session。
- `POST /api/auth/logout`：撤销当前 Session。
- Session 仅保存在进程内，具有固定的有界绝对有效期并在访问时惰性清理；
  Server 重启后重新登录，不增加数据库、刷新 Token 或签名密钥。
- Auth Session 直接持有已认证 SSE 的生命周期；登出、密码变更、绝对到期和
  Session 淘汰都会主动关闭对应流，旧客户端重连返回 `401`。
- 密码验证串行进入 Argon2id，失败限速覆盖并发请求，避免并发验证放大内存
  消耗。
- Cookie 使用 `HttpOnly`、`SameSite=Strict`、`Path=/`；HTTPS 下使用
  `Secure`。远程公网部署文档必须要求 HTTPS 或可信反向代理。
- 所有 Cookie 认证的状态变更接口校验同源 `Origin`；不能依赖开放 CORS 代替
  CSRF 边界，也不能盲信 `X-Forwarded-*`。
- Settings 新增 `Security` 页面，设置、修改和移除密码走专用 API。
- 已启用密码时，修改或移除必须再次验证当前密码。
- 密码变更撤销全部旧 Session，并为当前请求签发新 Session；移除密码后清空
  Session。

彻底删除 `ARCHCODE_SERVER_PASSWORD`、现有 Basic Auth middleware 及相关
Protocol 常量、测试和文档。若进程仍传入已退役的
`ARCHCODE_SERVER_PASSWORD`，启动必须给出明确的 hard-cut 错误，不能静默忽略
后变成无认证服务。开发模式不得再由“是否配置密码”推断。

## 7. Web 首次设置

`BootstrapGate` 必须位于 `GlobalSSEProvider` 和工作台 Router 之外：

```text
bootstrap
  |- setup         -> SetupPage
  |- config_error  -> ConfigErrorPage
  |- startup_error -> StartupErrorPage
  `- ready
       |- auth required + no session -> LoginPage
       `- authenticated/no auth      -> WorkbenchApp
```

SetupPage 只包含：

1. `Models`：一个 Provider、至少一个 Model、三个 Profile。
2. `Security`：密码与确认，或明确关闭登录。
3. `Finish setup`。

从现有 Settings 中抽取受控的 Models/Profile 编辑组件供 Setup 和日常 Settings
共用；不复制一套表单，也不建设通用 schema-form 或多步骤向导框架。MCP、
Memory、GitHub、多 Provider、Variants 等高级能力留在 Setup 完成后的 Settings。

Setup 成功后：

- 启用密码：以 Setup Grant 的所有权证明直接签发首个 Session，不要求再次输入。
- 不启用密码：直接进入工作台。
- Web 重新读取 bootstrap 状态后才挂载 SSE 和业务查询。

## 8. Protocol 与 API

在 `@archcode/protocol` 增加严格 DTO：

- `BootstrapStatus`：`setup | activating | ready | config_error |
  startup_error`，以及 Ready 状态下的 `authRequired`、`authenticated`。
- `CompleteSetupRequest/Response`。
- `LoginRequest`、`AuthStatus` 和密码变更请求。

不把 Config Hash、Setup Token、Session ID 或内部 Runtime 错误对象放入
Protocol DTO。

## 9. 硬切清单

| 删除 | 唯一替代 |
|---|---|
| 启动前必须成功创建 Runtime | 先启动 Host，再按 Config 状态激活 Runtime |
| `ServerConfigService.loadForStartup()` | `activateForStartup()` + Ready 前置条件 |
| `createRuntime()` 内隐式读 Config | 显式注入 Config service 与同次产生的 activation |
| 缺失 Config 的 fatal exit | Setup Mode |
| `ARCHCODE_SERVER_PASSWORD` | `auth.passwordHash`；旧 ENV 存在时 fail-fast |
| Basic Authorization | 登录 API + opaque Session Cookie |
| 密码是否存在决定 dev/CORS | 编译/显式 Server 选项决定开发模式 |
| Web 启动即连接 SSE | BootstrapGate 后才挂载 Workbench |

不得保留环境变量密码、Basic Auth、旧启动 fallback、自动迁移、双路 Config
读取或兼容别名。

## 10. 非目标

- 用户表、注册、邀请、多用户、RBAC、OAuth/OIDC、找回密码。
- 持久 Session、JWT、refresh token、跨实例 Session 共享。
- 通用安装框架、插件式 Setup 步骤或 Config 修复编辑器。
- 根据本地/远程自动切换认证规则。
- Provider 网络探测、自动发现模型规格或默认伪造 Provider。
- Config watcher、运行时通用重启或多代 Runtime 并存。
- 原生 TLS 证书管理、反向代理自动配置。

## 11. 实施顺序

1. **Config startup hard cut**：增加启动判别、typed activation 与 create-only
   initialize，重构 Runtime factory，删除旧 `loadForStartup()` 隐式链路。
2. **Server Host**：抽出单 listener/mode dispatcher、Setup Grant、受限 Setup
   API 和可选 Runtime 生命周期。
3. **Auth**：增加严格 Config 字段、Argon2id、Session/Cookie、专用 Auth API，
   删除环境变量 Basic Auth。
4. **Web**：增加 BootstrapGate、Setup/Login/ConfigError 页面，抽取并复用
   Config editor，增加 Settings Security。
5. **纵向清理**：更新 README、`docs/architecture.md`、`docs/web/architecture.md`
   和 AGENTS；删除旧文案、常量、测试夹具和 fallback。

每一步完成后保持可测试，但不以长期双路径兼容为代价拆分上线。

## 12. 验收标准

- 全新 HOME 直接运行二进制可打开受 Token 保护的 Setup 页面，不需要 CLI
  初始化或手工 Config。
- Setup Mode 下所有项目、文件、Session、Tool、Automation 和 SSE API 均不可用。
- 两个并发 Setup 提交只有一个可创建 Config；失败请求不得覆盖文件。
- Setup 生成的 Config 权限、严格校验、敏感值和三 Profile 引用全部正确。
- Setup 完成后同一端口进入 Ready，无重启、无第二个 listener、无空 Runtime。
- Config 无效时展示只读错误且不开放 Setup；Runtime 构造失败展示独立的脱敏
  Startup Error，不误报为 Config 错误。
- 无密码时不登录；有密码时 API/SSE 全面受保护，密码错误受限速。
- Config 和 API 永不返回明文密码或 Password Hash；Cookie 不进入 Web Storage。
- 修改密码撤销旧 Session；Session 到期和重启进程都会使其失效。
- `ARCHCODE_SERVER_PASSWORD` 只允许存在于唯一 fail-fast guard、对应测试和迁移
  说明；Protocol 常量、Web Cookie、Basic Auth、Runtime secret 注入和正常认证
  路径中不得存在。旧 Config 启动 fallback 必须为零。
- Server/Agent Core/Web 定向测试、全仓 typecheck/test/build、`git diff --check`
  通过；生产二进制在临时 HOME 完成首次设置、登录、刷新、重启和无密码路径验收。
- 浏览器在 390px 和桌面宽度验证 Setup、错误、登录和工作台切换；控制台无错误，
  Token 清理后地址栏不再包含 Fragment。

## 13. 架构自审

- **高内聚**：Config、Host、Setup Grant、Auth 和 Web Gate 各自只有一个状态
  所有者，没有跨层文件写入或认证判断。
- **低耦合**：AgentRuntime 不感知 Setup；Setup 不构造残缺 Runtime；Web 只消费
  Protocol DTO。
- **硬切**：新 Host、Session Auth 和显式 Config 激活分别替代旧链路，不保留
  Basic/ENV/隐式加载 fallback。
- **不过度设计**：无账号表、JWT、持久 Session、通用状态机、安装框架或 Runtime
  代际管理；Setup 只有一次单向转换。
- **失败关闭**：Token 无效、Config 冲突、Config 无效、旧 ENV 残留或 Runtime
  激活失败时都不暴露完整工作台，错误信息经过 Secret redaction。
