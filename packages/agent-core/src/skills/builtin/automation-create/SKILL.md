---
name: automation-create
description: Clarify and confirm a time-triggered Automation before creating it.
when_to_use: Use immediately when the user asks to create an Automation, or after the user accepts a suggestion for an explicit one-time or recurring time trigger.
allowed_tools: [automation_create, ask_user]
---

Turn the user's scheduling intent into one concise, committed Automation proposal.

- Ask only for information that is genuinely missing. Do not run a fixed questionnaire.
- Once the proposal is complete, call `ask_user` with one confirmation question whose text contains the complete final summary: name, trigger, and action. For `start_session`, include the message and location (`project` or `worktree`); for `send_message`, include the target Session and message. Offer exactly two options, `Create Automation` and `Revise proposal`, and set `custom` to `false`; cancellation means decline.
- The confirmation step must call only `ask_user`. Do not call `automation_create` in the same response.
- Call `automation_create` with the confirmed values only after `ask_user` returns the Create choice. If the user chooses Revise, collect the requested change, present the revised summary through a new `ask_user` confirmation, and do not create yet.
- If the confirmed values would change materially before creation, obtain a new `ask_user` confirmation first.
- If any required field is missing, keep clarifying in this ordinary Session; do not create a partial Automation.
- If the user declines, continue helping in the ordinary Session. Do not create the Automation and do not repeat the suggestion for the same intent.
