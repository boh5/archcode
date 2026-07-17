# Bash Permission Policy Hard-Cut Progress

## Status

- Goal: `docs/goals/bash-permission-policy-hard-cut-goal.md`
- State: accepted
- Started: 2026-07-17
- Working tree at start: only the Goal document was untracked

## Workstreams

| Workstream | Owner | State |
| --- | --- | --- |
| Finite shell analysis and Bash policy | core worker | complete |
| Exact approval, deferred HITL fingerprint, protocol/Web | approval worker | complete |
| Dependency and test-surface audit | audit agent | complete |
| Integration, legacy deletion, full verification | primary agent | complete |
| Independent final review and fix loop | independent reviewer (`sol/max`) | PASS |

## Acceptance Tracker

- AC-01 default allow and no uncertainty fallback: accepted
- AC-02 narrow asks and exact approval: accepted
- AC-03 deterministic hard deny: accepted
- AC-04 HITL/schema/architecture hard cut: accepted
- AC-05 full verification and evidence audit: accepted

## Execution Log

- Confirmed the accepted Goal specification and current legacy implementation surfaces.
- Split implementation into non-overlapping core-policy (`sol/high`) and approval/HITL (`sol/medium`) workstreams; used `luna/high` for a read-only dependency/test audit.
- Reserved final integration, repository-wide legacy search, full validation, and independent review for the primary agent.
- Audit identified parser edge cases (`2>&1`, nested shell background, safe device paths), stale barrels/tests, durable HITL eligibility propagation, and architecture-contract updates; routed implementation findings to the owning workers.
- Hard-deleted the legacy Bash classifier/effects/policy/scopes modules and old behavior tests.
- Rewrote stale permission regressions and builtin registration assertions to the new default-allow/ask/deny contract.
- Agent-core typecheck passed after integration.
- Corrected a Goal wording conflict: `$HOME/project` is not a catastrophe deny, but it remains an outside-workspace ask.
- Local audit found and fixed missing operation facts for `find -delete`, `sed -i`, `tar -C`, nested-shell redirections, scoped root `git clean`, managed-branch reads, and ineligible exact-scope fingerprints.
- Fixed adjacent policy holes rather than patching isolated examples: `git clean` option arity/excludes, `runuser` supported forms, `chmod/chown/truncate --reference`, combined tar archive operands, short/long attached grep/sed/curl/wget options, generic fd duplication/path redirections, here-strings, and `find -L`.
- Corrected downloaded-pipe detection so literal `sh|bash -c` keeps its wrapper fact after nested analysis.
- Split the single public `analyzeBash` execution entry from internal literal-shell recursion; the permission owner calls the public analyzer exactly once per attempt.
- Added real Registry + Bash permission resume tests proving same-scope consumption, symlink-retarget reblocking, fresh deny precedence, fresh allow ignoring stale decisions, and canonical cwd rebinding.
- Added architecture contracts for deleted legacy files, one-way permission -> analysis dependency, a single Bash decision owner/consumer, one sensitive/protected fact owner, and the sole strict legacy rejection boundary.
- Added table-driven coverage for the complete fixed system-mutation table, catastrophe/disk/power/process shapes, supported/unsupported wrappers, path descriptor families, credential transfer forms, and adjacent read-only cases.
- Updated `AGENTS.md` and old workbench documentation that still described the removed `bash-classifier` or broad Git denial behavior.
- First-principles correction: a finite parser must treat option arity as part of the path contract; shared “all flags take values” logic was removed because it silently dropped real paths such as `cat -n .env`.
- First-principles correction: `git branch` protection is mutation-based, not string-based; read forms such as `--contains` and formatted listings remain allowed even when they mention `archcode/*`.
- Extended tar operation facts so append/update/concatenate/delete classify the archive operand as a write; protected archive targets therefore retain hard-deny precedence.
- Final focused rerun exposed a same-millisecond HITL test ordering assumption. Replaced the positional assertion with identity-based checks; this removes timing nondeterminism without changing queue behavior.
- Independent `sol/max` review rejected the first candidate rather than accepting green tests as proof. It found concrete parser/descriptor bypasses in heredoc handling, redirection words, destination modes, interpreter/source operands, unsupported options, symlink deletes, and lexical control-plane paths; each finding is being fixed at the shared semantic owner with an adjacent counterexample.
- Replaced regex heredoc stripping with quote/comment-aware delimiter discovery, shell quote removal, arbitrary delimiter words, and an ordered multi-heredoc body queue. Added both directions of the invariant: body text is opaque, while commands after the real final delimiter are still analyzed.
- First-principles correction: a preprocessing heuristic that may suppress source text must be conservative and syntax-aware. False heredoc recognition is not merely a false positive; it can hide later catastrophe commands, so quote/comment awareness and post-body regressions are mandatory.
- Modeled `install -d/--directory` as create-entry writes for every directory operand and added attached `-tPATH` destination handling for `cp/install/mv/ln`.
- Stopped interpreter and `source`/`.` option parsing at the primary script operand so ordinary script arguments cannot erase the literal script access.
- First-principles correction: descriptor validity is atomic. If any unlisted option shape invalidates a descriptor, all accesses manufactured by that descriptor are discarded; independent shell redirections and executable-path facts remain separate.
- Closed curl/wget option shapes and applied the atomic descriptor rule to earlier grep/sed path extraction; direct opaque forms default allow and independently privileged forms remain non-persistable asks.
- Preserved trailing-slash path semantics: destructive `rm`, `rmdir`, and `find` follow a final directory symlink only when the shell operand ends in `/`; entry deletes without the slash retain non-following behavior.
- Protected both the lexical `.archcode` entry/subtree and its canonical resolved state directory, without broadening protection to differently named symlink entries.
- Removed the last stale document wording that described permission/HITL as a tool security boundary; hard tool availability and the UX permission guardrail are now stated separately.
- Extended the same closed-descriptor discipline to common real-world forms instead of allowing a tiny allow-set to become a bypass: finite benign curl/wget flags preserve credential-transfer detection, fixed system verbs are located after supported global flags, and unsupported privileged system shapes are explicitly non-persistable.
- Added closed shell short-bundle handling for literal `-c` payloads (`bash -lc`, `sh -ec`, etc.), literal leading assignment peeling, stdout-only `>&WORD` path handling, and opaque arithmetic/input-fd constructs so only an independent top-level `&` triggers the background deny.
- First-principles correction: path canonicalization must preserve lexical component order. A symlink must resolve before a following `..`; existing components must also recover their real on-disk casing on case-insensitive filesystems. Pre-normalizing the whole string violates both invariants.
- Rebuilt heredoc preprocessing around logical command blocks: unquoted backslash-newline is removed before delimiter discovery, ANSI-C/locale quote removal is recognized for finite delimiters, pipeline continuations delay body consumption, and quoted/substitution regions cannot manufacture fake heredocs that hide later commands.
- Unified tar option/mode parsing so attached value tails and operands after `--` cannot be mistaken for mutation modes; added Git `clean --force`, systemctl common globals, curl form attributes, and directory-forcing `find link/.` coverage from independent review repros.
- First-principles correction: command-local help/version and non-mutating probes terminate mutation classification. This now covers Git mutation subcommands, `security`, `spctl`, `pfctl`, `iptables`, and `kill -0`; invalid or unsupported shapes default allow and are ineligible for reusable privileged approval.
- First-principles correction: Git pathspec interpretation is execution state, not a permission-layer guess. The analyzer now carries default/literal/noglob mode through leading assignments and nested `env` wrappers, including override, clear, and unset order; root-wide `git clean` denies only when the resulting pathspec is certainly whole-tree.
- Independent `sol/max` review completed its fix/review loop and returned PASS for AC-01 through AC-05 with no remaining release blocker.

## Verification Evidence

- Core worker focused suite: 62 passed.
- Approval/HITL worker focused suite: 169 passed; protocol/Web/server typechecks passed.
- Integrated focused suite: 248 passed, 0 failed, 847 expectations.
- `bun run --cwd packages/agent-core typecheck`: passed.
- Preflight sub-agent re-audit found concrete fd/option/wrapper gaps; all reported reproducible gaps were fixed and their focused regressions pass.
- Agent-core unit lane before the final patch set: 2,802 passed; architecture lane: 105 passed. Both will be rerun from the final worktree before acceptance.
- Final-worktree Agent Core unit lane: 2,808 passed, 0 failed, 8,857 expectations.
- Final-worktree Agent Core integration lane: 137 passed, 0 failed; architecture lane through root test: 106 passed, 0 failed.
- `bun run typecheck`: 5/5 workspace tasks passed.
- `bun run test`: 8/8 Turborepo tasks passed across protocol, utils, agent-core, server, and Web (including Web interaction tests).
- `bun run build`: passed; Vite built 308 assets, manifest generation and binary build pipeline exited 0.
- `git diff --check`: passed.
- Repository legacy search is clean outside architecture absence assertions and explicit strict-rejection fixtures/loader code for legacy Bash approval records.
- Latest Bash analyzer/permission suite after the tar fix: 23 passed, 0 failed, 419 expectations.
- Latest HITL/fingerprint/schema/architecture focused suite: 53 passed, 0 failed, 209 expectations.
- Latest repository-wide `bun run typecheck`: 5/5 workspace tasks passed.
- Current independent-review checkpoint after heredoc, destination, interpreter/source, descriptor-atomicity, trailing-slash, and lexical `.archcode` fixes: analyzer + permission suite 34 passed, 0 failed, 609 expectations; Agent Core typecheck and `git diff --check` passed.
- The earlier repository-wide results above are checkpoint evidence, not final acceptance evidence; the full stack will be rerun after the Reviewer reaches PASS on the final worktree.
- Latest review-candidate focused matrix: analyzer + permission suite 50 passed, 0 failed, 794 expectations; Agent Core typecheck and `git diff --check` passed.
- Latest review-candidate repository test run: `bun run test` passed all 8/8 Turborepo tasks, including 143 Agent Core integration tests and 106 architecture tests. This remains candidate evidence until independent review reaches PASS and the final-worktree build/audit rerun completes.
- Accepted-worktree focused analyzer + permission suite: 100 passed, 0 failed.
- Independent adversarial matrix: 89 passed, 0 failed; AC-04 targeted suite: 175 passed, 0 failed; real Bash process integration: 6 passed, 0 failed.
- Independent final review reran `bun run typecheck`, `bun run test`, `bun run build`, `git diff --check`, and the legacy-symbol/file audit: all passed; Reviewer verdict: PASS.
- Primary final validation: `bunx turbo run test --force` passed 8/8 tasks with 0 cached tasks; `bun run build` passed and generated 308 assets; final `git diff --check` passed. One unrelated title-generation timing test failed on the first forced run, then passed in isolation and in the complete forced rerun; no unrelated production or test code was changed.
