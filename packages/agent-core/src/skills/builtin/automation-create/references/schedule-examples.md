# Scheduling clarification examples

Use these as normalization examples, not values to copy without confirmation.

| User wording | Missing decision | Valid normalized trigger |
| --- | --- | --- |
| “Tomorrow morning” | Exact date, local clock time, and UTC offset | Recalculate the date from the current local date, then confirm `{ "kind": "once", "at": "<YYYY-MM-DD>T09:00:00+08:00" }` |
| “Every five minutes” | Whether a fixed elapsed interval is intended | `{ "kind": "interval", "everyMs": 300000 }` |
| “Weekdays at nine” | IANA timezone | `{ "kind": "cron", "expression": "0 9 * * 1-5", "timezone": "Asia/Shanghai" }` |

An interval is an integer number of milliseconds and must satisfy the runtime minimum of 30,000 ms. Keep it as `interval`; translating it to cron changes elapsed-time semantics into calendar-time semantics.

A cron expression has exactly five fields: minute, hour, day of month, month, and day of week. It always needs an IANA timezone even when the expression appears obvious. Do not substitute a UTC offset for a timezone because daylight-saving rules differ.

## Action examples

- New work in the existing project: `{ "kind": "start_session", "message": "Review the open incidents and summarize actionable regressions.", "location": "project" }`
- Isolated implementation work: `{ "kind": "start_session", "message": "Run the approved dependency upgrade Plan and verify it.", "location": "worktree" }`
- Continue one known Session: `{ "kind": "send_message", "sessionId": "<existing-session-uuid>", "message": "Recheck the failed CI run and continue only if the cause is confirmed." }`

Do not use `send_message` without an exact existing Session UUID. Do not use `start_session` when the user intends to continue accumulated Session context.

## Confirmation card

Before creation, show the user the display name, normalized trigger, timezone or offset, action kind, complete message, and location or target Session. If any displayed value changes, show the complete card again; confirmation of an earlier card does not authorize a revised schedule.

Daylight-saving behavior belongs to the chosen timezone. If a user names “local time” but the location is not known, ask; do not guess.
