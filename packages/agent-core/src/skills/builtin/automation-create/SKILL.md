---
name: automation-create
description: Clarify and confirm a time-triggered Automation before creating it.
when_to_use: Use immediately when the user asks to create an Automation, or after the user accepts a suggestion for an explicit one-time or recurring time trigger.
allowed_tools: [automation_create, ask_user]
---

Turn the user's scheduling intent into one concise, committed Automation proposal.

- Ask only for information that is genuinely missing. Do not run a fixed questionnaire.
- Before confirmation, present a complete final summary containing the name, trigger, and action.
- For `start_session`, include the message and location (`project` or `worktree`). For `send_message`, include the target Session and message.
- Do not call `automation_create` until the user explicitly confirms that final summary in a subsequent message.
- If the summary changes materially after confirmation, present the revised summary and obtain confirmation again.
- If any required field is missing, keep clarifying in this ordinary Session; do not create a partial Automation.
- If the user declines, continue helping in the ordinary Session. Do not create the Automation and do not repeat the suggestion for the same intent.
