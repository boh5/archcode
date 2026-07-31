---
name: plan-work
description: Research, create, or improve the one evidence-backed Markdown implementation Plan for a task or bound Project Todo.
when_to_use: Use when uncertainty, sequencing, or risk makes a durable Plan useful, or when the user asks for a plan.
---

1. Confirm the objective and inspect enough code, evidence, and constraints to make the Plan executable. Before finalizing, ask the user about every unresolved choice that affects the objective, scope, implementation, dependencies, acceptance criteria, or validation.
2. In a Todo Discussion, derive the Todo ID only from the current Session binding and use exactly `.archcode/plans/<todo-id>.md`. Do not accept a different path or Todo ID from the request.
3. Outside a Todo Discussion, use the safe direct child path under `.archcode/plans/` named by the current task unless the user explicitly requested another deliverable path.
4. Read the target file before changing it when it exists. Preserve confirmed user content and improve it; create the file only when it does not exist.
5. Write ordinary Markdown containing all seven content classes:
   - goal and background;
   - scope and non-goals;
   - ordered implementation steps;
   - dependencies and required sequence;
   - acceptance criteria;
   - validation methods;
   - risks and items requiring confirmation.
6. Make every acceptance criterion observable and decidable, and state how it will be judged. Resolve unknowns before finalizing; never use vague criteria such as "mostly complete", "handle appropriately", or "as needed".
7. Do not create Plan IDs, sidecar metadata, status, versions, approvals, locks, snapshots, services, APIs, Goal links, file watchers, or progress mirrors.
8. In a Discussion, stop after shaping the Todo and Plan; do not begin product code implementation. In an ordinary Lead Session, a Plan remains guidance rather than a new workflow state machine.
