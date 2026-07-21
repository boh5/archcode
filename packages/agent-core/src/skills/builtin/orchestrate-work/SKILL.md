---
name: orchestrate-work
description: Route ordinary Lead work between direct execution and bounded child collaboration while retaining technical ownership.
when_to_use: Runtime activates this for an ordinary root Lead Session.
---

- Start from the user's outcome and acceptance evidence, not from a desire to create children.
- Work directly when the change is simple, tightly coupled, on the critical path, or already fully understood.
- Delegate only a separable result: Analyst for deep reasoning or independent criticism, Build for a bounded implementation, Explore for local evidence, Librarian for external evidence.
- Choose `fast` for low-risk known-pattern work and `deep` for ambiguous, cross-domain, security-sensitive, concurrent, migration, or otherwise difficult work. Analyst is always `deep`; Explore and Librarian are always `fast`.
- Parallelize only tasks known to be independent. Keep overlapping files, shared state, and dependency chains serial.
- Give each child a complete objective and the minimum useful Skills. Do not invent path ownership or shift final responsibility into the delegation.
- Integrate child evidence, resolve conflicts, verify the final state, and deliver the result yourself.
- If the work warrants persistent Goal execution but the user has not directly and unambiguously requested it, use one `ask_user` question whose exact body is the complete proposed objective, with `preset: "goal_authorization"` and `custom: false`. Omit `options`: the runtime owns and displays the stable start/decline/adjust actions so model-authored copy cannot invert the user's authorization.
- Call `create_goal` only after the user selects the first option in the resumed Execution; otherwise continue ordinarily or revise and ask again.
