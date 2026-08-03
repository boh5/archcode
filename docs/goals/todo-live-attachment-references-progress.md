# Todo 实时附件引用执行进度

## 状态

- Goal：`docs/goals/todo-live-attachment-references-plan-goal.md`
- 分支：`codex/todo-live-attachments`
- 当前阶段：完成

## 已锁定执行约束

- Todo 是附件唯一事实来源；Session 不复制、不快照。
- Todo 引用复用现有 Session attachment projector、`resolveAttachmentReadPaths` 和权限语义，不新增目录隔离或权限框架。
- 硬切新的状态和存储布局，不做迁移、fallback、兼容别名或墓碑测试。
- 保持三个必要边界：公共文件存储机制、Session/Todo 所有权语义、现有执行上下文投影。
- Remove 以逻辑解除为权威，物理文件 best-effort 删除；不增加 journal、恢复协议或 GC。
- UI 只在 Todo 详情加入平面 References 区域，并在 Session 现有来源元数据中加入静态 live 说明；不增加页面、卡片或数量同步。

## 执行记录

### 2026-08-03

- 从 `codex/project-workbench-ui-hard-cut` 创建并切换到 `codex/todo-live-attachments`。
- 重新核对 Goal、当前 Session 附件链路、Todo/Automation source、UI Master 与 Todos/Session 页面规范。
- UI/UX Pro Max 搜索结果偏向紫色 AI SaaS landing，与 ArchCode 的 quiet engineering workbench 方向冲突；仅保留可访问性、行内错误、键盘/拖放替代、亮暗主题和响应式检查，视觉以现有 Master 为准。
- 再次从第一性原理审计过度设计：保留“文件机制、Todo/Session 所有权、现有执行投影”三个必要边界；明确共享存储只能是具体内部类，Runtime 只提供一个窄组合回调，禁止另起 live resolver/service、缓存或监听链路。
- 将 UI 验收中的“上传进度”收窄为“上传中状态”，不为百分比进度引入 XHR、分片上传或任务系统；继续不做附件数量同步、排序、独立页面、Tab 或嵌套卡片。
- 实现阶段再次做删减审计并收掉四处预埋复杂度：Web 不再复制服务端附件到本地 rows 状态，只保留未完成上传；删除无人使用的附件 mutation hooks；拖放直接复用平面 References 区域而不是再嵌套虚线上传框；Runtime 在 ContextResolver 构造后直接建立窄回调，不保留晚绑定初始化变量。
- 公共附件存储返回类型硬改为项目级通用命名，Todo 层不再引用 `SessionAttachment*` 结果类型；工具读路径使用自己的最小结构契约，不反向依赖模型 projector 类型，也未增加共享 resolver 抽象。
- Automation 关联只读取已经持久化在 root Session source 上的 `todoId`；删除 Automation 后仍可继续解析实时引用，没有 inventory 回查 fallback。
- 收紧同 attachment ID 重试：相同 owner、元数据与内容可在原始 revision 已过期时幂等返回，不重复增加 revision；同 ID 异内容仍拒绝。
- 最终竞态复核发现同 ID 幂等 retry 与并发 Remove 可能返回旧 Todo 或重建孤儿；已复用现有 `AsyncKeyedMutex`，只按 `todoId+attachmentId` 串行完整 upload/remove，不锁整个 Todo 或项目。两种相反顺序的受控竞态测试证明 retry 先则 Remove 后删，Remove 先则 retry 在 storage 前 revision-conflict 且不重建对象。
- Web mutation cache 只在能按 authoritative `todo.attachmentIds` 重建完整有序 descriptor 列表时直接更新；GET 尚未建立 cache 或 cache 缺项时强制刷新 authoritative list，避免原有 rows 被“仅新文件”覆盖。已覆盖首次 GET 失败后上传成功的恢复场景。
- `pdf_read` 直接进入既有只读工具和 Tool Output policy matrix，未增加 PDF 工具族、解析器注册表、OCR 或第二套输出协议。
- `pdf_read` 改为逐页消费 `streamTextContent()`，在文本物化前执行 abort 与 64 MiB 原始 UTF-8 上限；最终 51,200-byte inline 上限仍由既有 Tool Output 管线负责。该修复只落实已有边界，没有新增配额服务或解析框架。
- 独立 review 发现 Automation 测试曾使用不存在的 Todo ID，只验证了 source 而未验证调用边界；已改为真实 Todo 与两份附件，覆盖首次 invocation、删除原 Automation、更新引用、再向既有 invocation Session 发消息，并断言第二个模型边界只见最新附件。定向测试 11/11 通过且无 fatal log。
- 独立 review 发现上传失败后的 revision 刷新期间点击 Retry/Dismiss 可能丢失续排；已用单一 `blockedUploadIdRef` 表达当前阻塞行，刷新结束后只在阻塞已解除时继续现有队列，没有引入上传状态机或任务服务。延迟刷新交互测试 4/4 通过。
- 当前 `docs/security.md` 与 `AGENTS.md` 已同步 runtime attachment 路径、写保护、`pdf_read` 和 Automation `todoId`/实时引用语义；历史 Goal 文档未改写。
- 完成真实生产 Server 浏览器验收：新建 Todo，上传图片与 PDF，打开/确认移除，References 位于 Brief/PRD 与 Plan 之间；1440px 亮色和 390px 暗色均正常，390px 下 document/body scrollWidth 均等于 viewport 390px，控制台无 error。验收创建的 Todo、附件和临时 PDF 已精确清理，未删除测试项目原有 Automation/Session 数据。
- 完成 Todo → Discussion 的真实执行闭环：Session header 展示 `Using live Todo references`；Session 存在期间新增 PDF 并移除原图片后，下一次真实模型调用只返回仍有效的 `archcode-todo-live-e2e.pdf`，控制台无 error。该次 Todo、附件、Discussion Session 与临时 PDF 也已精确清理。
- 补齐执行边界证据：真实子 Agent 继承 Todo 当前引用；hard compact 后重启并恢复同一 Session 时只注入最新引用；两个真实顺序工具调用证明已开始调用保留当次授权集合、下一调用重新解析。
- 补齐 Automation 验收：同一 Todo `start_session` Automation 连续两次创建不同 invocation Session，A→B 后第二次只见 B；删除原 Automation 后将 B→C，再向第二个既有 Session 发消息时只见 C。
- 最终 UI review 修正 Todo 详情中 Automation invocation Session 被误标为 Work，并补齐 References 图标 Remove 在 coarse pointer 下 44×44px 的双轴目标；均只改文案/class 与对应测试，未增加状态或布局层。
- 最终全仓 `bun run test` 8/8 Turbo task 通过：Protocol 138，Agent Core unit 2834、integration 140、architecture 79，Server 267，Web unit 599、interaction 99，全部 0 fail。
- 最终 `bun run build` 与 `git diff --check` 均退出 0；产出 arm64 Mach-O `dist/archcode`，SHA-256 为 `4ba6ed60c5cee3ab803d35dec49a1424800ebad1e6bc8c5bd9f388243e7abfd8`，源码中不存在旧 `.archcode/attachments` 生产路径。
- 独立生产二进制黑盒通过：临时 HOME、fake OpenAI-compatible provider、真实 HTTP Session 与真实 `pdf_read` 链路完成 1/1/0 次调用/完成/失败，读取唯一 marker `PDFSMOKE_4BA6ED60_OHMI36AS` 并返回 `PRODUCTION_PDF_BINARY_SMOKE_OK`；Session、Project、监听端口和临时目录均已清理。
- 独立高强度最终 review 确认最新实现无 blocker、无验收缺口，也未发现剩余过度设计。

## 待完成

- 无。

## 风险/更正记录

- 过度设计风险集中在把共享存储做成平台、把实时引用做成第二套状态系统、把简单上传状态做成进度管线；已在 Goal 中明确禁止，当前无待用户决策项。
