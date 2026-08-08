# Delegation packet and integration gate

Use a packet when a child can produce a bounded result that the Lead can independently inspect.

```markdown
Title: <specific deliverable>
Outcome: <what the parent needs, not a vague activity>
Evidence already known: <files/symbols/links and why relevant>
Scope: <owned question or files>; explicitly excluded: <boundaries>
Constraints: <architecture, permissions, no-go decisions, user requirements>
Acceptance: <observable result and checks>
Downstream use: <decision or integration that consumes this result>
Return: <diff/evidence, checks, unresolved risks, no unsupported completion claim>
```

Give an Explore or Librarian a question and evidence target, not the conclusion to confirm. Give a Build exact change ownership and integration constraints, while reminding it that other work may coexist. Give an Analyst the governing contract and attributable surface without feeding it the desired verdict.

Do not delegate a product decision, Goal completion, final integration, or a tiny task whose explanation costs more than direct work. Do not split by arbitrary file count when files share one invariant or interface.

On return, inspect the attributable diff or evidence, resolve contradictions, integrate in dependency order, recheck callers and shared state, and run fresh checks against the combined result.

## Integration gate

- Confirm the child stayed inside scope and did not silently change the contract.
- Read changed code or primary evidence; do not integrate from the summary alone.
- Resolve overlaps against the current worktree rather than reverting another contributor.
- Recheck the produced interface at every downstream consumer.
- Run narrow checks for the contribution, then combined checks for shared boundaries.
- Keep ownership with Lead until the final report and any Goal transition are complete.
