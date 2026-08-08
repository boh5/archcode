# Skill Package Hard-Cut Plan Goal

> 本文是 ArchCode Skill Package 重构与内置 Skill 优化的实施、验收契约。实施进度与证据另记于 `skill-package-hard-cut-progress.md`，不得回写并稀释本契约。

## Objective

把 ArchCode 的 Skill 从“一个 Markdown 字符串”彻底重构为符合 Agent Skills 公开规范的本地多文件包，并在同一 hard cut 中迁移、精炼现有 14 个 builtin Skills。这里的“标准”指包结构、稳定 frontmatter、相对路径和渐进披露；唯一明确排除的是规范中可选且标记为 experimental 的 `allowed-tools`。完成后：

- 模型发现 Skill 时只看到标准元数据；激活时读取 `SKILL.md` 与资源清单；需要细节时再读取单个资源。
- project、user、builtin 三种来源使用同一包语义、同一校验和同一权限边界。
- 内置 Skill 可携带 `references/`、`assets/` 等标准资源，并完整进入 Bun 编译产物；没有实际用途就不创建目录。
- Skill 仍然只是方法指导，绝不授予工具、Agent、Profile、MCP、workspace 或完成权限。
- 旧单字符串模型、旧 frontmatter、兼容读取、fallback、迁移和墓碑测试全部删除。

## Evidence Baseline

实施以以下固定源码快照为参考，不追随浮动分支：

| Evidence | 固定快照 | 本 Goal 借鉴内容 |
| --- | --- | --- |
| Agent Skills | [`217be54`](https://github.com/agentskills/agentskills/tree/217be548739f21d6008915c29aefe320ea1a90af) | 目录结构、标准 frontmatter、渐进披露、相对资源路径 |
| OpenCode | [`fe82a1b`](https://github.com/anomalyco/opencode/tree/fe82a1b6ca4f535beb973b0867017e3f639f85ed) | 元数据发现、激活后暴露资源清单、包级优先级 |
| Superpowers | [`44c9b2d`](https://github.com/obra/superpowers/tree/44c9b2d6e889982ac18c27d05a19fefe335194e1) | MIT 工作流内容、references/scripts/examples 拆分和行为场景设计 |
| OMO | [`76b9aa8`](https://github.com/code-yeongyu/oh-my-openagent/tree/76b9aa8d3adb7260ca2a260241e3bafb3e78db0c) | 多来源 loader 与 shared-skills 的设计证据；Sustainable Use License 内容只研究，不直接复制 |
| OMO Slim | [`ecb4f55`](https://github.com/alvinunreal/oh-my-opencode-slim/tree/ecb4f55e87c7cea9f18759eaca0eff8fb7edf1d0) | MIT 的 codemap、verification、worktree 等精简方法与来源标注 |

参考不等于照搬宿主能力。ArchCode 不引入竞品的远程目录、Skill 内 MCP、model/agent override、自动更新或 Skill 授权语义。

## Locked Architecture

### Package contract

```text
<skill-name>/
├── SKILL.md                 # required: metadata + concise method entry
├── scripts/                # optional: executable code
├── references/             # optional: documentation loaded on demand
├── assets/                 # optional: templates and static resources
└── ...                     # optional: any additional files/directories
```

This is the public Agent Skills directory shape rather than an ArchCode-specific taxonomy。Builtin examples belong in focused `references/` files；reusable templates belong in `assets/`。Additional directories are accepted by the package reader because the specification permits them, but curated builtins use the three standard directories unless a concrete need justifies another one。

Curated `SKILL.md` entries stay below the specification's recommended 500 lines and reference supporting files directly with Skill-root-relative paths such as `references/review-packet.md` or `assets/plan-template.md`。Do not require the model to discover a resource through a chain of nested reference files。

- project source remains `<workspace>/.archcode/skills/<name>/`；user source remains `~/.archcode/skills/<name>/`；builtin source remains compiled with Agent Core。
- Skill discovery remains one directory below each source root；only supporting resources recurse inside a package。Do not add `.claude`、`.agents`、OpenCode directories or arbitrary source configuration。
- Ordinary Skill precedence remains project > user > builtin。A winning package replaces the lower package atomically；entry and resources never merge or fall through。
- Reserved lifecycle builtin Skills remain unshadowable and still require the current Agent eligibility。An invalid or unreadable winning package fails closed。

### Standard metadata hard cut

`SKILL.md` uses strict YAML frontmatter：

- required: `name`, `description`；`description` must describe both function and activation timing。
- supported optional fields: `license`, `compatibility`, `metadata`。
- `name` must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`, be 1–64 characters, and equal the package directory name。
- `description` is 1–1024 characters and contains both what the Skill does and when to use it；`compatibility`, when present, is 1–500 characters；`metadata` is a string-to-string map。
- Delete ArchCode-only `when_to_use` and `allowed_tools` from types, parser, prompts, tools, tests and all builtin files。No dual schema or migration。
- Add the maintained `yaml` runtime dependency for Skill frontmatter only。Do not expand or replace the repository-wide simple frontmatter utility used by unrelated subsystems。
- Reject every top-level frontmatter field outside the five adopted fields through one generic unknown-field rule；do not add field-specific ignore, display, compatibility or rejection branches。

### Runtime ownership and read flow

Keep one public `SkillService`; do not build a generic plugin/catalog framework。Its internals have four cohesive responsibilities：

```text
schema.ts            -> parse and validate Skill metadata/body
package-reader.ts    -> validate and read one filesystem package
builtin/manifest.ts  -> provide embedded builtin package contents
service.ts           -> resolve source precedence and Agent eligibility
```

The model-facing flow is：

1. `skill_list({})` and the System Prompt list exactly `name`, `description`, `source`。They do not load body or resource contents。
2. Active lifecycle Skills and `skill_read({ name })` load the winning `SKILL.md` body plus a sorted list of relative resource paths；resource contents remain absent。
3. `skill_read({ name, resource })` re-resolves precedence and attempts a text read of exactly one listed resource from the current winning package。Valid UTF-8 is returned exactly；binary content gets a deterministic unsupported-binary result rather than invalidating the package。`resource` is a package-relative path, never an arbitrary filesystem path；if the winner changed after activation, no snapshot guarantee is made and no lower source may supply the resource。
4. Do not add `skill_resource_list`, `skill_resource_read`, cache/invalidation, VFS, registry interface or another service。The existing `skill_read` owns both entry and contained-resource reads。

`ResolvedSkill` becomes a package-oriented result containing metadata, entry body, source, source label, optional filesystem package root and immutable `{ path, bytes }` resource descriptors。Prompt trace may keep its existing `{name, source}` protocol shape；it must use the resolved package source and must not invent a new persisted Skill state machine。

`skill_read` output is deterministic：

- Entry read emits the current metadata header in fixed field order (`name`, `description`, `source`, optional filesystem `root`, then present optional fields), a `Resources` section sorted by `path` as `- <path> (<bytes> bytes)`, then the exact Markdown body。An empty package emits `Resources: none`。The root lets an Agent resolve standard relative script/asset references for project/user packages；embedded builtins have no pretend filesystem path。
- Text resource read emits a fixed header in the order `skill`, `source`, `resource`, `bytes`, then the exact decoded resource text。Unsupported binary reads use the same identity header plus a fixed error code/hint and never repeat the package body or other resource contents。
- `skill_list` and available Prompt metadata remain exactly `name`, `description`, `source`；license, compatibility and provenance appear only after entry activation。

### Resource and packaging boundaries

- `SKILL.md` must be a regular, valid UTF-8 file。Package resources may contain arbitrary bytes, as required for standard `assets/`；the text-only `skill_read` path decodes a requested resource with fatal UTF-8 validation and returns a clear unsupported-binary error when it is not text。Symlinked package roots, entries, directories or resources are rejected even when the target stays inside the root。
- Normalize resource paths to sorted POSIX-relative paths。Reject absolute paths, empty segments, `.`/`..`, backslashes and paths outside the winning package。
- Fixed v1 limits, with no config surface: frontmatter 16 KiB；`SKILL.md` 128 KiB；one resource 1 MiB；at most 128 resource files；at most 256 total directory entries；resource depth at most 8 segments below the package root；aggregate bytes of `SKILL.md` plus all resource files 8 MiB。
- Discovery reads only enough bytes to close and validate the bounded frontmatter。Body, bounded resource traversal, file sizes and aggregate limits are validated at activation；resource bytes and UTF-8 validity are checked only when that one resource is requested。
- `scripts/` follows the standard meaning: executable code referenced relative to the Skill root。An Agent may execute an accessible project/user script only through its existing Bash permission and normal path controls；this does not create a Skill-owned permission path。The 14 curated builtins do not add executable scripts in this Goal, so compiled-builtin materialization is unnecessary。Do not add `skill_run`, temp materialization or automatic execution。
- Replace `BUILTIN_SKILL_BODIES` with `BUILTIN_SKILL_PACKAGES`。Use explicit static imports for every curated builtin entry/resource；text entries may use Bun's text loader and arbitrary assets use the file loader plus `Bun.file(...).bytes()` so standalone binaries preserve exact bytes。Do not add code generation or runtime source-tree scanning。
- A manifest completeness test compares the source builtin directories with the declared package map during tests。A serial integration smoke compiles and executes a temporary standalone binary that imports the real `SkillService` and builtin manifest: it asserts one real embedded builtin text resource, then constructs one test-only builtin package through the same package contract from a statically imported non-UTF-8 fixture and asserts byte-for-byte equality before the text reader returns the standard unsupported-binary result。It uses an isolated temp directory and leaves no product hook or artifact。The normal `bun run build` must also succeed。

## Builtin Skill Content Migration

Analyze and migrate one Skill at a time。Do not create empty directories, ceremonial references or duplicate a method merely to make every Skill multi-file。

| Skill(s) | Required improvement and primary reference |
| --- | --- |
| `analyze-work` | Keep mode selection in `SKILL.md`; move falsifiable diagnosis, root-cause tracing and boundary probes into focused references，primarily Superpowers systematic-debugging |
| `safe-refactor` | Keep behavior-preserving loop in entry；add dependency-boundary and verification decision material from MIT refactoring/TDD sources |
| `review-change` | Separate plan/code/security lenses, finding quality, severity/confidence and unable-to-conclude examples，using Superpowers review/verification methods |
| `review-work` | Keep Lead orchestration in entry；move review-packet and remediation-loop detail into a reference，without duplicating Analyst review logic |
| `goal-review` | Keep criterion-by-criterion independent final gate；provide a compact evidence-matrix example，without machine verdicts or Goal status authority |
| `shape-todo` | Adapt Superpowers brainstorming around evidence-first shaping；provide a concise scope/decision/acceptance template tied to the bound Todo |
| `plan-work` | Adapt writing-plans structure into an ArchCode Plan template；retain Analyst read-only draft and Lead/Discussion write ownership |
| `execute-plan` | Adapt executing-plans checkpoints while preserving Todo-bound Plan authority and current handoff semantics |
| `orchestrate-work` | Keep direct-vs-delegate decisions concise；use references only for delegation packets and integration gates |
| `run-goal` | Keep current Goal lifecycle, stop conditions and fresh final Analyst review；do not import a generic workflow engine |
| `codemap` | Adapt OMO Slim codemap ideas into a slim evidence map schema and one example；do not create persistent codemap runtime services |
| `research-docs` | Add source ranking, version/conflict handling, direct-link and stopping criteria as a reusable reference；keep official-source-first behavior |
| `git-master` | Use MIT Git/worktree/finish-branch material for operation selection and safety；do not copy Sustainable Use License text from OMO main |
| `automation-create` | Remain runtime-schema-led and compact；add examples only when they clarify once/interval/cron and timezone ambiguity |

Each migrated Skill must record `license` and `metadata` provenance (`archcode/source`, pinned commit, and adaptation type)。Substantial MIT text/code adaptation bundles the required notice；idea-only rewrites remain ArchCode MIT and still cite the evidence in the progress matrix。OMO main is never a direct-copy source。

## Implementation Plan

1. **Hard-cut domain/schema**：replace string/body types with package types；add Skill-specific YAML parsing with only the five adopted Agent Skills metadata fields/limits and one generic unknown-field rule；remove old fields and simple-YAML dependence from Skills。
2. **Filesystem package reader**：implement bounded header discovery, activation-time recursive manifest validation, entry UTF-8/size/symlink/path checks, arbitrary-byte resource inventory and single text-resource reads。
3. **Resolver**：refactor `SkillService` to resolve complete project/user/builtin packages atomically while preserving ordinary precedence, reserved builtins, Agent eligibility and fail-closed behavior。
4. **Builtin embedding**：replace the body map with the explicit package map and completeness tests；prove all declared resources work in tests and `bun run build`。
5. **Model contract**：extend `skill_read` with optional `resource`；update `skill_list`, Prompt rendering, traces, tool descriptions and model-visible contract tests；do not add another tool。
6. **Migrate content one by one**：for each of the 14 Skills, first record functional overlap/source/license, then rewrite/split only justified content, run its structural and role-boundary checks, and continue to the next Skill。
7. **Documentation and hard-cut cleanup**：update `AGENTS.md` and active architecture docs；add the data-breaking release note for existing project/user Skills；delete obsolete exports, fixtures and tests without adding legacy rejection/tombstone coverage。
8. **Verification and review**：run focused tests, all Agent Core lanes, root typecheck/test/build and diff checks；run the pinned official `skills-ref validate` against every builtin package as one-off conformance evidence without adding it as an ArchCode runtime dependency；then use a fresh independent deep Reviewer to inspect the full implementation against every AC and repeat fix -> review for blocking/high findings。

## Non-goals

- No remote HTTP/Git catalog, marketplace, installation, update, lockfile or source configuration。
- No `.claude`/`.agents` compatibility scan, recursive nested Skill discovery or cross-package resource references。
- No Skill-provided MCP, Agent/Profile/model override, tool permission grant, hooks or executable runtime。
- No new image/PDF renderer, generic MIME system, binary-to-model transport, VFS, cache, version resolver or workflow engine。Binary files remain valid package assets；this Goal does not invent a second media toolchain to render them。
- No migration of persisted runtime state；Skills remain filesystem/builtin guidance and are not new product work items。

## Risks And Controls

| Risk | Control / accepted tradeoff |
| --- | --- |
| Existing user/project Skills stop parsing | Intentional hard cut；publish exact new schema and manual conversion instructions，with no fallback or migration |
| Package traversal or symlink escape | Reject all symlinks；canonical contained paths, POSIX-relative validation and fixed depth/entry/file/aggregate limits |
| Builtin resources work in source but disappear from binary | Explicit static imports, manifest completeness test and full standalone build |
| Skill metadata accidentally expands authority | Only the five adopted metadata fields exist；runtime Agent definitions remain the sole tool-permission authority |
| Content becomes long or duplicated | Entry stays a concise router；resources are focused and loaded on demand；no forced resource count or shared generic framework |
| Upstream copying violates license | Pin commit/license per Skill；copy only MIT-compatible material with required notice；OMO main is research-only |
| Scripts create a hidden execution path | No executor/materializer；readable contents only，execution remains ordinary Bash permission where a real filesystem path exists |

## Acceptance Criteria

AC-01 through AC-09 must all have source, test, search or build evidence。Any missing item is `NOT_DONE`。

### AC-01: one package model and exact source semantics

- Production types and service represent a Skill as one package with metadata, entry, source and resources；`Record<string,string>` builtin bodies and entry-only candidates no longer exist。
- Only project、user、builtin sources exist；ordinary precedence is project > user > builtin；reserved builtins remain unshadowable and Agent-gated。
- A winning package is atomic：a missing resource never falls through to a lower source；invalid/unreadable winning packages fail closed。

### AC-02: standard metadata hard cut is complete

- Required/optional fields, limits, name regex and directory-name equality match “Standard metadata hard cut”。Nested `metadata` parses correctly through the dedicated YAML parser。
- Every builtin uses the new schema；available-skill Prompt/tool output no longer depends on separate `when_to_use`。
- Production code and current fixtures have zero `when_to_use`, `allowed_tools`, `BUILTIN_SKILL_BODIES` or Skills using the generic simple-YAML parser。
- A generic unknown-field fixture fails validation；production code has no field-specific branch for unsupported frontmatter names。
- No alias, optional legacy field, dual parse, migration, feature flag, fallback or tombstone test remains。

### AC-03: progressive disclosure is real

- `skill_list` and available Prompt metadata succeed without reading body or walking resource contents；a focused test proves metadata discovery does not invoke full-entry/resource reads。
- `skill_read({name})` returns the exact winning entry body and sorted relative resource descriptors, but none of their contents。
- `skill_read({name, resource})` re-resolves and returns exactly one declared resource from the current winning package；unknown or unlisted resources fail and never fall through to a lower source。Changing files or precedence between calls may change the winner and is intentionally not snapshot-consistent。
- Auto-active lifecycle Skills use the same resolved package result and expose the same resource list as explicit activation。
- Entry and resource reads use the exact deterministic envelopes defined in “Runtime ownership and read flow”；tests assert field order, sorted descriptors, exact body/text and absence of unrequested resource contents。

### AC-04: resource safety and limits are enforced

- Tests cover every fixed byte/depth/entry/count limit at below/equal/above boundaries, valid entry UTF-8, arbitrary-byte resource inventory, text-read invalid UTF-8/unsupported-binary failure, absolute/traversal/backslash paths and symlinked root/entry/directory/resource。
- Package resource descriptors are stable, unique, sorted POSIX-relative paths；`SKILL.md` is never duplicated as a resource。
- Project/user reads stay inside the winning package；builtin reads use only the embedded map。No model input can supply a source or absolute base path。

### AC-05: builtin packages survive standalone compilation

- `BUILTIN_SKILL_PACKAGES` contains all 14 entries and every non-`SKILL.md` file under each builtin directory；the completeness test rejects omissions and extras。
- At least one multi-file builtin is read through `skill_read` in ordinary tests。A serial integration smoke compiles and runs a temporary standalone binary against the real `SkillService`/builtin manifest, asserts one real embedded text resource, and passes a statically imported non-UTF-8 fixture through the same builtin package contract to prove exact byte round-trip plus deterministic unsupported-binary reading；`bun run build` also exits 0。
- There is no runtime scan of the repository source tree, generated manifest, dev-only filesystem fallback or post-build copy step。

### AC-06: Agent authority is unchanged

- Skill availability remains definition-based plus custom project/user behavior；resource reads require the same allowed Skill name and current Agent eligibility as entry reads。
- The only accepted metadata fields are `name`, `description`, `license`, `compatibility`, and `metadata`；none can add, remove or pre-approve a tool for any Agent。
- No Skill can alter delegation targets, Profile/model, MCP, Goal completion authority, workspace scope or permissions；Prompt states the same guidance-only contract。
- No `skill_run`, automatic script execution, temp materialization or second execution path exists。

### AC-07: all builtin content is individually justified

- The progress document contains one row per builtin Skill with pinned source, license, functional overlap, retained ArchCode constraints, files added/moved and reason for either using or not using resources。
- Every `SKILL.md` is a concise entry method；detailed reusable material lives in focused resources and every referenced relative path exists。No empty/ceremonial directory or duplicate cross-Skill manual is accepted。
- Every builtin entry is below 500 lines, directly names each supporting resource with a Skill-root-relative path, and does not require multi-hop reference discovery。
- The role boundaries in the migration table are preserved，especially Discussion no implementation、Analyst source-read-only、Lead completion ownership and runtime-schema-led Automation。
- Substantial third-party adaptations include required license/notice；OMO main contributes no copied text/code。

### AC-08: hard cut and low-coupling audit passes

- Deleted legacy types/functions/exports/tests/docs have no consumer；no compatibility adapter, migration, fallback, deprecated field, dual read/write or graveyard test exists。
- `SkillService + package-reader + schema + builtin manifest` is the complete implementation；there is no generic source registry、catalog interface、VFS、cache、resource service or workflow abstraction。
- `skill_read` is the only full Skill/resource read tool；all six Agent definitions continue to receive Skill access through the existing shared capability package。

### AC-09: verification and independent acceptance are complete

- Focused schema/service/tool/prompt/manifest/model-visible tests pass，including package precedence, atomic no-merge, progressive disclosure and resource security。
- The official `skills-ref validate` command from the pinned Agent Skills evidence snapshot accepts all 14 builtin packages；the command/version and output are recorded in the progress evidence, with no production dependency or network call added to ArchCode。
- Agent Core unit、integration and architecture lanes pass；`bun run typecheck`, `bun run test`, `bun run build` and `git diff --check` all exit 0。
- Exact searches and manual classification prove AC-02、AC-06 and AC-08 cleanup without deleting legitimate historical records。
- A fresh independent `gpt-5.6-sol` deep Reviewer checks the final diff criterion-by-criterion。Any blocker/high finding is fixed and the full affected AC is re-reviewed before completion。

## Hard-Cut Audit

Before marking implementation complete, search and classify at minimum：`when_to_use`, `allowed_tools`, `BUILTIN_SKILL_BODIES`, `Record<string, string>` Skill inputs, entry-only `SkillCandidate.content`, Skills calling the generic simple frontmatter parser, resource fallback/merge, Skill permission grants, `skill_run`, remote catalog/config and compatibility source directories。Historical docs may remain only when clearly historical and not imported or presented as the current contract。
