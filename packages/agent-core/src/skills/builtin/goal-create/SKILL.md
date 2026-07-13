---
name: goal-create
description: Clarify and confirm a durable Goal before creating it.
when_to_use: Use immediately when the user asks to create a Goal, or after the user accepts a suggestion to move work into a durable Goal.
allowed_tools: [goal_create, ask_user]
---

Turn the user's request into one concise, committed Goal proposal.

- Ask only for information that is genuinely missing. Do not run a fixed questionnaire.
- Before confirmation, present a complete final summary containing the objective, acceptance criteria, and whether to use a managed worktree.
- Do not call `goal_create` until the user explicitly confirms that final summary in a subsequent message.
- If the summary changes materially after confirmation, present the revised summary and obtain confirmation again.
- If required information is missing, keep clarifying in this ordinary Session; do not create a partial Goal.
- If the user declines, continue helping in the ordinary Session. Do not create the Goal and do not repeat the suggestion for the same intent.
