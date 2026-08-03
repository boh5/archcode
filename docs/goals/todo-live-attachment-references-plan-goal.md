# Todo 实时附件引用 Plan Goal

## 目标

让 Todo 成为 PRD、图片、PDF 等工作资料的持久归属，且所有由该 Todo 发起的 Discussion、Work Session、子 Agent 和 Todo 来源的 Automation Session 都在运行时读取 **Todo 当前的附件集合**。

这里的“实时引用”是硬约束：附件不复制进 Session、不写入 Session 消息、不生成启动时快照；Todo 是唯一事实来源。现有 Session 附件投影链路在组装模型输入或工具读路径时，直接合并 Todo 当前引用。已经发出的单次模型请求或已经开始的单次工具调用不会被中途改写，下一次使用附件时必须看到最新增删结果。

## 已锁定的产品与架构决定

1. Todo 附件是 Todo 的持久资料，不是某条消息的附件；Session 附件仍是某条 Session 消息的不可变输入，两者语义不合并。
2. Todo 只保存有序 `attachmentIds`，文件内容和元数据由项目级附件存储负责；状态 JSON、API JSON、SSE 均不承载二进制或 Base64。
3. Todo 绑定的整个 Session family 都使用实时引用，包括根 Discussion/Work Session 和其子 Agent。
4. Todo 来源的 Automation 创建新 Session 时必须保留 Todo 身份并使用实时引用。`RootSessionSource` 的 automation 分支硬切增加必填 `todoId: string | null`：Todo 来源写稳定 ID，直接创建或普通 Session 来源写 `null`。不能在运行时回查 Automation origin；向既有 Session 发消息时，以该 Session 自己的根来源为准。
5. 图片按当前模型能力进入模型输入；PDF 和普通文件以受管路径及元数据进入上下文，由 Agent 按需读取，不自动全文注入。
6. 提供内置、受限的原生文本 PDF 读取工具，不依赖用户机器上的 `pdftotext` 等外部 CLI；本期不做 OCR、Office 转换、索引、向量检索或通用解析器框架。
7. 单个 Todo 最多保留 10 个有效引用，单文件最大 50 MiB；按添加顺序展示，本期不做排序。
8. 附件硬切到 `.archcode/runtime/attachments/{sessions|todos}/...`。不迁移旧数据，不读取旧路径，不保留兼容分支或 fallback，不增加墓碑测试；用户负责清除历史数据。
9. Quick Capture 继续只收文本；附件在 Todo 详情页管理。Board 卡片不展示附件控件或数量，避免把资料管理扩散到主列表。

## 当前缺口

- 现有附件服务、上传/下载 API、消息接收、模型投影和精确读授权都以 Session 为所有者。
- `ProjectTodo` 没有附件引用，Todo 详情也没有 References 区域。
- Todo 发起 Session 时只发送正文；Automation 新建的根 Session 来源没有携带原 Todo 身份。
- 当前文件读取拒绝 PDF，且项目没有可随编译产物交付的 PDF 文本读取能力。
- 当前附件目录不在 `.archcode/runtime/**`，没有完整落入系统管理状态的保护边界。

## 目标架构

### 1. 存储与职责

- `ProjectAttachmentStorage` 是一个项目内的具体内部类，只负责附件的公共文件系统机制：所有者路径、流式写入、临时文件原子替换、路径围栏、SHA-256、元数据读取和物理清理。它不是可插拔接口，不引入 provider、registry 或通用 Blob 抽象。
- `SessionAttachmentService` 组合公共存储，继续负责 Session/root 校验、消息所有权和现有 Session 语义。
- `ProjectTodoAttachmentService` 组合公共存储与 Todo 服务，负责 Todo 附件的上传、列出、下载、移除、容量限制、revision 并发控制和变更事件。
- 现有 Session attachment projector 与 `resolveAttachmentReadPaths` 回调从 root Session source 找到 Todo，并向原有 Session 附件集合合并 Todo 当前描述符/路径；Runtime 只提供一个窄组合回调，不新增独立 live resolver/service、监听器、缓存失效或权限子系统。

不引入全局 BlobStore、跨 Todo 去重、引用计数、后台 GC、附件库或解析器注册表。

### 2. 状态与 API

`ProjectTodo` 硬切增加有序 `attachmentIds: string[]`。通用 Todo PATCH 不允许直接修改它，所有变化必须经过附件服务并使用 `expectedRevision`。

新增项目级 Todo 附件 API：

- `GET /api/projects/:slug/todos/:todoId/attachments`：按 Todo 顺序返回 `{ todoRevision, attachments }`。
- `PUT /api/projects/:slug/todos/:todoId/attachments/:attachmentId`：原始请求体上传，显式携带名称、大小和 `expectedRevision`；文件完整验证并落盘后才激活引用，返回 `{ todo, attachment }`。
- `GET /api/projects/:slug/todos/:todoId/attachments/:attachmentId`：图片/PDF 使用安全 inline disposition 供单一 `Open` 操作，其余类型使用 attachment disposition 供单一 `Download` 操作；禁止 HTML/SVG 等主动内容 inline。
- `DELETE /api/projects/:slug/todos/:todoId/attachments/:attachmentId`：用 `expectedRevision` 解除引用并增加 revision，返回更新后的 `{ todo }`。

状态中的有效引用是权威。Web 多文件上传必须串行激活并使用上一次 mutation 响应的 revision，SSE 只负责刷新，不能充当事务回执。上传发生 revision 冲突时必须清理本次未激活对象。

Remove 在同一 Todo mutation gate 内先原子提交 Todo 解除引用和 revision，再同步 best-effort 删除物理对象。状态提交后逻辑移除即成功；物理删除失败只记录带 Todo/attachment ID 的结构化 warning，不回滚引用、不返回矛盾的失败结果，也不增加 cleanup journal、恢复流程或后台 GC。极端崩溃窗口可能留下 API 不可达的孤儿文件，这是本期为保持简单而接受的明确取舍。

新增和移除沿用 Todo 的 `resource.changed` 通知。删除 Session family、归档或 Reject Todo 都不删除 Todo 文件；只有显式 Remove 才解除引用。删除 Automation 也不能改变已经创建的 invocation Session 所持久化的 Todo 身份。

### 3. 实时上下文与权限

在现有模型 attachment projection 阶段，从 root Session source 获取当前 Todo，读取最新 `attachmentIds`，验证 owner、元数据和 canonical 路径，然后给本次模型输入增加不落盘的 `Current Todo References (live)` 用户内容块。这不是动态 system prompt，也不是新的提示词编译层；摘要规则与 Session 附件一致：上传和幂等重试校验摘要，模型图片经过现有 verified-byte reader 时再次校验，普通路径解析不重读整个文件：

- 它作为瞬时上下文加入本次模型输入，不成为最新用户意图，也不进入 canonical messages、pending input、receipt、SSE、标题、记忆或压缩记录。
- 支持图片的当前 Execution model binding 可接收图片内容；不支持图片的模型和其他文件只接收名称、类型、大小及精确受管路径。
- 动态压缩或 hard compact 后仍在下一次模型调用重新注入，不依赖历史消息保留。

现有 `resolveAttachmentReadPaths` 在工具调用前把 Todo 当前路径与 canonical Session 消息附件路径合并，继续沿用 Session 附件权限：cwd 内遵循普通 workspace 读取规则；worktree 等 cwd 外场景，当前集合中的精确文件路径供 `file_read` 和现有 finite Bash read 免询问，新增 `pdf_read` 复用同一只读例外；其他工具继续使用现有 ask/deny 规则。这里不建立附件目录隔离，也不承诺不同 Todo 之间形成秘密边界。新增引用从下一次调用可用；移除引用不再出现在下一次路径集合中。已经发出的模型请求、已打开文件或已开始的工具进程不做追溯撤销。

Todo 来源的 root、子 Agent 和 Todo 来源 Automation 的新 root 都走同一条现有附件投影链路；直接 Session 没有 Todo 来源时不合并 Todo 引用。Todo 引用不会在 `.archcode/runtime/attachments/sessions` 下产生副本。

### 4. PDF 读取

增加窄用途 `pdf_read` 工具：只接受已授权的本地 PDF 路径、1-based `startPage` 和 `pageCount`（1–20，含起始页）；缺省为从第 1 页读取 1 页。inline 最多返回 51,200 UTF-8 bytes，溢出必须通过现有 ToolOutputFinalizer 生成授权 artifact，并明确标记 truncated，后续只通过现有 `output_read`/`output_search` 分页恢复，不能静默丢失。它只提取原生文本，不执行脚本、宏、内嵌附件或网络请求。

`pdf_read` 进入与 `file_read` 相同的只读 capability package：任何 AgentDefinition 只有在获准 `file_read` 时才同时获准 `pdf_read`，不增加角色特例。

实现所选库必须兼容 Bun、开发运行和编译后的 ArchCode 二进制。正常文本 PDF 返回页级文本；损坏、加密/需密码、扫描件或无可提取文本必须返回可区分的明确结果，不静默降级到外部命令或 OCR。

### 5. UI/UX

遵循 `design-system/MASTER.md` 和 `design-system/pages/todos.md`：

- Todo 详情主栏在 Brief/PRD 与 Plan 之间加入平面、安静的 `References` 区域，不增加 Tab、抽屉、嵌套卡片或新的页面层级。
- 支持按钮和拖放添加；行内呈现缩略图或文件图标、文件名、大小、上传中/失败状态、重试、按安全类型二选一的 Open/Download，以及 Remove。本期不为百分比进度增加 XHR、分片或上传任务系统。
- Remove 明确提示：该文件会从所有关联 Session 的后续调用中立即失效。
- Session 顶部已有 Todo 来源信息旁，以弱强调文字展示 `Using live Todo references` 或等价可访问文案；不查询或同步附件数量，不新增卡片、横幅或新的导航入口。
- 明确微文案：文件保存在本机项目；进入 Agent 工作时当前引用可被读取；图片可能发送给所选模型提供商。
- 保持桌面与窄屏、键盘、可见焦点、错误/加载反馈、44px 粗指针目标以及亮暗主题一致性。

这属于既有 Todo 详情的小型扩展，默认不新建原型；若实现时现有规范无法消除布局歧义，再先更新当前唯一有效原型，不创建版本化副本。

## 实施计划

1. **硬切协议和持久化**：更新 Todo 与 root Session source 严格 schema、序列化和 Automation dispatch；automation source 必填 `todoId: string | null`。建立新的 runtime 附件目录结构和共享存储机制，重写现有 Session 附件服务接入，不保留旧目录读取。
2. **完成 Todo 附件领域服务**：实现 revision 安全的上传、激活、列出、下载、解除和 best-effort 物理清理；补齐限制、摘要/路径验证、资源变更事件和服务测试。
3. **接入现有附件投影链路**：扩展当前 Session attachment projector 与 `resolveAttachmentReadPaths`，合并 Todo 当前引用；覆盖 root、child、Discussion、Work 和 Automation，确保不写 Session 消息、不复制文件，也不新增另一套提示词或权限系统。
4. **提供 PDF 能力**：实现并注册受限 `pdf_read`，验证权限、范围、输出上限、错误分类以及开发/编译二进制兼容性。
5. **完成 API 与 Web**：接入 Todo References CRUD、上传状态和错误恢复；按设计规范修改 Todo 详情和 Session 来源提示，不扩散到 Board 或 Quick Capture。
6. **更新有效规范和文档**：把跨页实时引用规则写入 `design-system/MASTER.md`，Todo 页面特例写入 `design-system/pages/todos.md`；更新当前 API/架构说明，历史 Goal 文档保持原样。
7. **分层验证**：完成协议、存储、服务、路由、模型投影、工具权限、Automation、Web 状态测试，并用真实 Server 与浏览器完成端到端验收。

## 非目标

- 不做附件快照、Session 复制、历史引用集复现或版本管理。
- 不做 Todo 草稿附件、Quick Capture 上传、Board 附件展示或全局附件库。
- 不做 URL/云盘引用、跨项目共享、去重、引用计数、删除 journal、后台 GC、孤儿扫描、配额设置或隐藏压缩。
- 不做 PDF OCR/渲染、Office/压缩包/音视频解析、全文索引、向量检索或自动摘要。
- 不做附件目录默认拒读、跨 Todo 读取隔离、OS 级沙箱或新的通用权限框架；权限行为与现有 Session 附件保持一致。
- 不迁移或兼容旧状态/旧目录，不保留旧测试作为墓碑。

## 风险与明确取舍

1. **历史不可复现**：旧 Session 的后续调用会看到 Todo 最新资料，而不是启动时资料；移除或替换会改变未来推理。这是实时引用的产品取舍，不用快照补偿。
2. **边界级实时**：正在进行的模型请求、已经打开的文件描述符或已启动工具进程无法被中途改写；变化从下一次模型/工具边界生效，UI 文案和测试必须与此一致。
3. **成本和载荷**：图片可能在多次模型调用中重复发送；10 个、每个 50 MiB 是存储上限而非模型一定可接受的载荷。超出模型/提供商能力时必须显示真实错误，本期不私自增加图片压缩、总量配额或自动降级。
4. **不可信文件**：Todo 资料属于用户提供的数据，不是系统指令。瞬时上下文必须明确标注其来源；PDF 工具不得执行或联网。
5. **PDF 交付兼容**：第三方解析库可能在 Bun 编译二进制中失效，必须用实际生产构建和二进制运行验收，不能只通过单元测试。
6. **删除竞态**：解除引用后，已进行的读取可能完成，未来上下文不再包含该引用；状态提交后的崩溃或文件删除失败可能留下不可达孤儿。系统记录 warning，但本期不为罕见存储泄漏建立 journal/恢复/GC。
7. **信任边界**：Todo 附件与 Session 附件一样属于单用户项目资料，不提供 Todo 间保密隔离。`.archcode/runtime/**` 的现有 mutation 保护仍必须生效，但本 Goal 不把普通 workspace read 改成默认拒绝。

## 验收标准

### AC-01：硬切后的状态与存储

- 新建 Todo 持久化显式空 `attachmentIds`；最多 10 个有效引用，单文件拒绝超过 50 MiB。
- Session 与 Todo 文件只存在于 `.archcode/runtime/attachments/sessions/...` 和 `.archcode/runtime/attachments/todos/...`；代码中不存在对旧 `.archcode/attachments` 的生产读取或写入。
- 状态、API JSON 和 SSE 中不出现文件字节/Base64；运行时路径仍受系统状态保护。
- 无迁移器、旧 schema fallback、旧路径 fallback、兼容别名或墓碑测试。

### AC-02：Todo 附件 CRUD 与并发

- 上传成功后文件已完成摘要/路径/大小验证且引用只激活一次；同 ID 同内容可安全重试，冲突内容被拒绝。
- revision 不匹配、超量、超限、路径逃逸或元数据漂移均返回明确错误且不留下有效悬挂引用；同 ID 幂等重试和模型图片 verified read 检测摘要漂移，不要求普通路径解析重新计算摘要。
- 列表顺序与 `attachmentIds` 一致；下载只能读取目标 Todo 的有效引用。
- PUT/DELETE 返回 authoritative Todo revision；Web 多文件拖放逐个激活并推进 revision，revision 冲突可就地重试且不依赖 SSE 猜测提交结果。
- Remove 增加 revision，并使列表和下一次调用立即不再包含该引用；通用 Todo PATCH 无法直接篡改 `attachmentIds`。
- Remove 在状态提交前失败时保持原引用；状态提交后即返回 authoritative Todo，物理删除失败不会恢复引用或使 API 继续暴露文件，并产生可断言的结构化 warning。
- 添加和移除均产生现有 Todo 资源变更事件，Web 无需轮询即可刷新。

### AC-03：Session 的实时引用语义

- 用附件 A 的 Todo 创建 Discussion 或 Work Session 后，再给 Todo 添加 B；不发送新 Session 附件消息、不复制文件，下一次模型调用收到 A+B。
- 从该 Todo 移除 A 后，已发出的请求不改变，下一次模型调用只收到 B；Session canonical message、receipt、SSE 和 Session 附件目录中均没有 Todo 引用快照。
- hard compact、普通压缩和恢复 Session 后，下一次模型调用仍解析 Todo 当前集合。
- 该 root 的子 Agent 获得同一当前集合；直接 Session 仍只使用原有消息附件语义且行为不回归。

### AC-04：工具授权与安全

- `resolveAttachmentReadPaths` 返回 canonical Session 消息附件与当前 Todo 引用的并集；移除 Todo 引用后，该路径不再出现在下一次集合中。
- cwd 内附件沿用普通 workspace read；cwd 外当前集合中的精确文件路径继续供 `file_read` 与现有 finite Bash read 免询问，`pdf_read` 复用同一只读例外，其他工具保持现有权限结果。对应行为必须同时覆盖 Session 与 Todo，不新增目录拒读断言或新的 Bash 权限机制。
- Todo 附件的 owner/元数据/canonical 路径验证失败时不进入模型投影或路径集合；摘要校验仅沿用 Session 已有的上传/幂等重试和模型图片 verified-byte reader 边界。
- `.archcode/runtime/**` 的现有 mutation 保护仍阻止 Agent 写入、替换或删除附件；本验收不把不同 Todo 的附件读取当作保密边界。
- 已开始的单次工具调用可完成，但其后调用使用最新集合；该边界有明确测试。

### AC-05：Automation 来源

- Todo 来源 Automation 的每个新 invocation Session 都持久化 `{ kind: "automation", automationId, invocationId, todoId }`，并在调用边界读取当时最新引用；两次 invocation 之间增删附件会反映到后一次。
- 直接创建和普通 Session 来源 Automation 不会意外获得 Todo 引用；向既有 Session 发消息时只遵循该 Session 自己的 root source。
- 新严格 source schema 的所有写入点和读取点一致，没有可选旧字段或推断 fallback。
- 删除 Automation 及其 Invocation 记录后，已经创建的 invocation Session 仍通过自身 `todoId` 读取 Todo 最新引用。

### AC-06：PDF 读取

- 所有获准 `file_read` 的 Agent、且只有这些 Agent，能用 `pdf_read` 从已授权的原生文本 PDF 读取；`startPage` 为 1-based，`pageCount` 为 1–20，inline 上限精确为 51,200 UTF-8 bytes。
- 超过 inline 上限时明确返回 truncated 和授权 artifact，可用现有 `output_read`/`output_search` 恢复；不存在静默截断或第二套 PDF 分页协议。
- 未授权路径、非 PDF、损坏、加密/需密码、扫描/无文本分别得到明确且可测试的结果。
- 工具不调用系统 PDF CLI、不执行 PDF 内容、不联网；`bun run build` 后的实际 ArchCode 二进制可完成同一读取用例。

### AC-07：产品界面

- Todo 详情在 Brief/PRD 和 Plan 之间展示唯一 References 区域，完成添加/拖放、上传中状态、失败重试、图片/PDF 的 Open、其他文件的 Download 和确认移除；主动内容不得 inline，Board 与 Quick Capture 不出现附件控件。
- 已绑定 Todo 的 Session 在现有来源信息旁静态展示 `Using live Todo references` 或等价文案，不为数量增加查询、订阅或同步状态；无新卡片、横幅、Tab、抽屉或导航入口。
- 上传、revision 冲突和超限都有就地可恢复反馈；Remove 以服务返回的 authoritative Todo 更新界面，不暴露内部物理清理状态。键盘操作、焦点、粗指针目标、1440px 与 390px、亮暗主题均通过浏览器验收。
- 上传说明覆盖本机持久化、Agent 可读和图片可能发给模型提供商三件事，不能暗示所有资料永不离开本机。

### AC-08：端到端与回归

- 用真实 Server 和浏览器完成：保存 Todo、上传图片和 PDF、启动 Discussion/Work、Session 存在期间增删引用，并验证下一边界实时变化。
- 完成 Todo 来源 Automation 增删前后 invocation、直接 Session 消息附件回归、子 Agent 继承和实际 `pdf_read` 用例。
- 删除 Session family 后 Todo 文件仍可从 Todo 使用；Archive/Reject 后引用仍存在；删除 Automation 后既有 invocation Session 仍保有 Todo 实时来源。
- 浏览器控制台无新增错误；协议、存储、服务、路由、模型投影、工具权限、Automation 和 Web 状态均有相应测试。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出 0。

### AC-09：架构与范围

- 附件文件系统机制、Session/Todo 所有权语义和现有执行上下文投影形成三个必要边界，没有独立 live resolver、读取隔离框架、循环依赖或 Web 跨层依赖。
- 实现中不存在快照/复制、全局 BlobStore、去重、引用计数、删除 journal、后台 GC、孤儿扫描、解析器注册表、OCR、索引、迁移、fallback 或旧兼容性。
- 独立高强度 reviewer 对最新实现与本验收逐项复核后无 blocker；一般改进建议不得在未修改本 Goal 的情况下扩展范围。

## 完成判定

只有 AC-01 至 AC-09 全部有可复查证据、所有命令通过、真实浏览器与编译二进制用例通过、独立 reviewer 无 blocker，才可标记完成。任何“后续再补”的验收项都视为未完成；若实现中发现必须新增快照、迁移、隐式降级、总量配额或文件类型范围，必须先暂停并让用户决策，不能自行扩大设计。
