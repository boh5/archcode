---
name: execute-plan
description: Hand an existing Project Todo Plan into an ordinary Lead Session and let the user decide whether to create a Goal before execution.
when_to_use: Use for the first message of Todo Start Work when `.archcode/plans/<todo-id>.md` already exists.
---

1. Read the Plan at the exact path supplied by the Start Work request before taking any implementation action.
2. Check that the Plan is executable: its goal, scope, ordered steps, dependencies, acceptance criteria, validation, risks, and unresolved decisions must be concrete. Ask the user to resolve any critical gap before proceeding.
3. Draft a Goal objective from the Plan's goal and observable acceptance criteria. Do not add the Plan path, content, summary, hash, version, or other Plan linkage to Goal state.
4. Use `ask_user` to explicitly ask whether to create that Goal. Do not infer consent and do not create it silently.
5. If the user agrees, call the existing `create_goal` with only the agreed objective. Continue under the existing `run-goal` protocol, including its verification and independent final Review.
6. If the user declines, continue implementing the Plan as an ordinary Lead Session without creating a Goal.
7. Treat the Plan as ordinary Markdown, not execution state. Do not add a Plan service, status, version, lock, snapshot, watcher, Goal link, or second Review flow.
8. During an active Goal, mention Plan changes only when the user explicitly says in this current Lead Session that the Plan changed or asks to change it. Then explain that the current Goal continues under its established objective and acceptance criteria unless the user separately changes the Goal. Never claim automatic Plan detection, synchronization, or restart.
