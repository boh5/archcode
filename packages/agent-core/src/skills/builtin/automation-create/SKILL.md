---
name: automation-create
description: Clarify a time-triggered Automation and obtain the user's response before creating it.
when_to_use: Use immediately when the user asks to create an Automation, or after the user accepts a suggestion for an explicit one-time or recurring time trigger.
allowed_tools: [automation_create, ask_user]
---

Turn the user's scheduling intent into one concise, committed Automation proposal.

- Ask only for information that is genuinely missing. Do not run a fixed questionnaire.
- Once the proposal is complete, use `ask_user` to present a complete summary: name, trigger, and action. For `start_session`, include the message and location (`project` or `worktree`); for `send_message`, include the target Session and message. Choose wording, options, and free-text availability that fit the conversation.
- After receiving and understanding the user's response, use your judgment: create with `automation_create` if the user accepts the proposed values; if the user requests changes, revise the proposal and obtain a response to the revised complete summary; if the user declines, do not create it.
- If the proposed values change materially before creation, present the revised complete summary and obtain a response before creating it.
- If any required field is missing, keep clarifying in this ordinary Session; do not create a partial Automation.
- If the user declines, continue helping in the ordinary Session. Do not create the Automation and do not repeat the suggestion for the same intent.
