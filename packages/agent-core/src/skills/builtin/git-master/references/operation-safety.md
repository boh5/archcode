# Git operation safety card

Inspect before mutation: status, staged and unstaged diff, relevant history, current branch, upstream, intended base, and worktree context. Classify the operation as inspect, commit, history, rebase/cherry-pick, or branch/PR preparation before choosing commands.

| Operation | Required ground truth | Stop when |
| --- | --- | --- |
| Commit | intended files, staged/unstaged split, repository message rules | unrelated changes overlap or commit grouping is ambiguous |
| History investigation | exact symbol/path/question and relevant date or branch range | rename/move makes the initial path incomplete; expand deliberately |
| Rebase/cherry-pick | source commits, target/base, upstream state, dirty worktree | target history or conflict policy is not authorized |
| Branch/PR preparation | base-to-HEAD committed diff, worktree state, checks, upstream | current branch is a protected base branch; publication, push, base, or destructive cleanup was not requested |

For a commit, stage explicit intended paths, inspect the staged diff, and verify that no required new file is omitted. The staged patch—not the working-tree summary—is the proposed commit. Split only when changes have independent intent and remain buildable/reviewable; do not split coupled production and regression-test changes for appearance.

For history rewriting, first identify a recovery reference and confirm whether commits may already be shared. Preserve conflicts for inspection, resolve them from the intended combined behavior, then inspect the rewritten patch set rather than trusting command success.

For branch or PR readiness, never commit to or push directly to a protected base branch; use a focused feature branch and pull request. Review the base-to-HEAD committed diff. Separately inspect `git_status`, staged and unstaged diffs, and relevant untracked files; none of those are included in base-to-HEAD history.

## Mutation report

After a write, report the exact effect: commit IDs or branch changed, files included, verification run, remaining dirty state, and whether anything was pushed or published. A local commit is not a push, and a pushed branch is not a merged change.

Stop for a decision when the desired history, target branch, conflict behavior, commit grouping, or external publication is ambiguous. Never use cleanup or destructive history rewriting to hide another person's changes.
