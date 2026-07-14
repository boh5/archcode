---
name: goal-create
description: Clarify and confirm a durable Goal before creating it.
when_to_use: Use immediately when the user asks to create a Goal, or after the user accepts a suggestion to move work into a durable Goal.
allowed_tools: [goal_create, ask_user]
---

Turn the user's request into one concise, committed Goal proposal.

- Ask only for information that is genuinely missing. Do not run a fixed questionnaire.
- Once the proposal is complete, call `ask_user` with one confirmation question whose text contains the complete final summary: objective, acceptance criteria, and whether to use a managed worktree. Offer exactly two options, `Create Goal` and `Revise proposal`, and set `custom` to `false`; cancellation means decline.
- The confirmation step must call only `ask_user`. Do not call `goal_create` in the same response.
- Call `goal_create` with the confirmed values only after `ask_user` returns the Create choice. If the user chooses Revise, collect the requested change, present the revised summary through a new `ask_user` confirmation, and do not create yet.
- If the confirmed values would change materially before creation, obtain a new `ask_user` confirmation first.
- If required information is missing, keep clarifying in this ordinary Session; do not create a partial Goal.
- If the user declines, continue helping in the ordinary Session. Do not create the Goal and do not repeat the suggestion for the same intent.
