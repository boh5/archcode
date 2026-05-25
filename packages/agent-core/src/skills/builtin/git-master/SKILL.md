---
name: git-master
description: Plan and execute safe git operations with reviewable history.
when_to_use: Use for commits, rebases, branch management, blame, bisect, cherry-pick, PR preparation, and any git history operation.
---

- Inspect `git status`, `git diff`, and recent `git log` before changing history or committing.
- Keep commits atomic and focused: one logical change per commit, with a clear message matching repo style.
- Stage only intended files; never include secrets, generated artifacts, or unrelated changes.
- Prefer `git rebase` for local cleanup before push, but avoid rebasing shared branches.
- Use `git log --oneline`, `git blame`, and `git bisect` for history investigation over manual guessing.
- For PRs, verify base branch, squash or rebase strategy, and diff from base before pushing.
- When undoing changes, prefer `git stash` or `git revert` over `git reset --hard` unless you explicitly intend to discard.
- Prompt the user before force-push, branch deletion, or any operation that rewrites shared history.
- Run relevant tests or checks after branch operations to catch regressions early.
- Document risky operations briefly: what was done, which refs moved, and how to undo.