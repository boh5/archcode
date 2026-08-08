---
name: automation-create
description: Clarify a requested time-triggered Automation and obtain explicit confirmation before creation, including when a user accepts a one-time or recurring scheduling suggestion.
license: MIT
metadata:
  archcode/source: "ArchCode runtime schema"
  archcode/source-commit: "f00efe7ab3cd87f951797d9b4bf14415f10abd7a"
  archcode/adaptation: "original rewrite"
---

Turn the user's scheduling intent into one typed, complete Automation proposal, then obtain explicit human confirmation before committing it. For trigger examples and timezone ambiguities, read [references/schedule-examples.md](references/schedule-examples.md).

1. Ask only for information that is genuinely missing or ambiguous; do not run a
   fixed questionnaire. Clarify the display name and exactly one schema-supported
   trigger:
   - `once`: an exact ISO 8601 date-time with an explicit UTC offset;
   - `interval`: a recurring interval in milliseconds that meets the runtime minimum;
   - `cron`: an exact five-field cron expression plus an IANA timezone.
   Translate phrases such as “tomorrow morning”, “every weekday”, or “local time”
   into concrete values. Do not silently assume a date, timezone, daylight-saving
   behavior, or cron interpretation; surface the ambiguity and ask the smallest
   question that resolves it.
2. Clarify exactly one action and its complete payload. For `start_session`, capture
   the initial message and location (`project` or `worktree`). For `send_message`,
   capture the target existing Session ID and message. Do not invent other action
   kinds, fields, status values, origins, or scheduler behavior; the ArchCode schema
   and runtime derive the remaining Automation state.
3. Check the normalized trigger and action before asking for approval: verify the
   time and timezone are understandable, the cron has five fields and a valid IANA
   timezone, the interval is not below the supported minimum, and the action has all
   required fields. If a value changed during clarification, treat it as a new
   proposal.
4. Once complete, use `ask_user` to present a final summary for inspection. Include
   the name, the exact trigger (date/time and offset, interval, or cron plus timezone),
   and the full action. Include the `start_session` message/location or the
   `send_message` target Session/message. Choose wording, options, and free-text
   availability that fit the conversation; do not create before this confirmation.
5. Interpret the response semantically. If it accepts the displayed values, call
   `automation_create` with only the schema fields `name`, `trigger`, and `action`.
   If it requests a change, revise the proposal and present the revised complete
   summary through `ask_user` again. If it declines, do not create the Automation or
   repeat the same suggestion. A materially changed value always requires a fresh
   summary and response.
6. If any required field remains missing, keep clarifying in this ordinary Session;
   never create a partial Automation. If schema validation or creation reports an
   error, explain the concrete invalid value and revise it deliberately rather than
   silently retrying a different schedule.
