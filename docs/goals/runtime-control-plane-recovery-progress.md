# Runtime Control Plane Recovery Progress

> 本文只记录实施进度和验收证据；目标、架构与完成标准以 `runtime-control-plane-recovery-plan-goal.md` 为准。

## Status

- Goal: complete; AC-01 through AC-08 independently approved
- Branch: `codex/runtime-control-plane-recovery`
- Baseline: `f8ab13e6`
- Started: 2026-08-04
- Unrelated local files preserved: `.DS_Store`, `output/`

## First-principles Corrections

- 已补齐 listener-first 约束：控制面的成立条件是 HTTP 已经监听，而不只是 Host 内部保留 nullable Runtime。Host 构造与 listener 绑定不得等待 Runtime recovery 或 scheduler 启动。
- Runtime Data 检测只描述当前数据健康，不推断启动因果或历史版本；升级功能保持独立。

## Workstreams

| Workstream | State | Evidence |
|---|---|---|
| Protocol and Runtime Data service | complete | Current-domain schemas reused directly; focused Runtime Data and architecture suites pass |
| ServerHost control-plane split | complete | Listener-first activation, one Host mutation queue, control-plane routes and Runtime gate covered by Server integration tests |
| Settings Runtime Data UI | complete | Shared recovery/dialog workspace, Runtime Data states, destructive confirmation and accessibility covered by Web unit/interaction tests |
| Cross-layer integration | complete | Two registered projects, failed activation, selective deletion and same-process recovery covered in the real Host suite |
| Invalid Config recovery | complete | Selective invalid-item removal, full-candidate validation, zero-mutation rejection and last-resort typed Reset pass Server/Web tests and real-browser recovery |
| Automated validation | complete | `bun run typecheck`, full `bun run test`, production build, binary version and `git diff --check` pass after AC-08 changes |
| Real-browser validation | complete | Prior Release Runtime Data QA remains valid; current non-mock dev Host completes selective Config recovery, typed Reset guard, responsive and console checks |
| Independent final review | approved | AC-01 through AC-08 approved after the AC-08 fix-review loop; final review found no P0, P1 or P2 |

## Acceptance Evidence

| Criterion | State | Evidence |
|---|---|---|
| AC-01 Control plane availability | approved | ServerHost tests cover listener-first activating/error states, Setup/auth, Config/Update access, seven Runtime API families returning 503, and recovery to the sole Runtime app |
| AC-02 Accurate bounded inspection | approved | Workspace/`.archcode`/Runtime components are checked no-follow before traversal; persisted schema keys are replaced by a bounded `$field` path and duplicate diagnostics are collapsed |
| AC-03 Safe deletion and recovery | approved | Runtime cleanup failure blocks retry/delete; the per-step shutdown state machine lets graceful restart retry only failed cleanup without repeating completed resources or creating a second Runtime |
| AC-04 Complete Settings recovery UI | approved | Unit/interaction plus real-browser checks cover all recovery states, default-empty selection, disabled healthy rows, confirmation/cancel, update independence, focus/ARIA, light/dark and 390/760/1024/1440 px |
| AC-05 Strict architecture | approved | Config/Update/Runtime Data live in Host control plane; Runtime app contains only Runtime routes; required shared ProjectRegistry injection and architecture tests enforce boundaries; no fallback/migration/tombstone path added |
| AC-06 End-to-end delivery | approved | Final full gates pass and the authenticated production Host test includes cleanup-incomplete through successful graceful shutdown |
| AC-07 Invalid Config self-recovery | approved | Invalid Config keeps the control plane available; grant-protected Settings recovery, redaction, same-process Retry, strict Reset and Setup handoff pass automated and real-browser checks; Round 3 approved every race and security boundary |
| AC-08 Preserve valid Config | approved | Core and Host tests cover opaque IDs, dotted dynamic identifiers, revision conflicts including concurrent external repair, full-candidate validation, selective success and byte-identical rejection; Web interaction and real browser cover default-empty selection, cancel/confirm, typed full Reset, same-process recovery and valid-setting preservation |

## Validation Record

- `bun run typecheck`: 5/5 workspaces passed.
- `bun run test`: final post-review-fix run passed 8/8 tasks; Server 291 tests / 934 assertions; Web interaction 113 tests / 606 assertions; Agent Core unit, 140 integration and 81 architecture tests passed.
- `bun run build`: Web production assets and compiled `dist/archcode` completed; `./dist/archcode --version` reported `archcode 0.0.8`.
- `git diff --check`: passed.
- Real browser fixture: incompatible Session in the isolated broken project and healthy Todo in a second project. The final rebuilt recovery UI exposed no persisted secret value, rendered one collapsed `$field` diagnostic instead of repeated or raw keys, Confirm consumed the final delete Runtime status, removed the incompatible Session, transitioned to the workbench, preserved both registry slugs, and left healthy Todo bytes at `{"todos":[],"runNowReceipts":[]}`.
- Responsive browser checks at 390, 760, 1024 and 1440 px reported no document horizontal overflow. Runtime Data rendered in both light and dark themes; browser console errors: 0.
- Config Recovery browser fixture: an unknown top-level Config key and secret sentinel produced only the canonical Config path plus one generic `configuration` issue. Without the terminal grant the page stayed blocked; with the grant it opened the full Settings shell, kept About & Updates enabled, disabled Config-dependent sections with a reason, and exposed neither the unknown key nor the secret.
- Config Recovery browser actions: invalid Retry stayed in recovery with an announced result; canceling Reset left the fixture file intact; confirming Reset removed only that file and entered the existing Setup with the same grant. In a fresh fixture, removing the invalid key externally and clicking Retry recovered the same process to the workbench. The 390 px and 1440 px layouts had no horizontal overflow; browser console errors: 0.
- Selective Config browser fixture: one unknown top-level field produced one default-unselected opaque recovery item while the provider/model/profile identifiers and secret remained absent from the DOM. Cancel sent no mutation and left the invalid field present. The confirmation warned that selected deletion is permanent and only commits a fully valid remainder. After confirmation, the same process reached Home with `runtime.ready`; the invalid field was absent, `qa-model`, principal/deep/fast Profiles and API key remained, file mode was `0600`, and Bootstrap was ready. Full Reset stayed separated under `last resort`, listed all valid settings that would be lost, and remained disabled for `RESE` but enabled for exact `RESET`. At 390 and 1440 px, document width equaled viewport width; browser errors and warnings: 0.

## Closed Review Findings

- P1 closed: Runtime inspection rejects workspace/`.archcode` ancestor symlinks without reading their targets.
- P1 closed: schema issue paths no longer expose dynamic persisted record keys.
- P1 closed: every Runtime resource cleanup is attempted; failed candidate cleanup blocks retry/delete and is presented as restart-required.
- P2 closed: delete response carries the final automatic Runtime activation status.
- P2 closed: server logs retain safely normalized internal startup/cleanup diagnostics while API/UI remain redacted.
- P2 closed: automated recovery uses production `createRuntime`, shared ProjectRegistry, real incompatible Session data and authentication.

## Closed Round 2 Finding

- P1 closed: `AgentRuntime.shutdown()` shares an in-flight attempt, remembers completed steps, and lets a later graceful shutdown retry only failed cleanup steps. A production Runtime Host test proves successful cleanup without a second Runtime factory call.

## Closed Config Recovery Review Findings

- P1 closed: Reset now atomically claims the current canonical pathname and fully revalidates that exact captured Config before deletion; a valid external replacement written inside the former validation-to-unlink window is preserved byte-for-byte and returns conflict.
- P1 closed: restoration has no check-then-rename path. It uses no-replace hard-linking, with atomic `wx` recreation only when hard links are unavailable, and never overwrites an external replacement.
- P2 closed: the reviewer contract explicitly covers AC-01 through AC-07.

## Closed AC-08 Round 1 Findings

- P1 closed: `resolveMcpConfig` failures now map only to the exact failing MCP server when the error owner is provable; unowned top-level MCP errors offer no removal. A two-server test proves the healthy server URL, headers, and secret survive selective recovery.
- P2 closed: removable item identities now use a process-local keyed HMAC over revision and internal path, so client-visible revisions cannot be used to enumerate hidden provider/model/server IDs; identical Configs in separate service processes produce different IDs.
- P2 closed: the no-replace candidate installation is the explicit commit point. Captured-file cleanup after that point is best-effort and cannot turn a committed recovery into a reported failure.
- P2 closed: the collapsed full-Reset summary has a 44px coarse-pointer interaction target, and dialog failure focus is scheduled after close so Radix focus restoration does not overwrite the recovery status focus.

## Closed AC-08 Round 2 Finding

- P2 closed: semantic recovery targets are created as structured path arrays at the validation source instead of being reconstructed from human-readable dotted issue paths. Tests prove `foo.bar` remains one MCP server ID segment and `broken.provider` remains one Provider ID segment while only its invalid `queryParams` is removed; healthy neighbors, models and secrets remain intact.

## Final AC-08 Review

- Round 3 approved with no P0, P1 or P2. The reviewer independently rechecked dotted MCP and Provider identifiers, exact selective deletion, full candidate validation, opaque HMAC item IDs, safe DTOs, atomic no-replace commit, conflict protection and `0600` permissions.

## Remaining Gate

- None.
