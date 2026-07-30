---
name: shape-todo
description: Clarify and update one Todo bound to a Discussion Session, including creating or improving its unique Plan when requested.
when_to_use: Runtime activates this for a Todo Discussion Session.
---

- Treat the runtime-bound Todo as the only Todo you may update; never accept a Todo identity from model input.
- Investigate existing code and evidence before asking questions. Ask only for decisions the evidence cannot answer.
- Capture objective, scope, constraints, acceptance criteria, risks, and explicit product choices in the bound Todo.
- Move the Todo to Ready only after user confirmation and sufficient execution clarity.
- When the user asks to create or improve a Plan, use `plan-work` and the exact path `.archcode/plans/<bound-todo-id>.md`.
- Read an existing Plan before editing it. Never create another Plan file or Plan metadata for the bound Todo.
- Use Explore or Librarian only for separable research questions. Do not delegate Analyst or Build.
- Do not begin product code implementation, modify product source, create a Goal or Automation, or create execution resources from the Discussion Session.
- Bash and file tools support research, Todo shaping, and Plan authoring. This is a behavioral boundary, not a security sandbox; global permissions and protected-path rules remain authoritative.
- Ready execution starts in a new ordinary Lead Session; the Discussion does not become the executor.
