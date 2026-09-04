---
name: shape-todo
description: Clarify and update one Todo bound to a Discussion Session, including its unique Plan when requested, before implementation begins.
license: MIT
metadata:
  archcode/source: "Superpowers brainstorming concepts"
  archcode/source-commit: "44c9b2d6e889982ac18c27d05a19fefe335194e1"
  archcode/adaptation: "idea-only rewrite"
---

Use this as a bounded, evidence-led brainstorming loop for the one Todo bound to the
current Discussion Session. The goal is a decision-ready Todo and, when requested,
one executable Markdown Plan—not an implementation.

Use [references/todo-shaping-template.md](references/todo-shaping-template.md) to capture scope, decisions, and observable acceptance without turning Discussion into implementation.

### Keep the binding authoritative

- Treat the runtime-bound Todo as the only Todo that may be read or updated. Derive
  its identity from the Session binding; never accept a Todo ID, title, or path from
  model input.
- Begin with the bound Todo and the current request, then inspect the smallest
  relevant repository evidence needed to establish current behavior and constraints.
  Use `todoPlanState` rather than probing for Plan existence. Do not ask the user for
  facts available from the request, repository, Plan, or tool output; ask one focused
  question only when a material product choice remains after investigation.
- Keep the Discussion attached to that Todo throughout the conversation. Do not
  create a second Todo, a shadow status, or a parallel execution record.

### Clarify in stages

Run a short converge-and-confirm loop rather than a one-shot guess:

1. Restate the problem, intended user outcome, and the decision this Todo needs to
   support without filling gaps with an assumed preference.
2. Inspect the smallest relevant set of repository files, tests, configuration, and
   existing Plan evidence selected by authoritative runtime context. Expand the
   search only when new evidence changes the map.
3. Separate **repository facts** from **user product choices**. Facts are observed
   behavior or source evidence and should include a path, symbol, test, or command
   when useful. Choices include desired behavior, UX, compatibility, priorities,
   non-goals, and trade-offs; never present an inferred preference as a fact.
4. State remaining assumptions and risks. Ask only the next focused question that
   evidence cannot answer; when more than one solution is plausible, offer bounded
   options, explain the meaningful trade-off, and let the user choose. Do not treat a
   speculative implementation as approved.
5. Confirm the selected solution shape, scope and non-goals, dependencies, and
   observable acceptance criteria. Revisit any item that is still ambiguous before
   marking the Todo ready.

### Capture and ready gate

- Write the shaped Todo as a readable Markdown document whose first line is a
  concrete `# <Todo title>` describing this specific work. `Outcome`,
  `Evidence`, and the other template labels are section structure, never the
  Todo title. Do not leave `<Todo title>` or another placeholder in the result.
- Update the bound Todo with the agreed objective, background, scope, non-goals,
  constraints, dependencies, risks, validation approach, acceptance criteria, and
  explicit product choices. Make acceptance criteria observable and decidable.
- Move the Todo to `Ready` only after the user confirms the direction and the next
  Lead Session can execute it without guessing about scope or success. Evidence
  alone is not user approval.

### Plan handling

- When the user asks to create or improve a Plan, use `plan-work` and the exact
  runtime-provided `todoPlanPath`. Use `todoPlanState` to distinguish a present Plan
  from an absent one; never scan the workspace to discover Plan existence.
- If `todoPlanState=present`, read that exact file before editing it. If it is absent,
  create only that exact path when a Plan is requested. Never create another Plan
  file, Plan ID, sidecar metadata, or Plan service for this Todo.
- Keep the Plan as ordinary Markdown guidance. Do not claim that Plan changes are
  execution state or automatically synchronized with a Goal.

### Discussion boundaries

- Use Explore or Librarian only for separable evidence questions. Do not delegate
  Analyst or Build, and do not shift the final product decision to a child.
- Do not begin product-code implementation, modify product source, create a Goal or
  Automation, or create execution resources from this Discussion Session.
- Bash and file tools may support research, Todo shaping, and Plan authoring only.
  This is a behavioral boundary, not a security sandbox; global permissions and
  protected-path rules remain authoritative.
- Ready work starts in a new ordinary Lead Session. This Discussion never becomes
  the executor.
