---
name: plan-work
description: Research, create, or improve the one evidence-backed Markdown implementation Plan for a task or bound Project Todo.
when_to_use: Use when uncertainty, sequencing, or risk makes a durable Plan useful, or when the user asks for a plan.
---

1. First decide from the bound Todo and current request whether the intended outcome and scope are concrete enough to choose relevant evidence. If not, ask one focused clarification without inspecting the workspace, probing the Plan, or calling another tool. Once sufficient, inspect enough code, evidence, and constraints to make the Plan executable. Before finalizing, ask the user about every unresolved choice that affects the objective, scope, implementation, dependencies, acceptance criteria, or validation.
2. In a Todo Discussion, derive the Todo ID only from the current Session binding and use exactly the runtime-provided `todoPlanPath`. Use `todoPlanState` to decide whether to read the existing file or create it; never accept a different path or Todo ID from the request, and never scan the workspace to discover Plan existence.
3. Outside a Todo Discussion, use the safe direct child path under `.archcode/plans/` named by the current task unless the user explicitly requested another deliverable path.
4. In a Todo Discussion, when `todoPlanState=present`, read the exact target file before changing it; when `todoPlanState=absent`, create that exact file without probing its parent directory. Outside a Todo Discussion, retain read-before-edit for an existing target. Preserve confirmed user content and improve it; never create a second Plan.
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
