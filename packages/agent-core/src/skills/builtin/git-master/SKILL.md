---
name: git-master
description: Plan and execute safe Git operations with reviewable history when inspecting, committing, rebasing, managing branches, or preparing a pull request.
license: MIT
metadata:
  archcode/source: "Superpowers Git and worktree concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

# Git Master

Use Git as an evidence source first and a mutation tool only when the user has authorized the requested effect. Preserve unrelated work, repository conventions, and recoverability.

For operation-selection and recovery reminders, read [references/operation-safety.md](references/operation-safety.md).

## Choose the operation

Classify the request before running commands. Do not mix modes unless the task requires it.

- **Inspect:** explain working-tree, branch, upstream, or divergence state.
- **Commit:** create one or more reviewable commits from the intended changes.
- **History:** locate when, where, or why a change was introduced with log, blame, or bisect.
- **Rebase or cherry-pick:** deliberately move commits while preserving the intended patch set.
- **Branch or PR preparation:** verify the base, final diff, checks, and publication readiness.

If the requested end state is unclear, inspect first and ask before choosing a history-changing operation.

## Establish ground truth

Before any Git write:

1. Read `git_status`, the relevant unstaged and staged `git_diff`, and recent history.
2. Identify the current branch, upstream, intended base, and whether the checkout is a linked or externally managed worktree when that affects the operation.
3. Separate task changes from pre-existing or unrelated changes. Never discard, overwrite, stage, or hide someone else's work to make the tree look clean.
4. Check repository instructions and recent commit messages before choosing message style or integration strategy.

## Create commits

1. Group changes by logical responsibility, not by file type or convenience. A commit should be understandable and reversible on its own.
2. Keep inseparable code, tests, schema changes, and documentation together; split independent changes.
3. Stage explicit intended paths. Do not use broad staging when unrelated or unreviewed files are present.
4. Re-read the staged diff. Check for secrets, generated artifacts, debug output, accidental formatting churn, and missing tests.
5. Run verification proportionate to the staged change. Do not claim a commit is verified from an older run against a different tree.
6. Write a message that follows the repository's observed convention and states the change rather than the activity.
7. After committing, inspect status and report the commit identifier, subject, verification, and any intentionally uncommitted files.

Never amend an existing commit unless the user requested an amend or the current workflow explicitly authorizes it.

## Investigate history

- Use `git log` with path, symbol, author, date, or content filters to narrow the search before reading large history ranges.
- Use `git blame` to identify the introducing commit, then inspect that commit and its surrounding history; do not treat the author line alone as an explanation.
- Use `git bisect` only when there is a reproducible good/bad predicate and the range endpoints are known. Record the result and return the repository to its original state afterward.
- Distinguish evidence from inference: cite the relevant commit, patch, or line history and explain what it does and does not prove.

## Rewrite or move history

1. Confirm the exact commits, destination, ordering, and expected final graph before rebase, cherry-pick, or reset-like work.
2. Do not rebase, amend, force-push, delete a branch, or rewrite a shared or published ref without explicit user authorization.
3. Before resolving a conflict, understand both sides and preserve the combined intended behavior. Never choose ours/theirs mechanically.
4. After the operation, compare the new range with the original intent, run relevant checks, and inspect status and log.
5. If the remote moved or a push is rejected, stop and investigate. Do not use force as a retry strategy.

## Prepare a branch or PR

- Confirm the real base branch; do not assume it is `main`.
- Review the complete committed base-to-HEAD diff. Separately inspect `git_status`, both staged and unstaged `git_diff` views, and the contents of relevant untracked files; none of that uncommitted work appears in the base-to-HEAD commit range.
- Run the required checks on the exact tree being proposed.
- Push, create a PR, merge, delete branches, or clean worktrees only when the user requested that external or destructive effect.
- Preserve a worktree needed for review follow-up unless its owner explicitly authorizes cleanup.

## Stop conditions

Stop and report before acting when authorization is missing, the base or target ref is uncertain, unrelated changes overlap the operation, a conflict's intended resolution is unclear, verification fails, or the operation would make recovery materially harder than the user requested.

Finish with the resulting branch/ref state, commits created or moved, verification evidence, remaining local changes, and any action still awaiting authorization.
