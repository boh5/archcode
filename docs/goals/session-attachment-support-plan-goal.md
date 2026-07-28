# Session Attachment Support Plan Goal

> 本文是本轮附件能力的实施与验收契约；执行状态与证据单独记录在 `session-attachment-support-progress.md`。

## Objective

为 ArchCode 所有可接收用户消息的 root Lead Session 增加附件能力（包含普通工作 Session 和 Todo Discussion）：用户可在 Composer 中上传任意单个文件，附件与消息一起形成持久、可重放、可审计的用户输入；当前 Execution 的冻结模型声明支持图片时，把已识别的图片作为真实图像输入交给模型，否则只给模型稳定的附件说明和本地路径，由 Agent 自己决定是否使用 `file_read`、Bash 和已有命令行工具处理。

本 Goal 只建设“附件是 Session 输入资源”这一条主链，不建设通用文件平台、文档解析平台或 Visual Agent。

## First-Principles Constraints

1. **附件字节不等于模型上下文。** 字节先作为 Session 资源可靠落盘；只有模型能力和文件类型都允许时，才在模型调用边界投影为图像内容。其他文件只投影元数据和受控路径。
2. **能力判断属于 Execution。** 用户可以配置 Luna 或任意其他 provider/model；是否直传图片只能读取当前 Execution 已冻结的 `binding.modelInfo.modalities.input`，不能读取易变的 Session 默认值，也不能按 provider/model 名称写特判。
3. **消息引用是上传对象进入上下文的唯一语义入口。** 附件 API 不覆盖已完成对象；消息保存有序附件引用，幂等、Queue、Steer、compact、SSE 和 UI 都沿用现有 Session 消息链。
4. **服务端是限制与权限的最终 owner。** Web 可提前提示，但 50 MiB、文件数、路径隔离、流式计数和清理必须由服务端再次强制执行。
5. **失败必须可解释、可重试，但不建设断点续传。** 完整上传通过客户端生成的 UUID 幂等；失败重试从第 0 字节开始，可捕获失败立即清理，同一 ID 的下次重试只清理该 ID 下由服务命名的崩溃残留。

## Locked Decisions

- 固定上限为 **50 MiB/文件**（`52_428_800` bytes）和 **10 个附件/消息**。
- 不设置 Session、Session family、Project 或用户累计上传配额；不增加任何附件大小、数量或配额配置项。
- 单条消息因而最多引用 500 MiB；更多附件分到后续消息即可，Session 不因此被锁死。单个超过 50 MiB 的文件仍须由用户压缩、拆分或改用 workspace 路径。
- 超过 50 MiB 在服务端返回 `413`，取消继续读取并删除本次临时文件。UI 明确建议压缩、拆分，或把文件放进项目 workspace 后在消息中写出路径。
- 不支持文件夹上传；文件选择、拖放和服务端契约都只接受单个普通文件。ZIP 等压缩包仍是普通文件，但 ArchCode 不自动解包。
- 所有上传类型都先成为附件。PDF、Office、压缩包、音频、视频和其他二进制不会自动转成 provider 的 `file` 输入。
- 所有能接收用户消息的 root Lead 都使用同一附件入口，包括 Todo Discussion；child Session 不直接接收浏览器上传。
- 只有文件头匹配 PNG、JPEG、GIF87a/GIF89a 或 WebP 固定签名，且当前 Execution 冻结模型的输入 modalities 包含 `image`，才作为真实图像 part 传给模型；其余情况只传附件 marker 和本地路径。这里只做固定签名识别，不做完整图片解码，损坏图片可由 provider 显式拒绝。
- `audio`、`video` 即使出现在模型配置中，本 Goal 也不直传；当前跨 provider 的可靠契约只落到 `image`。
- 图片使用原附件字节，不做 OCR、转码、缩放或另存派生副本。配置错误、损坏图片或 provider 自身更小的 payload 限制按普通模型调用错误显式返回，不静默改成另一套请求。
- 用户选择图片并提交，即视为授权把图片发送给该消息实际选中的 provider/model；UI 必须在附件入口附近给出简短说明。
- 文本可以为空，但附件不能为空；即支持 attachment-only message。Slash command 必须是纯文本输入，和附件混用时明确拒绝，不得静默忽略附件。
- 附件顺序属于消息语义和幂等指纹。Queued message 的文本编辑与 Steer 不得替换、重排或增删附件；消息提交后 attachment parts 不可变。
- 浏览器上传的字节归 root Session 所有，存放在项目本地 `.archcode/attachments/`，不放进 `.archcode/runtime/`。删除 child Session 不删除附件；root Session 完整删除成功后 best-effort 清理它的附件目录。
- 已在项目 workspace 中的文件继续直接使用路径，不复制进附件目录。
- 完成上传的对象通常保留到 root Session 删除；附件 HTTP API 不提供覆盖或单独删除，但不建设针对 Agent/Bash 的 OS 级不可变沙箱。MVP 不增加单附件垃圾回收、后台 TTL、启动扫描或孤儿目录自动清理。未被消息引用的完整对象不会由附件投影主动送入模型。
- Visual Agent 仍是后续范围。本 Goal 只留下可复用的附件解析和只读授权边界，不新增 Agent identity、Profile 或委派分支。

## Evidence Baseline

- OpenAI 当前公开手册分别说明 ChatGPT 的[文件处理](https://learn.chatgpt.com/docs/artifacts-viewer)和[图片输入](https://learn.chatgpt.com/docs/image-inputs)；Codex 的普通本地文件通过 `@`/`/mention` 成为路径上下文，图片另有富输入。由此不能把 ChatGPT 云端“任意文件”误写成 Codex 会把任意本地文件字节直接交给模型。
- 当前安装的 Codex desktop `26.721.41059` 分发包中，普通本地文件被序列化到 `# Files mentioned by the user` 路径上下文；图片走 `localImage`/data URL 富输入。这支持“workspace 文件用路径、图片按能力直传”的分层，而不是把所有本地文件 base64 化。
- Codex 源码固定到 [`3418498`](https://github.com/openai/codex/tree/3418498f01422f5f650ea645d4bd19e05c3a9616)：[`image_preparation.rs`](https://github.com/openai/codex/blob/3418498f01422f5f650ea645d4bd19e05c3a9616/codex-rs/core/src/image_preparation.rs) 在模型调用前准备图片并把失败替换为文本说明；[`normalize.rs`](https://github.com/openai/codex/blob/3418498f01422f5f650ea645d4bd19e05c3a9616/codex-rs/core/src/context_manager/normalize.rs) 根据模型 input modalities 移除不支持的图片。这证明 modality gate 应位于模型投影边界。
- OpenCode 源码固定到 [`3cc7016`](https://github.com/anomalyco/opencode/tree/3cc70160deb0eda7f67fbf5b0c0780000f5c342d)：浏览器端 [`attachments.ts`](https://github.com/anomalyco/opencode/blob/3cc70160deb0eda7f67fbf5b0c0780000f5c342d/packages/app/src/components/prompt-input/attachments.ts) 把附件读成 data URL，[`file-picker.ts`](https://github.com/anomalyco/opencode/blob/3cc70160deb0eda7f67fbf5b0c0780000f5c342d/packages/app/src/constants/file-picker.ts) 只开放图片/PDF/文本，[`image.ts`](https://github.com/anomalyco/opencode/blob/3cc70160deb0eda7f67fbf5b0c0780000f5c342d/packages/core/src/image.ts) 对图片做独立规范化。它适合小型媒体输入，但不适合 ArchCode 的任意 50 MiB 文件，因此本方案采用服务端流式字节存储，不复制其浏览器 base64 路径。
- ArchCode 当前真实缺口：
  - `apps/server/src/routes/messages.ts` 只接受非空 `text` JSON；
  - `SessionInputService` 的幂等指纹只覆盖 source、text 和 requested model selection；
  - `PendingSessionMessage` 与 canonical `SessionMessage` 没有附件；
  - `store/projection.ts` 只投影文本；
  - `file_read` 有 10 MiB 硬上限并检查 NUL，但当前使用非 fatal UTF-8 解码，非法 UTF-8 会被替换而不是拒绝；本 Goal 必须同时修正运行时校验和模型可见描述；
  - worktree child 读取 canonical project 下的附件会命中 outside-workspace 询问；
  - root Session 删除由现有 deletion lifecycle 和单一执行 owner 负责；附件目录移到 runtime 外后应接入该 lifecycle 显式清理，而不是另建 Session 删除入口。

ChatGPT/Codex desktop 完整产品源码并未公开；上述 desktop 结论来自公开手册、Codex 开源仓库和当前安装分发包，不把压缩后的分发代码冒充公开源码。

## Target Architecture

```text
Web File
  -> PUT one bounded raw stream /attachments/:attachmentId
  -> SessionAttachmentService
       -> per-root upload/delete gate + per-ID serialization
       -> temp directory + byte counter + SHA-256
       -> content + metadata, atomic directory rename
  -> POST /messages { text, attachmentIds, clientRequestId, requestedModelSelection }
  -> SessionInputService (validate ownership + ordered refs + idempotency)
  -> canonical AttachmentPart in Session Store/SSE
  -> base projection: text marker + internal attachment-slot sidecar
  -> Execution attachment projector
       -> image modality + recognized raster image: marker + original image bytes
       -> otherwise: marker + exact local path
  -> runLlmStream
```

### Ownership

| Owner | 唯一职责 |
| --- | --- |
| `packages/protocol` | 固定 limits、公开 `AttachmentDescriptor`、消息 attachment part、SSE/API DTO；零文件系统逻辑 |
| `packages/agent-core/src/attachments/` | UUID/path containment、流式落盘、strict metadata、类型识别、同 ID 幂等、root upload/delete gate、消息引用解析、模型投影和 worktree 只读路径集合 |
| `SessionInputService` | 在现有 durable message mutation 中校验有序 attachment IDs、写入 pending/canonical message、更新 idempotency fingerprint；不写附件字节 |
| Server routes | 认证后的 HTTP stream/headers 适配、错误码映射和下载响应；不复制存储或能力判断逻辑 |
| Store projection + Query loop | 投影一次性产生 messages 和不可伪造的 attachment-slot sidecar；在现有 `beforeModelCall` 边界使用当前 Execution binding 调用附件 projector，不新增第二套 LLM 调用 |
| Tool permission | 只为 worktree Session 当前 canonical 已引用附件的精确 content path 增加 read 例外；不把附件目录包装成新的安全沙箱 |
| Web Composer | 本地选择/移除、顺序、上传状态、失败重试、消息提交和只读展示；服务端仍是权威 |

不得新建通用 `BlobStore`、解析器 registry、provider capability service、附件 scheduler、附件安全沙箱或独立附件数据库。

### Durable Shape And Storage

- 公共 `AttachmentDescriptor` 只含：`id`、display-only `name`、display-only `mediaType`、`sizeBytes`、`kind: "image" | "file"`；不包含 digest、绝对路径、data URL 或原始字节。`kind` 只由固定图片签名决定；`mediaType` 对图片使用识别出的 MIME，对其他文件取请求 `Content-Type` 去参数、转小写后的 ASCII `type/subtype`（最长 127 bytes），不合法或缺失时固定为 `application/octet-stream`，绝不作为能力或安全判断依据。
- Pending message 保存有序 descriptors；canonical user message 增加独立 `attachment` part。消息、receipt 和 descriptor 必须有 strict schema/invariant。
- 附件 ID 由 Web 生成 UUID；文件名永不参与磁盘路径。服务端拒绝空白名、`.`、`..`、`/`、`\`、NUL、control 字符和超过 255 UTF-8 bytes 的名称，不做隐式规范化。
- 所有服务端读写先从 canonical project root 解析并逐级检查 `.archcode/attachments`、root、attachment ID、temp/final、metadata 和 content；任一祖先或目标是 symlink、解析后逃出 project root、类型不符或命中非本服务命名路径都拒绝。这是上传写路径 containment，不是 Agent 文件权限沙箱。
- 路径固定为：

```text
.archcode/attachments/{rootSessionId}/{attachmentId}/
├── metadata.json
└── content
```

- raw `PUT` 使用 URL query `name=<UTF-8 percent-encoded filename>&sizeBytes=<decimal>`，请求体就是文件字节，`Content-Type` 仅为 display hint。空文件合法。`sizeBytes` 必须为 `0..52_428_800`；可选 `Content-Length` 若存在必须与其一致，服务端仍按实际读取字节计数并要求最终完全相等。
- 上传在 `(project, rootSessionId, attachmentId)` 内串行；取得该 ID 后先清理上次进程崩溃遗留的同 ID temp，再写同一 root attachments 目录下仅属于本次请求的唯一临时目录，边写边计算 SHA-256。只有 content 和 strict metadata 都完成后才原子 rename 为最终 ID 目录。digest 只存私有 metadata 并用于同 ID 身份比较，不做 CAS、去重或公开 DTO。
- 相同 root Session + attachment ID 的完整重试：
  - 总是从第 0 字节接收至本次独立 temp，并比较 name、display media type、size 和 digest；
  - 全部一致时删除本次 temp 并返回既有 descriptor，不覆盖内容；
  - 任一不一致时删除本次 temp 并返回 `409`；
  - 失败只清理自己拥有的 temp，不删除另一个请求的目录。
- 读取完整对象时必须重新检查 containment、strict metadata 和 `content` 为普通文件而非 symlink。既有对象的 digest 已漂移时，同 ID replay 显式报损坏；图片 projector 在读取原字节的同时校验 digest，失败时不得把字节发给 provider。generic file 仍只是普通 workspace 路径，不增加持续完整性监控。
- `SessionAttachmentService` 只增加一个小型 per-root upload/delete gate，不改变 Session 删除算法：
  - 上传取得普通 lease；root 删除取得独占 lease，因此删除会等待已开始的上传结束，并阻止新的上传进入；
  - 上传取得 lease 后必须再次确认 root Lead Session 仍存在，删除结束后到达的迟到请求因此不能重建附件目录；
  - `Runtime.deleteSession` 是唯一生产协调入口：删除 child 时直接调用现有 `SessionExecutionManager`；删除 root 时在独占 lease 内调用它，Manager 仍是唯一 Session 删除 owner；
  - Manager 抛错时不清理附件，只释放 gate 并原样返回删除错误，不分析磁盘处于哪一种部分删除状态；
  - Manager 完整成功后尝试一次递归删除 `.archcode/attachments/{rootSessionId}`；清理失败只写结构化 warning，不改变已成功的 Session 删除结果，也不自动重试；
  - 不修改当前 Session 删除顺序，不增加三态、持久 tombstone、strict forest scan、启动恢复阻断或 orphan cleanup。
- project unregister 和进程 shutdown 不增加附件专用事务；已完成对象保留，硬退出留下的同 ID temp 由该 ID 下次上传重试清理。
- Session JSON、SSE、日志、审计和浏览器 store 均不得保存 base64/bytes。下载 route 通过 ID 解析文件，强制 `Content-Disposition: attachment` 和 `X-Content-Type-Options: nosniff`，不返回服务器绝对路径。

### Message And Execution Semantics

- `POST /messages` 硬切为显式 `{ text, attachmentIds, clientRequestId, requestedModelSelection }`；`attachmentIds` 必须存在，可为 `[]`，不保留旧 alias 或双协议。
- 合法输入必须满足 `trim(text).length > 0 || attachmentIds.length > 0`；每个 ID 唯一、按用户顺序保存、最多 10 个，并且都必须属于同一 root Session 的已完成对象。
- `sessionInputFingerprint` 加入有序 attachment IDs。相同 `clientRequestId` + 完全相同输入返回原 receipt；任一附件缺失、增加、删除或换序均返回 idempotency conflict。
- attachment ID 的解析与 descriptor 固化必须发生在现有 root Session input mutation 临界区内，再随同一次 durable message mutation 提交；上传本身不占用该临界区。
- Queue prefix commit、direct input、Steer rollback 和 restart repair 必须保留 attachment descriptors。编辑 queued 文本只改变 text/revision；只要该 pending message 仍有附件，就允许把文本编辑为空。
- 现有 `ModelMessagesProjection` 增加 `attachmentSlots`，仍由同一个 canonical projector 一次返回；现有 messages-only convenience wrapper 继续委托这个 projector，它不是兼容 fallback 或第二套投影。每个 slot 持有投影器刚生成的 marker content-part 对象引用和 descriptor，不保存易漂移的数组下标，也不从 marker 文本反解析，因此用户文本不能伪造。被 hard compact 跳过或被 DCP block 覆盖的消息不产生 slot。
- Base projection 始终把实际投影出的 attachment part 渲染为转义后的稳定 marker。title generation、memory extraction 等绕过 Store projection 的消费者必须显式复用同一 marker renderer；attachment-only message 可生成标题和触发/参与 memory extraction，但绝不读取字节。
- Query loop 在通用 `beforeModelCall` hooks 之后、`runLlmStream` 之前，以当前 Execution binding 只丰富仍存在于最终 messages 中的 sidecar slots；若 hook 移除了或替换了 marker part，该 slot 安全跳过：
  - 所有附件保留 name/media type/size/path marker；
  - 只有 `modalities.input.includes("image")` 且 descriptor 为签名识别出的 raster image 时增加 AI SDK image part；
  - 不支持图片时不产生任何 image/file binary part；
  - 不从 Session 当前 picker、Profile 默认值或 provider 名称重新判断。
- 系统生成的 attachment descriptor/part/SSE 不包含绝对路径；路径只在本次模型 marker 中补入。若模型随后把该路径写进 tool-call input，则沿用现有 tool input 持久化、SSE 和 redaction 规则，不另造隐藏协议。图片字节只在调用时读取，不持久化为 data URL。

### Tool Contract And Security

- `ToolExecutionContext` 增加 read exception paths，只从 root family 已提交的 canonical attachment parts 解析；pending Queue 附件不进入集合，Steer 只有 durable commit 后才进入。该集合用于 worktree 场景，不宣称隔离 root Agent 对项目目录的普通访问。
- `file_read` 的 workspace permission 只对上述精确 content path免除 worktree outside-workspace 询问；普通路径的 sensitive-file guard 保持现状。附件上传本身视为用户授权 Agent 读取该附件，不按 display name 再触发一次路径询问。
- Bash 仅在 finite analysis 已证明所有 outside-workspace attachment access 都是 `read` 且命中精确 exception path 时免除询问；未知 CLI、动态路径和普通工作区访问完全沿用现有 Bash policy。本 Goal 不新增 attachment deny-first、命令 allow-list 或 OS sandbox，也不承诺 Agent 无法修改项目内 `.archcode/attachments`。
- `file_read` 的模型可见 description 必须明确：
  - 它只接受可严格解码的 UTF-8 且不含 NUL 的文本，并继续保留 10 MiB 上限；
  - 图片、PDF、DOCX/XLSX/PPTX、ZIP、音视频等二进制/容器格式不能用它解码；
  - Agent 可在附件路径上尝试 Bash 和已安装的合适 CLI；权限仍按现有 Bash policy 判断，没有可用解析器时必须如实报告，不能承诺通用处理。
- 上述 description 通过真实 `ResolvedToolSet.toAITools()` contract test 验证，不只做源码字符串测试。

### Web UX

- 在现有统一 Composer card 内增加真实 attachment control，不恢复 fake/Coming soon 控件；支持文件选择、普通文件拖放和剪贴板图片。
- 不设置 `webkitdirectory`；拖入目录时整体拒绝并说明“不支持文件夹，请选择文件”。
- 本地预检 50 MiB 和 10 个限制；每项显示 name、size、`ready | uploading | uploaded | error`，提交前可移除和重排。
- 点击 Send 后按用户顺序逐个上传，已成功的 ID 在消息 POST 重试时复用；失败文件可从第 0 字节重试，不实现 chunk/range resume。
- 所有文件上传完成前不提交消息。服务端 `413` 显示固定限制和“压缩/拆分/放入 workspace 后写路径”的恢复建议。
- 文本为空但有附件时 Send 可用；无文本无附件时禁用。附件和 `/compact` 混用在 UI 预防、服务端拒绝。
- 消息提交后 timeline、Queue 和 retry dock 以只读 chip 展示 descriptors；不允许单独修改已提交附件。图片可在提交前用本地 object URL 预览并及时 revoke，MVP 不建设服务端 inline 文件预览器。

## Implementation Plan

1. 在 protocol 增加固定 limits、descriptor/part/DTO，并更新 strict event guards/reducer；扩展 pending/canonical message schema、复制函数和 Session invariants。
2. 新建高内聚 `agent-core/src/attachments/`：安全路径、bounded stream writer、原子 finalize、strict metadata、图片签名识别、幂等 PUT 解析和模型/工具只读解析；同步项目 `.archcode` layout 文档，但不抽象通用 blob 平台。
3. 增加 root Lead-only attachment PUT/download routes，并接入现有项目解析、认证和错误处理；在 `Runtime.deleteSession` 外层使用 `SessionAttachmentService` 的 per-root upload/delete gate，root 删除成功后 best-effort 清理，失败只记录 warning。保持 `SessionExecutionManager`、Session 删除顺序和 `listAllSessionSummaries` 不变，不增加第二个删除 owner。上传 route 不使用 `formData()`、`arrayBuffer()` 或整文件 base64。
4. 扩展 `SessionInputService` 的 direct/queue/command 判定、fingerprint、pending/canonical commit 和 replay，保证附件引用随一次 durable Session mutation进入消息。
5. 扩展 canonical `ModelMessagesProjection` 返回 sidecar，逐一接入 title/memory 等旁路消费者；真实图片只在当前 Execution 的 `beforeModelCall` 边界投影，不修改 `runLlmStream` provider 抽象或保留第二套投影。
6. 增加 canonical attachment read exceptions，接入 `file_read` workspace permission 与 Bash finite policy；同时把 `file_read` 改成 fatal UTF-8 + NUL 校验，并同步模型可见描述和 contract tests。
7. 实现 Composer 选择/拖放/粘贴、顺序、状态、幂等上传、attachment-only submit、错误恢复和 timeline chips；移除相关“无附件”旧断言，不保留 fake control 或兼容 UI。
8. 更新项目 layout 与 `docs/security.md`，明确附件是普通 workspace 数据而非 runtime authority；完成定向测试、全仓验证、真实浏览器桌面/390px 验收和独立 Reviewer 逐项验收。

## Non-goals

- 文件夹上传、自动递归、文件夹打包。
- 分块上传、range resume、跨设备续传、SFTP、对象存储或 CDN。
- Session/Project/user 累计配额以及任何附件配置字段。
- OCR、PDF/Office 专用解析、音视频转写、向量索引、RAG、内容搜索或自动摘要。
- 全局 CAS、hash 去重、引用计数、跨 Session 共享和单附件 GC。
- 附件子树 deny-first、命令解析器扩表、OS 级只读 sandbox 或专用附件 Runner。
- Session 删除顺序重构、跨 Session/附件目录事务、删除结果三态、持久 tombstone、strict forest scan、启动恢复阻断和 orphan cleanup。
- provider-specific capability probe、model name allow-list 或把任意文件直接塞进 provider request。
- 图片 resize/转码、服务端 inline preview、病毒扫描和内容审核平台。
- Visual Agent、`profiles.visual`、新的 delegation target 或自动视觉委派。
- 旧 upload endpoint、base64 message API、双写、feature flag、legacy alias、fallback 路径和墓碑测试。

## Acceptance Criteria

以下 AC-01 至 AC-09 必须全部满足；任一缺失即为 `NOT_DONE`。

### AC-01：固定范围且没有配置膨胀

- 唯一生产限制为 `52_428_800` bytes/文件、10 个/消息；Web 预检与服务端权威校验引用同一 protocol constants。
- Config schema、Settings UI、环境变量和示例配置中不存在 attachment size/count/quota 配置。
- 10 个附件可提交，11 个确定返回 `400/422`；不存在 Session family 累计字节求和或累计拒绝分支。
- 文件夹选择/拖放被拒绝；普通 ZIP 作为单文件仍可上传。

### AC-02：上传是流式、幂等且可从半文件恢复

- 服务端在有/无 `Content-Length` 两种情况下都以实际读取字节计数；恰好 50 MiB 可完成，50 MiB + 1 byte 返回 `413`。
- limit、客户端断开、abort、磁盘写失败和 metadata 校验失败后，最终 ID 目录不存在且本次临时目录被删除。
- 并发或网络重试同一 attachment UUID 不覆盖完整对象：name、media type、size 和 digest 全部相同才返回同一 descriptor，任一不同返回 `409`。
- 文件名不能影响路径；空白、`.`、`..`、`/`、`\`、NUL、control 字符和超过 255 UTF-8 bytes 的名称全部确定性拒绝。
- 生产上传路径没有 `formData()`、整文件 `arrayBuffer()`、base64 或 multipart buffering。
- query `sizeBytes` 与实际读取字节必须完全相等；空文件可完成；合法/缺失 `Content-Length` 均有测试，存在但不一致时拒绝。
- 同 ID 并发被串行化；相同 metadata 但不同字节得到不同 digest 并返回 `409`，失败请求只能清理自己的 temp。
- symlinked `.archcode/attachments`、任一 root/ID/temp/final 祖先、`metadata.json` 或 `content` 均不能把服务端读写引到 canonical project root 外。
- 模拟进程硬退出留下同一 attachment ID 的服务命名 temp 后，用该 ID 从第 0 字节重试会先清理该 ID 的 stale temp 并完成上传；不会扫描或删除其他 ID/root 的残留。

### AC-03：消息、Queue 和幂等语义完整

- text-only、text+attachments、attachment-only 三种消息均进入现有 Session input/Execution 链；空 text + 空附件拒绝。
- 普通 root Lead 与 Todo Discussion root Lead 都能完成 upload + message reference；任意 child Session 在上传 route 和 message-reference validation 两层都明确拒绝。
- Slash command + 任意附件明确拒绝，附件不会被忽略或误执行 command。
- attachment ID 跨 root Session、未完成、不存在、重复或超过 10 个均拒绝，且不会创建 pending/canonical message。
- 同一 `clientRequestId` 只有 text、requested selection 和有序 attachment IDs 全相同时才 replay；换序也必须冲突。
- direct、Queue prefix、Steer、restart repair、queued text edit/delete 的测试证明 descriptors 不丢失、不改变；有附件的 queued message 可把 text 编辑为空；canonical part 顺序与用户顺序一致。

### AC-04：任意模型下的图片投影正确

- 测试以两个冻结 Execution bindings 覆盖 `input=["text","image"]` 和 `input=["text"]`：同一已识别图片在前者产生一个 image part，在后者产生零个 binary part但保留 marker/path。
- Session model selection 在 Execution 开始后变化，不影响该 Execution 的附件投影；下一 Execution 才使用新 binding。
- PNG 在 offset 0 匹配 `89 50 4E 47 0D 0A 1A 0A`、JPEG 在 offset 0 匹配 `FF D8 FF`、GIF 在 offset 0 匹配 ASCII `GIF87a`/`GIF89a`、WebP 至少 12 bytes 且在 offset 0/8 分别匹配 ASCII `RIFF`/`WEBP` 时产生 image kind；伪造 MIME 或其他格式只作为 generic file。只有签名但后续结构损坏的文件仍按 image 发送，并由 provider 显式报错。
- PDF、Office、ZIP、audio、video 对所有当前模型都只产生 marker，不产生 provider file/audio/video part。
- provider 因 payload 或错误 modality 配置拒绝时，返回现有 sanitized model error；没有静默重发、provider 特判或文本 fallback 请求。
- AI SDK image part 的字节与落盘 `content` 完全相等，附件目录中不存在 resize/转码派生文件。
- 图片 `content` 被修改、替换为 symlink 或 digest 不一致时，模型准备阶段确定性失败且 provider 收到 0 bytes。
- hard-compacted 或 DCP-covered 的旧图片不产生 sidecar、不读取字节、不产生 image part；用户伪造 marker 文本不能生成 slot；beforeModelCall hook 插入、重排或移除 message 时不会把图片绑到错误位置。

### AC-05：持久化、compact 与公开数据不携带字节

- `session.json`、Session/SSE DTO、event ring、Web store、日志和审计中只出现 descriptors/attachment parts，不出现 data URL、base64 或文件字节。
- 普通 model history、full history、title、memory extraction、DCP 和 hard compact 均能看到确定性 attachment marker；attachment-only message 可走标题和 memory 流程。除主 QueryLoop image projector 外，这些消费者不读取附件字节。
- compact 后 Session timeline 仍保留原 attachment part，reload 后 chip metadata 与顺序不变。
- marker 进行 XML/文本转义；用户文件名不能注入 Prompt 标签或指令结构。

### AC-06：worktree 读取例外保持最小

- root Lead 和 worktree child 对当前 root family canonical 已引用的精确 attachment content path 使用 `file_read`，以及使用 finite analyzer 已证明的 Bash read 时，不触发 outside-workspace ask。
- 运行中新增的 pending Queue attachment 不改变当前 tool context；Steer attachment 只在 durable commit 后进入 exception paths。
- exception 不包含未引用对象、其他 root Session、metadata 或目录祖先，也不会持久化为项目 approval；未知 CLI 和动态 Bash 继续走现有 policy。
- `file_read` 对整文件执行 fatal UTF-8 解码并拒绝任意 NUL，继续拒绝 >10 MiB；测试覆盖有效 UTF-8、无 NUL 的非法 UTF-8、含 NUL 和大小边界。真实 AI SDK tool description 明确列出不支持的常见二进制/容器格式及 Bash 恢复路径。
- 本 AC 只验证 worktree read exception，不把 `.archcode/attachments` 声称为 root Agent 的保密或 OS 级不可变边界。

### AC-07：生命周期、下载与安全边界闭合

- 项目 layout 与 `docs/security.md` 只新增 `.archcode/attachments/{rootSessionId}/{attachmentId}`，明确它是普通 workspace 数据而非 runtime authority；生产附件字节不进入 `.archcode/runtime`，且整个 `.archcode` 继续由现有 Git ignore 规则排除。
- attachment path 总是绑定 canonical project root + root Session ID；child cwd/worktree、用户文件名和请求 path 都不能改变 owner。
- 删除 child Session 后附件仍存在，且不取得 root 独占 gate。root 删除取得独占 gate：已开始的上传先结束，删除期间的新上传不能进入。
- 每次上传在取得普通 lease 后重新校验 root Lead；测试覆盖“上传先开始”“删除先开始”和“删除完成后迟到上传”三种顺序，不能在已删除 root 下创建新目录。
- `SessionExecutionManager.deleteSession` 抛错时不尝试删除附件，并释放 gate；root 若仍存在，后续上传可通过重新校验，root 若已不存在则由同一校验拒绝。本 Goal 不推断或修复部分删除状态。
- `SessionExecutionManager.deleteSession` 完整成功后恰好尝试一次附件目录清理：成功时目录不存在；清理 `rm` 失败时 Session 删除仍成功、产生一条不泄露绝对路径或附件内容的结构化 warning，并允许 orphan 目录保留。
- project unregister 和进程重启不会自动扫描或清理完整附件对象；原对象保持原样，重新注册后仍按持久 Session reference 使用。同 ID temp 只由同 ID 重试清理。
- 上传/下载 route 复用现有认证和 project/session 解析；Host 仅在当前 `authRequired` 条件下沿用既有 mutation Origin 检查，不新增附件特例。跨 project/root ID 访问失败。
- 下载只接受 containment 内的普通 `content` 文件；响应强制 attachment disposition、nosniff、正确长度，不泄露绝对路径，不把未知文件以内联 HTML/SVG 执行。合法 Unicode、空格和引号名称使用 RFC 5987 `filename*` 与安全 ASCII fallback，不能直接拼接 header。
- 未被任何消息引用的完整上传对象不会进入模型投影或 worktree read exception；通常随 root Session 删除清理，但 cleanup 失败时允许成为 orphan。

### AC-08：Composer 是完整真实入口

- 点击选择、普通文件拖放、剪贴板图片、多附件排序/移除、逐项状态、失败重试和 attachment-only Send 均有组件测试。
- 50 MiB/10 个的本地提示与服务端错误文案一致；`413` 明确给出压缩、拆分或 workspace path 三种恢复方式。
- upload PUT 结果不确定时用原 attachment ID 从第 0 字节重试；已知上传成功后，message POST 的不确定重试只复用原 attachment IDs + `clientRequestId`，不重复上传。
- desktop 与 390px 真实浏览器验收中，Composer/timeline 无横向溢出，键盘发送、Queue、Stop、model picker 和 HITL 行为不退化，console 0 error。

### AC-09：范围清场与全量验证

- 在附件 API、`attachments/` namespace 和消息 payload 范围内搜索，证明不存在 attachment limits config、folder upload、chunk/range resume、base64 payload、OCR/parser/index、CAS/跨对象去重/GC、Visual Agent 或 provider/model name 特判；不得因仓库其他合法模块出现同名词而误判。
- 不存在第二套 message admission、LLM call、Session lifecycle、permission owner、旧 endpoint、dual-write、feature flag、fallback、deleted 状态机或 legacy/persisted tombstone tests；迟到上传只由同一个 per-root gate 后的 root revalidation 拒绝。
- attachment service、HTTP route、Session input、projection、tool permission、root upload/delete gate、best-effort cleanup 和 Web interaction 的定向测试全部通过。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- 独立 Reviewer 必须按 AC-01 至 AC-09 给出具体源码、测试、搜索和运行证据；只报告“架构合理”或“测试通过”不能判定 `DONE`。

## Known Risks

- 配置中的 modalities 是用户声明而不是在线探测；声明错误会在模型调用时显式失败。这是有意边界，不增加 provider probe。
- 最坏情况下，一条消息可以引用 10 个接近 50 MiB 的图片；本 Goal 不另设图片阈值或 resize。实现与验收必须确认读取只发生在 sidecar 指示且模型支持图片的调用中，并记录峰值内存；若真实验证证明会使支持环境不可用，应停下来重新请用户决定，而不是私自增加隐藏限制。
- 没有累计配额、单附件 GC 和 orphan cleanup；未引用对象会占用磁盘到 root Session 删除，删除后的 best-effort cleanup 若失败还会留下 orphan。这是简化后的明确取舍，不用后台扫描掩盖。
- `.archcode/attachments` 是普通项目本地目录，不是 Agent 保密边界。附件 API、消息引用和 digest 提供确定性身份，但拥有 Bash 权限的 Agent 仍可能像操作其他项目文件一样修改底层字节；本 Goal 不用专用沙箱掩盖这一事实。
- root Session 删除与附件清理不是跨目录事务；Session 删除成功但附件 `rm` 失败时，目录可能永久残留，只记录 warning。若后续真实使用证明 orphan 累积是问题，再单独设计显式清理，不在本 Goal 预埋框架。
