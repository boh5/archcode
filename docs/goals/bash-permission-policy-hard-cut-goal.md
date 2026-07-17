# Bash Permission Policy Hard-Cut Goal

## Objective

将 Bash 权限硬切为低打扰策略：默认允许，只在明确越界、敏感访问或少数高风险操作时询问，只对产品控制面和可机械确认的灾难操作拒绝。保留有限的 shell 结构与路径提取，但删除命令 allowlist、未知命令兜底、效果推断和不确定性审批；不建设沙箱，也不把静态分析描述为安全边界。

## Locked Architecture

```text
Bash input
  -> prepareInput: structured cwd remains inside workspace
  -> security/bash: analyze once per execution attempt
     (segments, argv, literal paths, redirections, reachable cwd set, background operator)
  -> permission/bash: deny -> ask -> default allow
  -> ToolRegistry/HITL: exact scope fingerprint checked again on resumed attempt
```

- `tools/security/bash` 只拥有分析类型、语法分段、有限 wrapper 展开和字面量路径提取；不导入 permission/HITL 类型，也不作 allow/ask/deny 决策。
- `tools/permission/bash` 是 Bash 决策、rule reason、exact scope 和 persistent-eligibility 的唯一所有者；Bash tool 只挂这一项 permission，protected-path permission 不再解析 Bash。
- “只分析一次”指每次执行尝试只调用一次 `analyzeBash`。HITL 恢复是新的执行尝试，必须重新 prepare、分析和决策，再与首次 blocked fingerprint 比较。
- `deny > ask > allow`，deny 不可批准。Bash approval 只允许 exact scope，不提供命令前缀、路径子树或旧 scope fallback。
- Bash tool 原有的 workspace 内 structured `cwd`、最小环境、关闭 stdin、timeout/abort 和进程回收保持不变。
- 这是防明显误操作的 UX guardrail。解释器内联代码、package script、自定义二进制、动态路径、通用 glob 和归档内容不做语义检查，可以绕过静态识别；这是明确接受的边界。
- 云、数据库、容器和发布命令不按业务后果分类；`terraform destroy`、`kubectl delete`、`docker system prune`、SQL CLI、`git push`、`npm publish` 等未命中下述明确规则时默认 allow。

## Finite v1 Analysis Contract

- 只解析 top-level literal command chain、引号、注释、redirection 和 `&&`、`||`、`;`、`|`、独立 `&`。`2>&1`、`>&2`、quoted/commented `&` 不是后台；substitution、heredoc 内容和动态生成的命令不递归解释。
- cwd 使用有限 reachable set：`cd p && X` 的 `X` 只取新 cwd，`cd p || X` 只取原 cwd，`cd p ; X` 取原/新 cwd 并集，pipeline 内 `cd` 不流出 pipeline。只识别 top-level literal `cd [--] path`；任一 reachable cwd 命中 deny 即 deny，否则任一命中 ask 即 ask。
- 透明 wrapper 只展开这些形状：`command [--] cmd`、`env [-i|--ignore-environment] [-u NAME|--unset=NAME]... [NAME=VALUE]... [--] cmd`、`exec [--] cmd`、`timeout [--] DURATION cmd`、`time [-p|--] cmd`、`nice [-n N|--adjustment=N] [--] cmd`、`nohup [--] cmd`，以及 `sh|bash|zsh|dash|ksh` 的 literal `-c` 字符串。其他形状不展开，且“不认识”本身不 ask。
- privilege wrapper 本身始终 ask；hard-deny nested check 只保证这些形状：上述透明 wrapper、`sudo|doas|pkexec` 的无 flag/`--` 形式及 `-u|--user`、`-g|--group` 单参数形式，`runuser [-u USER] -- cmd`、`su [USER] -c literal`、`su -c literal [USER]`、`machinectl shell [USER@]MACHINE cmd`。未列形状仍 ask，但不声称已检查 nested deny。
- 路径提取只处理 literal operand，并用固定 command descriptor 标注 operation、source/destination 与 `followFinalSymlink`。覆盖 `cd/source/.`、`ls/cat/head/tail/grep/rg/find/sed`、`rm/rmdir/mv/cp/ln/tee/mkdir/touch/chmod/chown/truncate/install/dd`、redirection、`curl/wget` 文件参数、`scp/rsync/tar` 本地 operand、Git `-C`、解释器显式 script path 和含 `/` 的 executable path；`dd` 只识别 literal `if=PATH` 为 read、`of=PATH` 为 write。
- read/execute 及写穿现有 leaf 的操作（redirection、`tee/truncate/touch/chmod/chown`）解析 effective target；entry delete/create（`rm/rmdir/mkdir`）只 canonicalize parent 并保留 leaf。对 `cp/install/mv/ln` destination，若其为 existing directory 或 symlink-to-directory，则每个实际 write entry 为 `canonical(destination directory)/basename(each source operand)`；否则 `cp/install` 按 write-through effective leaf，`mv/ln` 按 entry replacement 解析。支持的 `mv/ln -T|--no-target-directory` 固定按 entry operation；`ln -s` source 只提供 basename、不算文件 read。不存在路径按 nearest existing ancestor + literal tail 解析。
- 只有完全 literal 且能机械 canonicalize 的访问进入 approval `accesses`。每个 command descriptor 在代码中封闭列出 operand 位置和 option arity；未列 option shape、变量、substitution、heredoc 或未展开 glob 不制造“推断型 ask”。若同一命令因 privilege 等其他规则需要 ask，则该 ask 不可持久批准。
- hard deny 只额外识别固定静态 catastrophe token：`~`、`$HOME`、`${HOME}`、`$PWD`、`${PWD}` 及其 literal suffix 先静态展开并 canonical compare，以及精确的 `/*`、`/Users/*`、`*`、`./*`。只有展开结果覆盖下述 catastrophe root 才 deny；例如 `$HOME` deny，普通 `$HOME/project` 不作 catastrophe deny，但仍按 workspace 外路径规则 ask。不实现通用 glob expansion。

## Hard-Cut Constraints

- 删除 `tools/security/bash-classifier.ts`、security Bash `policy.ts/effects.ts/scopes.ts` 及其旧测试/导出；同步清理 security、permission、tools barrels 和 Bash builtin imports。删除 `ShellEffect*`、`attachShellEffects`、request/invocation `effects`、`bash-command` scope 和旧 `bash-exact.normalized/effects`。
- 删除 command allowlist、通用 Git/package/network 分类、unknown/mutating、parser-uncertain、opaque-interpreter、普通删除/重定向/Git push/SSH ask，以及对应 rule id、fixture 和兼容壳；只保留下述窄规则。
- 新 Bash scope 固定为 `{ kind: "bash-exact", command, cwd, accesses }`。`command` 是 trimmed raw command，`cwd` 是 canonical structured cwd，`accesses` 是按 operation + path 排序去重的全部已提取 literal access：`{ operation: "read" | "write" | "delete" | "execute", path }[]`。
- blocked state 只持久化 `SHA-256(stable JSON(exact scope))` fingerprint，不持久化未脱敏 raw scope。恢复后仅当新 ask fingerprint 完全相同才消费 `approve_once/approve_always`；scope 变化则创建新 HITL，deny 立即拒绝，当前已变为 allow 则忽略旧 decision 并执行。
- raw command 命中 secret-content detector，或分析含上述动态引用时，ask 必须 `persistentApprovalEligible=false`。HITL redacted view 暴露该布尔值，Web 隐藏 “Always allow”，服务端拒绝伪造的 `approve_always`；`approve_once` 仍可执行。raw secret 不得进入 HITL display、blocked fingerprint 原文或 `permissions.json`。
- 不自动、也不无条件删除 `.archcode/permissions.json`。本 Goal 明确保留的非 Bash scope 是 `tool-operation`、`file-path`、`web-origin`，只含这些 scope 的文件继续加载；含 `bash-command` 或旧形状 `bash-exact` 的文件整体以带文件路径和清理指引的 `ProjectApprovalLoadError` 失败。操作者可删除旧 Bash entries，或明确选择删除整文件；生产代码不迁移、不忽略、不 fallback。缺失文件只加载空内存，直到下一次 persistent approval 才创建。
- 单一 `classifySensitivePath({ inputBasename, effectiveCanonicalPath })` 返回 `bashCredential` 与 `fileToolSensitive` 两个事实，避免消费者复制 regex。`bashCredential` 按 operation-aware effective path 判断，封闭集合为：`.env`/`.env.*`（排除 `.env.example/.sample/.template`）、`.npmrc/.pypirc/.netrc`、`*.pem/*.key/*.p12`、`id_rsa*/id_dsa*/id_ecdsa*/id_ed25519*`，以及 `.ssh/**`、`.aws/**`、`.azure/**`、`.config/gcloud/**`。`fileToolSensitive` 严格按原始 input basename 和现有规则判断，以保持 `file_read/file_write` 当前 symlink 行为；file edit 等其他非 Bash 合同不在本 Goal 改动。
- `createProtectedPathPermission` 继续供 file/AST tools 使用，只删除其 Bash parser 分支；受保护路径事实仍只有一个 symlink-safe 生产来源。
- 不新增 Policy Engine、规则 DSL、插件系统、命令知识库、sandbox abstraction、新 manager 或第二套路径模型。现有 Registry、scheduler、HITL 仅增加 fingerprint 传递/核对和 eligibility 展示合同。

## Plan

1. 先用表驱动测试锁定有限语法、路径 operation、allow/ask/deny 和相邻反例。
2. 收窄 shell data model，实现 reachable cwd、固定 wrapper 和 operation-aware literal path descriptors；删除 effects/uncertainty policy。
3. 抽取单一 sensitive/protected path fact；Bash 每次尝试一次分析后执行有序 policy。
4. 将 deferred HITL decision 绑定 blocked fingerprint，并补齐 persistent-eligibility 的 protocol/server/Web 行为。
5. 硬切 approval schema；保留非 Bash scopes，严格拒绝 legacy Bash entries，不增加迁移或兼容。
6. 删除旧模块、分支、exports 和测试，完成全量验证与遗留搜索。

## Acceptance Criteria

以下 AC-01 至 AC-05 必须全部有代码、测试和运行证据；任一缺失即为 `NOT_DONE`。

### AC-01：默认允许且没有不确定性兜底

- 未命中明确规则必须 allow；未知命令、解析失败、substitution、heredoc、未知 wrapper、Python/Node/Ruby/Perl、package scripts、`git push`、`npm publish`、SSH、普通网络、workspace redirection、`rm -rf dist`、`find dist -delete`、`git reset --hard`、`git clean -nfdx`、`git clean -fd -- dist`、普通 `kill <pid>` 均有 allow 测试。
- `cd dist && rm -rf .` allow；`cd missing || rm -rf .` deny；`;` 分支检查原/新 cwd，pipeline cwd 不外溢。生产代码不存在 command allowlist、unknown-command fallback 或“无法判断所以 ask”。
- quoted dangerous text、shell comment、quoted `&`、`2>&1`、`>&2` allow；只有独立 unquoted background `&` 命中 deny。

### AC-02：Ask 边界与 exact approval 成立

- 已提取 literal path 在 workspace 外 ask；上述核心 descriptor 每类至少一组 operation 和 source/destination 测试。`cd /tmp && cat file`、`python /tmp/tool.py` ask；destination symlink 指向 workspace 外 directory 时，`cp/install/mv/ln source link` ask 且 scope 记录外部 directory 下的最终 child entry。动态路径本身不因不确定性 ask。
- Bash credential path 的 read/write/delete ask；例外模板 allow，指向 credential target 的 read/write symlink ask，而 `rm` 同一 symlink 按 entry delete 不误判 target。路径在 HITL 等待期间改向后必须重新分析：新结果 deny 则拒绝，仍为 ask 且 fingerprint 不同则创建新 HITL，已变为 allow 则忽略旧 decision 并执行；不得用旧 scope 批准新的 ask scope。
- privilege wrapper、下载内容直接 pipe 到 shell/interpreter ask。系统 mutation 固定表为：system `systemctl {start,stop,restart,reload,enable,disable,mask,unmask,daemon-reload,set-default,edit,link,preset,revert}`、`launchctl {load,unload,bootstrap,bootout,enable,disable,kickstart,kill,remove,submit,config}`、`iptables {-A,-D,-I,-R,-F,-Z,-N,-X,-P,-E}`、`nft {add,delete,insert,flush,replace,reset,import}`、`pfctl {-e,-d,-f,-F,-k,-K,-x}`、`ufw {enable,disable,default,allow,deny,reject,limit,delete,insert,route,reset,reload}`、`csrutil {enable,disable,clear,netboot,authenticated-root}`、`spctl {--add,--remove,--enable,--disable}`，以及 `security` 的 `add-*|delete-*|set-*|create-keychain|unlock-keychain|authorizationdb write|authorizationdb remove`；`systemctl --user ...` 及未列只读/help/version 形状 allow。
- 明确凭证外传仅指：`curl -T|--upload-file PATH`、`curl -d|--data|--data-binary @PATH`、`curl -F|--form NAME=@PATH`、`wget --post-file|--body-file PATH`、`scp/rsync` 的敏感本地 source + remote destination，或同一 pipeline 中敏感 read（含 input redirection）+ `nc|netcat`。只有命中该固定形状才 ask。
- exact scope 必须绑定 command、cwd 和全部已提取 literal accesses。approve always 仅在三者及 blocked fingerprint 完全相同时复用；任何动态语法或 secret-content ask 只显示/接受 Allow once，且不会落盘。

### AC-03：Hard deny 只覆盖确定性灾难与控制面

- execution root 与 canonical project root 下 `.archcode/**`、Git metadata 的明确 extracted write/delete deny；destination symlink 指向 `.archcode` directory 时，`cp/install/mv/ln source link` deny，而 `mv/ln -T source link` 按替换普通 symlink entry 判断、不误判 target。`git worktree {add,move,remove,prune,repair,lock,unlock}`，以及 `git branch|update-ref` 对 `archcode/*|refs/heads/archcode/*` 的 mutation deny；read、无 subcommand/`git worktree list` allow。root-wide 非 dry-run `git clean -fd/-fdx/-fdX` deny，dry-run 或 `git clean -fd -- dist` allow。
- `rm -rf`、`find ... -delete/-exec rm`、recursive `chmod/chown` 对 `/`、home、`/Users`、`/home`、`/etc`、`/usr`、`/bin`、`/sbin`、`/boot`、`/var`、`/opt`、`/System`、`/Library`、`/Applications`、`/Volumes`、execution root 或 canonical project root deny；固定变量/token 变体同判。对子目录等价操作 allow。
- 写入 existing block device 或 `/dev/disk*|/dev/rdisk*` deny；`dd of=workspace.img`、`dd of=/dev/null` allow，`dd of=/dev/diskN` deny，并覆盖透明/privilege wrapper。`/dev/stdin|stdout|stderr`、`/dev/fd/0|1|2` allow。固定无条件 deny 动词为 `diskutil eraseDisk|eraseVolume|zeroDisk|secureErase|partitionDisk`、`diskutil apfs deleteContainer|deleteVolume`、`zfs destroy|rollback`、`zpool destroy|labelclear`、`cryptsetup luksFormat|erase`、`lvremove|vgremove|pvremove`、`mdadm --zero-superblock`；`mkfs/wipefs/blkdiscard/shred/badblocks -w/fdisk/gdisk/parted` 仅对上述 device fact deny。
- `shutdown/reboot/poweroff/halt`、`init 0|6`、`systemctl poweroff|reboot|halt|kexec`、`launchctl reboot`、向 PID 1 或全部进程发信号，以及独立 background `&` deny。
- deny 在本 Goal 明列的 wrapper 形状和 command chain 中保持优先；`sudo rm -rf /`、`sudo systemctl poweroff` deny，`sudo apt update` ask。approval 永远不能覆盖 deny。

### AC-04：HITL、schema 与架构硬切完成

- 初次 blocked 保存 fingerprint；恢复时分别证明 same scope 消费 decision、symlink/cwd/accesses 改变重新 block、deny 立即拒绝、当前 allow 忽略旧 decision。每次尝试只调用一次 analyzer。
- ineligible ask 的 redacted API/UI 不显示 Always allow，服务端拒绝伪造 `approve_always`。secret command 不得被额外复制进 `blocker.permission`、scope preimage、HITL display 或 `permissions.json`；既有 authoritative Session tool-call input 持久化合同不在本 Goal 改动。
- approval schema 只保留当前 scopes；新 `bash-exact` 严格只允许 `command/cwd/accesses`。测试证明 non-Bash-only 文件成功、mixed legacy Bash 文件以 actionable `ProjectApprovalLoadError` 失败、missing 文件启动时不生成且后续 persistent approval 才生成。
- 依赖方向只能是 permission -> security analysis；protected/sensitive facts 各只有一个生产来源。旧 classifier/policy/effects/scopes、protected-path Bash branch、重复分析入口、legacy types/rules/exports/compatibility shells 全部删除，非 Bash protected/file approval 行为不退化。

### AC-05：验证与完成证据充分

- 回归覆盖 compound chain、wrapper 支持/不支持形状、cwd set、multi-path、redirection、source/destination、leaf symlink follow/non-follow、destination directory/symlink-to-directory、`mv/ln -T`、scope-bound resume、secret eligibility 和 deny 优先级；真实 Bash 进程测试继续覆盖 env、stdin、timeout、abort、signal 和 structured cwd。
- 审计不存在 `ShellEffect`、`attachShellEffects`、旧 ask rule ids、command allowlist、Bash `bash-command` scope、旧 `normalized/effects` 或 compatibility export。
- `bun run typecheck`、`bun run test`、`bun run build`、`git diff --check` 全部退出码为 0。
- Reviewer 逐项给出 AC-01 至 AC-05 的代码、测试、搜索和运行证据，并明确声明策略只覆盖静态可识别的明显误操作；不能以“测试通过”或“已保证安全”代替验收。
