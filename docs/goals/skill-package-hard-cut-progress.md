# Skill Package Hard-Cut Progress

> 本文仅记录 [`skill-package-hard-cut-plan-goal.md`](./skill-package-hard-cut-plan-goal.md) 的执行进度、风险和验收证据。Goal 契约保持只读，不在这里重定义范围。

## Status

- Goal: complete
- Branch: `codex/skill-optimization`
- Started: 2026-08-08
- Current phase: accepted and complete

## Baseline

- Current production model loads each builtin as one imported `SKILL.md` string.
- Current filesystem discovery parses complete `SKILL.md` content rather than bounded metadata only.
- Current frontmatter uses ArchCode-only `when_to_use` and one builtin uses `allowed_tools`.
- Current `skill_read` accepts only `name`; package resources are not represented or readable.
- Existing 14 builtin `SKILL.md` edits predate this execution and are preserved as migration input.
- Unrelated untracked `packages/agent-core/src/.DS_Store` is outside scope and must remain untouched.

## First-Principles Decisions

| Decision | Reason |
| --- | --- |
| Keep one `SkillService` with schema, package reader, resolver, and builtin manifest modules | These are the four cohesive responsibilities required by the Goal; a registry/VFS/cache would add coupling without a current need. |
| Treat source precedence as whole-package replacement | Mixing an entry from one source with resources from another makes relative references unsafe and non-reproducible. |
| Adopt only stable Agent Skills metadata fields | Skill guidance must not become an alternate permission system; all unknown top-level fields use one validation rule. |
| Accept arbitrary resource bytes but keep `skill_read` text-only | Standard assets may be binary, while ArchCode's model-facing tool result is text; binary transport/rendering is a separate capability and remains out of scope. |
| Preserve runtime Agent eligibility and reserved builtin rules | Package loading changes storage and disclosure, not authority. |

## Workstream Progress

| Workstream | Owner | Status | Evidence |
| --- | --- | --- | --- |
| Core package schema/reader/resolver | root | complete | One package model, bounded discovery, fail-closed whole-package winner, resource safety, and typed single-resource reads; final focused review set 78/78 |
| Builtin content/package migration | delegated worker | complete | 14 standard entries; 13 justified resources; builtin diff-check pass |
| Model-facing tools and Prompt | delegated worker | complete | 57 focused tests pass; assigned diff-check pass |
| Architecture/test change map | delegated explorer | complete | Winner/discovery/limits/build/doc risks audited; official validator verified |
| Active docs and breaking release note | delegated worker | complete | Five active docs updated; assigned diff-check pass |
| Full verification | root | complete | Agent Core unit/integration/architecture, root typecheck/test/build, validator, standalone binary, and diff checks pass |
| Independent final review | fresh `gpt-5.6-sol` (`xhigh`) reviewer | complete | No open Blocker, Major, Minor, or required Advisory after fix-review closure |

## Builtin Migration Matrix

All third-party entries below are idea-only rewrites under ArchCode's MIT license; no OMO main text/code was copied and no substantial third-party text requiring a bundled notice was introduced.

| Skill | Pinned source / license | Functional overlap and retained ArchCode constraint | Package change / justification |
| --- | --- | --- | --- |
| `analyze-work` | Superpowers `44c9b2d`, MIT | Falsifiable root-cause method; retain Analyst read-only architecture/gap modes | `references/diagnosis-method.md` isolates hypothesis, boundary tracing, and stop rules |
| `automation-create` | ArchCode `f00efe7`, MIT | Runtime-schema-led creation and user confirmation | `references/schedule-examples.md` isolates once/interval/cron/timezone disambiguation |
| `codemap` | OMO Slim `ecb4f55`, MIT ideas | Evidence map for current task, no persistent codemap service | `references/evidence-map-example.md` supplies the focused output pattern |
| `execute-plan` | Superpowers `44c9b2d`, MIT ideas | Checkpointed execution; retain Todo-bound Plan authority | `references/execution-checkpoints.md` isolates checkpoint and acceptance boundaries |
| `git-master` | Superpowers `44c9b2d`, MIT ideas | Git/worktree operation safety; preserve current runtime tools | `references/operation-safety.md` isolates operation/recovery decision cards |
| `goal-review` | ArchCode `f00efe7`, MIT | Independent evidence review without machine verdict or Goal authority | `references/evidence-matrix-example.md` supplies a human-readable criterion matrix |
| `orchestrate-work` | ArchCode `f00efe7`, MIT | Lead delegation/integration while retaining ownership | `references/delegation-packet.md` isolates bounded handoff evidence |
| `plan-work` | Superpowers `44c9b2d`, MIT ideas | Executable Plan structure; preserve Analyst draft vs Lead/Discussion write boundary | `assets/plan-template.md` is a reusable Plan template |
| `research-docs` | ArchCode `f00efe7`, MIT | Official-source-first research with fact/inference separation | `references/source-evaluation.md` isolates ranking/conflict/stopping rules |
| `review-change` | Superpowers `44c9b2d`, MIT ideas | Plan/code/security review through an Analyst read-only lens | `references/review-lenses.md` isolates lens-specific evidence checks |
| `review-work` | Superpowers `44c9b2d`, MIT ideas | Lead review orchestration and remediation closure | `references/review-packet.md` isolates packet and fix-review handoff |
| `run-goal` | ArchCode `f00efe7`, MIT | Goal execution/recovery/final review lifecycle | Kept single-file because no non-duplicative reusable detail justified a resource |
| `safe-refactor` | Superpowers `44c9b2d`, MIT ideas | Behavior-preserving refactor loop | `references/boundary-verification.md` isolates dependency-boundary verification |
| `shape-todo` | Superpowers `44c9b2d`, MIT ideas | Evidence-first shaping; Discussion never implements | `references/todo-shaping-template.md` supplies scoped decision/acceptance structure |

## Verification Evidence

| Check | Result | Notes |
| --- | --- | --- |
| `git diff --check` for Goal plan | pass | Passed before implementation began. |
| Builtin frontmatter/name/direct-resource self-check | pass | 14/14 entries use only adopted fields, match directory names, stay below 500 lines, and directly reference every resource. |
| Pinned official `skills-ref 0.1.0` | pass | Agent Skills commit `217be548...`; 14/14 builtin directories returned `Valid skill`. This validates frontmatter/name only, not runtime resources. |
| Model-facing Skill/Prompt focused tests | pass | 57 pass, 0 fail. |
| Active documentation diff-check | pass | `AGENTS.md`, README, CHANGELOG, concepts, and multi-agent design. |
| Final focused schema/package/service/manifest/tool/prompt set | pass | 78 pass, 0 fail; includes source precedence, discovery, every fixed boundary, ancestry symlinks, arbitrary bytes, manifest completeness, envelopes, and Prompt disclosure. |
| Standalone builtin binary smoke | pass | 1 pass, 0 fail; compiles the real service/manifest, reads a real text reference, proves exact binary SHA-256/length round-trip, and checks the unsupported-binary envelope. |
| Agent Core unit lane | pass | 2,906 pass, 0 fail across 213 files. |
| Agent Core integration lane | pass | 141 pass, 0 fail across 24 files. |
| Agent Core architecture lane | pass | 81 pass, 0 fail across 17 files. |
| `bun run typecheck` | pass | 5/5 workspace tasks successful. |
| `bun run test` | pass | 8/8 Turborepo tasks successful. |
| `bun run build` | pass | Full typecheck, Vite production build, temporary embedded-asset entry, and compiled binary pipeline exited 0. |
| `git diff --check` | pass | Full worktree diff has no whitespace errors. |

The pinned validator command was:

```sh
UV_CACHE_DIR=/tmp/archcode-skill-uv-cache \
UV_TOOL_DIR=/tmp/archcode-skill-uv-tools \
UV_PYTHON_INSTALL_DIR=/tmp/archcode-skill-uv-python \
uvx --from 'git+https://github.com/agentskills/agentskills.git@217be548739f21d6008915c29aefe320ea1a90af#subdirectory=skills-ref' \
  skills-ref validate <builtin-skill-directory>
```

## Hard-Cut Search Classification

- Production Skill types, parser, tools, Prompt, manifest, and builtin entries contain zero `when_to_use`, `allowed_tools`, or `BUILTIN_SKILL_BODIES`. The only current active-doc occurrence is the CHANGELOG breaking-removal instruction.
- `packages/agent-core/src/utils/frontmatter.ts` and its memory consumers remain because they belong to the unrelated Memory subsystem; the Skill schema imports `yaml` directly and has no dependency on that generic parser.
- `Record<string, string>` remains only in unrelated generic/config/test helper types and test-only resource fixture builders; builtin production input is `BuiltinSkillPackage`, whose resources accept `string | Uint8Array`.
- `SkillCandidate` remains a private resolver union containing only source/root or embedded package identity; it has no entry/body/content field and performs no cross-source merge.
- Production has no `skill_run`, resource-list/resource-read sibling tool, remote catalog/source registry, compatibility source scan, cache, VFS, migration, or fallback resource path. Generic uses of words such as compatibility, merge, and fallback outside the Skill package subsystem are unrelated and retained.

## Risks / Corrections

- Binary builtin assets require a real standalone byte round-trip, not only a text-resource build check.
- Generic unknown-field validation must not become a field-specific legacy/tombstone test.
- Discovery tests must prove that neither the Markdown body nor package traversal is performed, rather than merely checking a metadata-shaped return value.
- Discovery originally checked total entry size; corrected because body size belongs to activation. Prefix reads now loop to EOF/limit rather than assuming one file read fills the buffer.
- Builtin package entry counts originally omitted implicit resource directories; corrected to match filesystem package accounting.
- Resource reads now open without following the final symlink and re-check file type/size on the open handle before and after reading.

## Independent Final Review And Fix Closure

The required fresh independent review used `gpt-5.6-sol` with `xhigh` reasoning. It found one Major and five Minor defects; each was fixed and re-reviewed by the same reviewer:

| Severity | Finding | Closure evidence |
| --- | --- | --- |
| Major | A symlink in project Skill ancestry could make an outside package appear under the lexical project path | Reader APIs now require a trusted boundary and check every directory before and after discovery/activation/resource reads; project/user source boundaries are explicit; package/service regressions pass. |
| Minor | `listForAgent` could `readdir` a symlinked source root before package validation | Source ancestry is checked before and after name enumeration, including an empty external-root regression. |
| Minor | Direct candidate existence could probe through a source symlink and then fall back to builtin | Candidate existence now uses the same boundary-aware traversal before any guessed package stat or fallback. |
| Minor | Builtin resources could use the impossible path `SKILL.md/hidden.txt` | Every resource whose first segment is `SKILL.md` is rejected; builtin and generic path regressions pass. |
| Minor | Description/compatibility limits were counted after trim | Raw YAML strings are code-point counted before trim/min validation, matching the pinned validator boundary. |
| Minor | Inherited object property `constructor` could be mistaken for a builtin Skill | Builtin lookup requires `Object.hasOwn`; direct discovery and activation return no Skill for inherited names. |

Final reviewer conclusion: AC-01 through AC-09 pass, with no open Blocker, Major, Minor, or required Advisory. It separately confirmed that active Prompt metadata and UTF-8 BOM behavior do not violate the locked contract: auto-active Skills expose the required body/resource inventory, while optional metadata remains available through explicit entry activation; decoded text semantics do not require preserving a BOM as body content.

## Final Acceptance Audit

| Criterion | Result | Primary evidence |
| --- | --- | --- |
| AC-01 | pass | Package-oriented types/service, own-property builtin lookup, project > user > builtin whole-package tests, reserved gates, no resource fallthrough. |
| AC-02 | pass | Strict five-field YAML schema and raw character limits; 14/14 validator pass; zero old fields/body map/Skill generic-parser use. |
| AC-03 | pass | Metadata-only discovery tests; deterministic entry/resource envelopes; active Prompt resource descriptors; winner re-resolution tests. |
| AC-04 | pass | Below/equal/above limits, invalid paths, entry/resource UTF-8, arbitrary bytes, full ancestry and root/entry/directory/resource symlink regressions. |
| AC-05 | pass | Complete explicit 14-package manifest; real text resource plus exact binary standalone round-trip; production build passes. |
| AC-06 | pass | Existing Agent-definition eligibility remains authoritative; guidance-only Prompt; no executor/materializer/permission metadata. |
| AC-07 | pass | Fourteen-row migration matrix, direct resource references, all entries below 500 lines, role-boundary checks, no copied OMO main content. |
| AC-08 | pass | Only schema/package-reader/service/manifest responsibilities; hard-cut search classification; no registry/VFS/cache/second resource tool/fallback. |
| AC-09 | pass | Focused and all Agent Core lanes, root typecheck/test/build, official validator, diff-check, and fresh independent fix-review all pass. |

Accepted residual risk: a separate malicious local process could attempt a nanosecond-scale directory swap between pre/post checks. Static and persistent symlink escape is rejected; fully atomic `openat`-style traversal is unavailable through the current JavaScript file API and is outside this local same-trust-boundary Goal.
