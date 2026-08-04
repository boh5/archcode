# Runtime Control Plane Recovery Plan Goal

> 本文定义 Runtime 启动故障隔离、人工数据清理与无效全局 Config 恢复的实施、验收契约；实施状态与证据始终单独记录。

## Objective

将 Server 控制面与 `AgentRuntime` 生命周期彻底解耦：全局配置有效时，即使 Runtime 因项目持久化数据损坏、格式不符合当前严格 schema 或其他启动阶段错误而激活失败，HTTP、认证、完整 Settings、配置管理和现有升级功能仍然可用。已认证用户直接进入完整 Settings，并在新增的 `Runtime Data` 页面查看检测到的损坏或不符合当前格式的数据、手动选择项目并删除其整个 `.archcode/runtime/`，随后由同一进程重新激活 Runtime。

经后续 review 批准，控制面还必须覆盖无效全局 Config：进程继续提供 Web 与 Updates，通过终端一次性凭证进入 Settings 的 `Config Recovery`。首选恢复方式是用户勾选服务端识别出的无效配置项；服务端删除所选项后必须对完整候选 Config 做当前严格校验，只有完全有效才原子写入，从而保留其余有效的模型、Profile、MCP 与安全配置。用户也可外部修复后同进程 Retry；删除整个 Config 仅作为要求输入 `RESET` 的最后手段并进入现有 Setup。

升级只负责升级，保持现有 `About & Updates` 界面与文案；不得把升级与 Runtime 数据保留、检查或删除建立产品依赖。

## Locked Architecture

```text
ServerHost control plane (always available after valid Config activation)
  ├─ health / bootstrap / auth
  ├─ config / updates
  ├─ token-protected config recovery
  ├─ runtime status + retry
  ├─ runtime-data inspect + delete
  └─ embedded Web assets

AgentRuntime plane (only when activation succeeds)
  └─ projects / sessions / todos / automations / HITL / tools / MCP / SSE
```

- `ServerHost` 分别拥有控制面状态与 Runtime 状态。有效配置先激活认证，再尝试 Runtime；Runtime 失败不能把控制面降级为不可用。
- HTTP listener 必须在 Runtime 激活前完成绑定；`ServerHost.create()` 只构造控制面，`bootServer()` 先发布 health、bootstrap、auth、Settings 与静态资源，再异步启动 Runtime。Runtime 激活缓慢、挂起或失败都不得延迟控制面的首个可用响应。
- `BootstrapStatus` 的 ready 状态显式携带 `runtime: activating | ready | error`。删除顶层 `startup_error` 模式及其只提供 `Retry` 的阻塞页面，不保留 alias、双协议或 fallback。
- Config routes 从 `createRuntimeApp()` 移到 ServerHost 控制面；Update routes 去除 Runtime-ready 前置条件。Runtime-backed API 在 Runtime 不可用时继续明确返回 `503`。
- Runtime 重试由 ServerHost 串行化；任一时刻最多一次激活。每次激活都通过 Config service 重新读取磁盘上的当前有效配置并取得新的 `ServerConfigActivation`，绝不缓存复用旧 activation；Config PUT、Runtime Data 删除和 Runtime 激活进入同一个 Host 串行 mutation boundary。失败的半成品 Runtime 必须完整 shutdown 后才能记录错误或再次重试，成功后再原子替换 Runtime app。
- 首次 Setup 的 Config 一旦成功提交，Setup grant 即消费，认证立即生效；随后 Runtime 激活失败只产生 ready 控制面加 `runtime.error`，不能把已提交的 Setup 当作整体失败。需要认证时仍签发本次 Setup session，Web 直接进入完整 Settings 恢复界面。
- `packages/agent-core/src/runtime-data/` 新增一个窄的 Runtime 数据服务，直接复用各领域的当前严格 schema，不复制 schema，不引入通用 validator registry、数据版本或 migration framework。
- 首版只检查用户可以通过整项目 Runtime 删除处理的五类严格 JSON 权威文件：
  - `sessions/*/session.json`
  - `todos/state.json`
  - `automations/state.json`
  - `hitl-queue.json`
  - `permissions.json`
- 这些检查结果只表达“检测到损坏或不符合当前格式的数据”，与 Runtime 启动错误摘要分开展示；不得声称每条问题都是本次启动失败的直接原因。缺失文件按该领域当前的空状态语义处理；结果只区分 `invalid_json`、`invalid_current_schema` 和 `unreadable`。schema 不匹配不得猜测由哪个版本产生，也不展示原始持久化内容或 secret-bearing values。
- 删除粒度固定为注册项目的整个 `<workspace>/.archcode/runtime/`。请求只接受 `projectSlug` 集合，路径由服务端通过 `projectRuntimePath()` 解析；客户端不得提交任意文件路径。
- 检查和统计全程 no-follow；Runtime 树中任一被检查的文件、目录或统计遍历项是 symlink 时，记录脱敏的 `unreadable` 问题且绝不读取其目标。
- Runtime Data 删除只在 Runtime 不可用且该项目当前存在检测问题时开放。删除前重新检查，并拒绝 workspace、`.archcode`、`runtime` 或 Runtime 后代中任一路径为 symlink、异常文件类型或解析后越界的目标。
- 一次删除命令全部成功后重新检查并自动重试 Runtime 一次；任一项目删除失败则不重试，返回逐项目错误。重试成功进入工作台，失败继续停留在 Settings 并显示最新问题。

## User Experience

- Runtime 失败且认证完成后，页面直接显示完整 Settings workspace，默认选中 `Runtime Data`；不是只显示一个升级按钮或孤立错误页。
- Settings 侧栏在现有 `Server` 分组中增加 `Runtime Data`，`About & Updates` 仍使用现有面板、行为和文案。其他 Settings 页面也保持可导航。
- Runtime Data 顶部单独显示 Runtime 当前状态与安全的启动错误摘要；下方数据检查结果不标注为启动根因。项目列表显示项目名、workspace、Runtime 路径、数据大小/文件数，以及失败的相对文件和原因。
- checkbox 默认全部未选中；只允许选择当前存在检测问题的项目。页面只有一个主要破坏性动作 `Delete runtime data`。
- 确认对话框逐项列出将删除的项目与目录，并明确说明会丢失 Sessions、Todos、Automations、HITL、permissions、attachments 和 project memory；同时明确源码、`.git`、`.archcode/plans`、`.archcode/skills`、项目注册信息与 `~/.archcode/config.json` 不受影响。
- 删除不可撤销，不伪装成可恢复操作，也不提供虚假的 Undo。加载、删除、重试和逐项目失败必须就地显示；状态不能只靠颜色表达。
- Runtime Data 提供次要动作 `Retry Runtime`，用于无数据问题或用户保存 Settings 配置后的重新激活；配置保存成功时不得在 Runtime 不可用状态下宣称“applied live”。
- 新增 `design-system/pages/settings.md` 记录上述 Settings 专属状态和布局规则；不改全局视觉语言，也不为这个方向明确的常规 Settings 扩展创建 HTML prototype。
- Config Recovery 默认提供 `Preserve valid settings`：安全条目全部默认未选，逐项说明删除影响，确认后仅提交 revision 与不透明条目 ID；候选完整校验不通过时明确告知“未作修改”。整个 Config 重置折叠到最后手段，强提醒有效的 Providers、Models、Profiles、MCP、Memory、GitHub 与登录/安全配置均会丢失，并要求输入精确 `RESET`。

## Implementation Plan

1. **硬切 Bootstrap 与 ServerHost 状态模型**
   - 把 Host 构造、HTTP listener 绑定和 Runtime 启动拆成明确阶段：先构造并监听控制面，再异步请求 Runtime 激活；不得在 `main.ts` 或 `ServerHost.create()` 中 await Runtime 后才监听。
   - 将 ready 控制面状态与 Runtime 子状态分开；删掉旧 `startup_error` Protocol、Host 和 Web 分支。
   - 认证在有效配置后、Runtime 创建前激活；Runtime 激活、清理与重试集中由 ServerHost 串行拥有。首次 Setup 提交成功后的 Runtime failure 返回 ready + `runtime.error` 和应有的登录 session，不回滚 Config、不恢复 grant、不留下 500 死路。
   - 将 Config routes 移出 Runtime app；Update access 仅依赖控制面认证与 mutation admission。没有 Runtime 时，update restart 只需确认不存在控制面 mutation/update 冲突，不再返回 Runtime 503。
   - Config save 和每次 Runtime activation 通过同一 Host mutation queue 排序；激活开始时调用 Config service 取得磁盘当前 revision 对应的新 activation，保存后的旧 activation 不得再次使用。
   - Runtime-backed routes 继续通过一个明确 gate 分发，不把 Runtime nullable 判断散落进领域 routes。

2. **建立窄的 Runtime 数据检查与删除服务**
   - 为上述五类数据添加无副作用检查 adapter，直接调用当前领域 schema/codec；Session 目录结构、JSON parse 和 schema issue 都返回稳定、脱敏的相对路径诊断，不把检测问题冒充实际启动 cause。
   - 按 Project Registry 枚举项目并隔离检查失败；一个项目不可读不得隐藏其他项目结果。以 no-follow 遍历统计整个 Runtime 目录的文件数与字节数，但不解析 attachments 或 memory 内容；后代 symlink 只报告，不跟随。
   - 删除命令验证注册项目、当前检测问题、固定路径 containment 和 symlink 安全后，递归删除整个 Runtime 目录；不注销项目，不触碰 Runtime 外数据。
   - 增加只依赖该服务的 Protocol DTO 和控制面 routes；严格拒绝空集合、重复 slug、未知字段、未注册项目、健康项目和客户端路径。

3. **实现同进程恢复闭环**
   - ServerHost 协调“删除全部成功 → 重新检查 → Runtime 激活一次”，并返回每个删除结果及最终 Runtime 状态。
   - 重试期间拒绝第二次 retry/delete，并与 Config save 串行；失败的 Runtime 完成 cleanup 后才解除 admission。普通 Runtime API 始终只看到最后一个完整成功实例。
   - Runtime 失败日志保留完整内部 cause；API/UI 只返回安全摘要和 Runtime Data 服务生成的结构化问题，不回显持久化原文。

4. **重构 Web 启动壳与 Settings**
   - 将 Query、Toast 和 Settings 所需 provider 移到 BootstrapGate 外；Global SSE、项目 modal 与工作台 Router 只在 Runtime ready 时挂载。
   - Runtime error 时复用同一个 Settings workspace 作为全屏恢复界面；Runtime ready 时仍通过现有 Settings dialog 打开同一内容组件，不复制两套页面逻辑。
   - 让 Settings 各 section 明确声明数据依赖：`Runtime Data` 与 `About & Updates` 不等待 Config/MCP；配置页面使用控制面 Config API；MCP 实时状态在 Runtime 不可用时明确显示 unavailable，而不是拖垮 Settings。
   - 实现选择、确认、pending、逐项目错误、手动/自动重试结果、键盘/focus 和窄屏行为；Runtime 不可用时 Config save 只显示已保存，并引导使用 `Retry Runtime`，不声称 live apply。同步 Settings page spec。

5. **删除旧耦合并完成验证**
   - 删除 Config route 的 Runtime owner、Update 的 Runtime-ready gate、旧 Bootstrap startup-error blocking UI 及只服务这些旧路径的测试/helper。
   - 不保留 feature flag、deprecated alias、双状态 reader 或墓碑测试；把仍有价值的行为覆盖迁移到新 owner。
   - 通过 Agent Core、Server、Web interaction、真实浏览器和 production build 验收完整失败与恢复链。

6. **补齐无效 Config 的最小恢复面**
   - 将原 Setup 终端凭证重构为进程内 `TerminalGrant`，同一凭证可从 `Config Recovery` 延续到 Reset 后的 Setup；有效 Config 激活后立即消费，只出现在启动终端打印的 URL fragment 中，不写入 URL query、API DTO 或磁盘。
   - `config_error` 保存服务端生成的脱敏结构诊断；Bootstrap 只返回通用提示。新增 token-protected GET/Retry/Reset，Retry 重读磁盘并切换到 ready、setup 或更新后的 config_error；整个 Config 的 Reset 只允许删除当前仍无效的 canonical Config，若文件已被并发修好则拒绝删除。
   - Config Recovery 使用完整 Settings 壳；仅 `Config Recovery` 与原 `About & Updates` 可用，其余 Config/Runtime 依赖页面保留在导航中并明确 disabled。不得加入在线 JSON 编辑、自动修复、迁移、备份、fallback 或旧兼容层。

7. **增加保留有效 Config 的人工选择恢复**
   - Config service 从当前严格 schema/语义错误生成有限的删除目标；不允许删除必需的 `profiles`、`auth`，条目 ID 绑定文件 revision 且不包含原始 key/value。API/UI 只显示脱敏结构标签与精确影响范围。
   - 用户提交非空、唯一的条目 ID 后，在同一 Config 写锁内重新读取并核对 revision，删除所选路径，执行完整 schema、语义交叉引用和 ModelRuntime prepare 校验。只有全部通过才以 `0600` 原子写入并同进程激活；任何 stale、未知、删除不足或仍无效结果均零写入。
   - Web 默认不选任何条目，先展示保留有效设置的选择区，再保留外部修复 Retry。删除所选项有强提醒和二次确认；整个 Config Reset 被折叠并要求输入 `RESET`，不增加自动选择、自动修复、数据迁移或升级联动。

## Non-goals

- 不实现数据迁移、格式版本、legacy reader、双读双写、自动选择/自动修复、备份/恢复、Undo 或启动时自动删除；仅允许用户手动确认服务端给出的有限无效项。
- 不实现文件级或数据类别级删除；不允许用户编辑 Runtime JSON，也不接收客户端任意路径。
- 不隔离单个坏项目后让其他项目 Runtime 部分启动；首版仍是一个 AgentRuntime，失败时进入控制面恢复界面。
- 不把 attachments、memory Markdown 或 cwd migration journal 建成通用健康检查系统；它们随项目 Runtime 整体删除，但不是首版启动前 schema 扫描对象。
- 不改变 Project 关闭/注销语义，不删除 Project Registry，不触碰源码、Git、Plans、Skills 或全局配置。
- 不改变现有 Updater 页面、升级文案、更新源、安装流程或版本选择逻辑，也不添加“想保留数据请先升级”。
- 不提供在线 Config JSON 编辑器、自动 Config 修复、备份/恢复、迁移、legacy reader 或旧格式兼容；升级仍只负责升级。

## Risks And Controls

| 风险 | 控制方式 |
|---|---|
| 项目 Runtime 删除不可恢复 | 默认不选、逐项目确认、明确列出损失与保留范围；无自动删除、无假 Undo |
| 路径穿越或 symlink 导致越界删除 | API 只收 slug；服务端固定解析、realpath/containment/lstat 校验，任何 symlink 或异常类型 fail closed |
| 检查逻辑与生产 schema 漂移 | 直接复用领域当前 schema/codec，不复制字段，不建第二套兼容 schema |
| Runtime retry 与删除/升级并发 | ServerHost 单一 admission 与串行激活；半成品先 shutdown，完成前不发布 Runtime app |
| Config 保存后旧 activation 已失效 | Config save 与激活串行；每次激活从磁盘重新取得当前 revision 的新 activation，不缓存旧对象 |
| 检测问题被误写成启动根因 | 启动错误与数据健康结果分区展示；DTO 和文案不声明因果，只允许用户显式选择 |
| 诊断泄漏 Session 内容或密钥 | DTO 只含项目身份、相对路径、issue path/message 和统计；不返回原文或 raw invalid value |
| 控制面解耦后误放开 Runtime API | Auth 与 origin checks 保持在控制面；Runtime route gate 独立测试 503/401/403 边界 |
| 选择删除误伤有效 Config 或遇到并发外部修改 | 删除目标有边界且 ID 绑定 revision；服务端在同一写锁内重读、全量校验候选并仅在完全有效时原子写入，失败零修改 |

## Acceptance Criteria

以下 AC-01 至 AC-08 必须全部有代码、自动化测试或真实浏览器证据；任一缺失即为 `NOT_DONE`。

### AC-01：控制面不再依赖 Runtime ready

- 使用可控 deferred Runtime factory 阻塞激活：listener 已绑定期间 `/api/health`、embedded Web、Bootstrap 和认证必须可响应，Bootstrap 显示 `runtime.activating`；释放为失败后原地转为 `runtime.error`，不能要求进程重启。
- 使用会在 `recoverSessionContinuations()` 或 `startAutomationSchedulers()` 失败的 Runtime fixture 启动 Host：`/api/health` 和 embedded Web 返回 200；有效凭据可登录；Bootstrap 返回 ready 控制面和 `runtime.error`，不返回旧 `startup_error`。
- 在同一状态下，认证后的 Config GET/PUT、provider catalog、Security 与 Update GET/check/install 均到达各自服务，不能因 Runtime 缺失返回 `SERVER_NOT_READY`；未认证和跨 Origin mutation 仍按现有安全规则拒绝。
- 首次 Setup 提交 Config 后让 Runtime fixture 失败：Config 逐字节保留、grant 已消费、Host 返回 ready + `runtime.error`；需要认证时响应签发有效 session，浏览器直接进入 Settings/Runtime Data，不出现 500 或要求重新 Setup。
- 任一 Projects/Sessions/Todos/Automations/HITL/MCP/Runtime SSE API 在 Runtime 不可用时稳定返回 503；Runtime 成功后同一路由由唯一 Runtime app 处理。
- production source 与 Protocol 中不存在旧 `startup_error` 分支、Config-in-Runtime route 或 Update 的 Runtime-ready 前置条件。

### AC-02：检查结果准确、有限且脱敏

- 自动化测试逐一覆盖五类被检查文件的合法、缺失、无效 JSON、当前 schema 不匹配和不可读状态；问题包含 projectSlug、workspace、Runtime path、相对文件、稳定分类与 schema issue，且不包含原始 JSON value、Session message 或 secret。
- 多项目测试证明每个项目独立报告；一个项目读取失败时，其他项目的结果和统计仍完整返回。
- Runtime 启动由项目 A 的 Session 失败触发、项目 B 仅有无效 Todo 时，UI/DTO 必须把启动错误与两个数据检查结果分开展示，不得把 B 标记为此次启动失败原因。
- schema mismatch 文案只表达“不符合当前 ArchCode 数据格式”，不推断旧版、新版或具体产生版本。
- Runtime 内 Session 目录 symlink、`session.json` symlink 和统计遍历 symlink fixture 均只产生脱敏问题；边界外 sentinel 不被读取、修改或删除。
- 检查代码直接引用当前领域 schema/codec；代码审计不存在复制 schema、version field、migration registry 或 generic repair framework。

### AC-03：删除边界与恢复结果确定

- 删除 API 严格只接受非空、无重复的 `projectSlugs`；未知字段、未注册项目、健康项目、客户端 path 和 Runtime-ready 状态全部被拒绝且文件不变。
- symlink、路径越界、非目录和权限失败 fixture 均 fail closed；不得删除 workspace、`.archcode` 或 Runtime 外任意文件。
- 启用认证时，未登录 inspect/delete/retry 均返回 401；跨 Origin delete/retry 按现有 mutation-origin 规则拒绝。以上失败时目录内容、Runtime 状态和激活次数全部不变。
- 成功删除后，所选项目 `.archcode/runtime/` 完全不存在；源码、`.git`、`.archcode/plans`、`.archcode/skills`、Project Registry、全局 Config 和未选项目逐字节不变。
- 多项目命令全部删除成功时只自动激活 Runtime 一次；任一删除失败时激活次数为 0。激活成功返回 `runtime.ready`，激活失败完成 cleanup 并返回新的 `runtime.error`，不存在半发布 Runtime。
- Runtime error 状态下先保存 Models/Profiles，再手动 retry 或成功删除：新 Runtime 使用磁盘最新 revision 对应的 Config，旧 activation 从未复用，且激活次数为 1；并发 Config save/delete/retry 按 Host mutation queue 确定排序。

### AC-04：Settings 提供完整可操作的恢复界面

- Runtime failure 且认证完成后，首屏是完整 Settings workspace并默认选中 `Runtime Data`；侧栏可进入 Models、Profiles、Security、MCP、Memory、GitHub 和现有 `About & Updates`，不出现只有 Retry/Upgrade 的阻塞页。
- Runtime Data 覆盖 loading、无问题、多个问题、检查失败、删除 pending、部分删除失败、retry 成功和 retry 失败状态；checkbox 默认全不选，健康项目不可选，未选择时删除按钮 disabled。
- 确认 dialog 精确列出所选项目、Runtime 目录、会丢失与会保留的数据；Cancel 不发请求，Confirm 在 pending 时防重复，完成后焦点与状态反馈可由键盘和 screen reader 感知。
- `About & Updates` 继续渲染现有 `SettingsUpdatesPanel`，产品文案中不存在数据保留、Runtime 兼容或“先升级”提示。
- light/dark 及 390、760、1024、1440px 下 Settings 无 document 水平滚动、主要操作不被遮挡；错误/选择/状态均不只靠颜色表达。

### AC-05：严格重构且无过度设计

- Runtime app 只组合 Runtime-backed routes；ServerHost 控制面集中拥有 auth/config/update/runtime-data/runtime lifecycle，Web 与 Protocol 仍不依赖 Server 或 Agent Core。
- 生产代码中不存在旧启动错误 UI、旧状态兼容 reader、fallback route、feature flag、自动 migration/backup/restore、任意路径删除或文件级修复入口。
- 不新增通用 Repository、validator registry、storage framework、项目级 Runtime 容错层或只被一个调用点包装的公共 manager。
- 测试只证明新契约与关键安全边界，不增加只断言旧字段、旧页面或旧 endpoint 已死亡的墓碑测试。

### AC-06：端到端验收与交付证据完整

- 集成测试使用两个注册项目：一个写入当前 schema 不接受的 Session fixture、一个保持健康；验证 Host 仍可登录并打开 Settings、只删除坏项目 Runtime、保留两项目注册、同进程恢复为 Runtime ready，坏项目以空 Runtime 状态重新使用，健康项目数据不变。
- 真实浏览器使用非 mock Server 完成：进入 Runtime Data、查看问题、默认未选、取消确认、确认删除、自动恢复并进入工作台；另验证 Update 页面在 Runtime error 状态可打开且界面无新增联动文案。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0；浏览器 console error 为 0。
- Reviewer 按 AC-01 至 AC-08 逐项给出文件、测试、命令和浏览器证据；不能以“测试通过”替代逐项验收，未执行项不得写成完成。

### AC-07：无效 Config 可安全自助恢复

- 无效 JSON、严格 schema 不匹配和不可读 Config 均不阻止 listener、Web、health 与 Bootstrap；终端打印 `/config-recovery#token=...`，无 grant 的 diagnostics、Retry、Reset 和 Updates 均为 401，跨 Origin mutation 为 403。
- 恢复 API/UI 只显示 canonical Config path、脱敏结构 path 与通用原因；包含 unknown key、provider/model/server ID 或 secret sentinel 的原始内容不得出现在 Bootstrap、recovery DTO 或 DOM。
- 用户外部修复文件后点击 Retry：同一进程激活认证并进入 ready + Runtime activating，grant 失效；文件被外部删除时，同一 grant 直接进入 Setup。
- 整个 Config Reset 必须要求输入精确 `RESET`，并明确有效 Providers、Models、Profiles、MCP、Memory、GitHub 与登录/安全配置都会丢失；Cancel 零请求，Config 已并发修好时返回冲突且逐字节保留；成功后同一 grant 可使用 Setup，项目源码、Git 和 Runtime 数据不变。
- Config Recovery 首屏使用完整 Settings shell，默认选中自身；仅自身与原 About & Updates 可操作，其他页面显示为带原因的 disabled。无在线编辑、自动修复、migration、backup、fallback 或 upgrade 联动。

### AC-08：只删除人工确认的无效 Config 项并保留有效配置

- 对可安全界定的 unknown field、Provider、Model、Variant、Provider option、MCP server、Memory 或 GitHub integration 错误，GET 返回 revision 及默认未选中的脱敏条目；ID 不含原始 key/value，DTO 与 DOM 不泄漏 provider/model/server ID 或 secret sentinel。可精确删除 `profiles`/`auth` 内的 unknown extra field，但必需 Profile/Auth 记录、无效必需值、无效 JSON 和不可读文件不得伪造可删除条目。
- 删除请求严格只接受当前 revision、非空无重复的不透明 item ID 与固定 confirmation。无 grant 返回 401，跨 Origin 返回 403，未知字段/格式返回 400，stale 或未知 ID 返回 409；所有拒绝路径 Config 逐字节不变。
- 服务端在单一写锁内重读同一 revision、仅删除所选路径，并对完整候选执行当前 strict schema、语义交叉引用和 ModelRuntime prepare。删除后仍存在任一错误时返回 422 且文件逐字节不变；完全有效时才以 `0600` 原子写入、保留所有未选配置并同进程进入 ready/Runtime activation。
- Web 的选择项默认全不选，未选时操作 disabled；确认 dialog 列出所选项及影响，明确删除永久且“剩余 Config 完整有效才写入”。Cancel 零请求，pending 防重复。整个 Config Reset 位于分离的最后手段区域并要求输入 `RESET`。
- 自动化测试至少证明：单个 invalid field 删除后 Provider secret、Models 与 Profiles 保留；只选多项错误的一部分返回 422 且 bytes unchanged；revision 并发变化、重复/未知 ID、不可删除 Profile 错误 fail closed。真实浏览器完成选择、取消、确认、恢复及 390/1440px、console error 0 验收。
